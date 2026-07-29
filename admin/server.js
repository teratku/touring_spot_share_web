#!/usr/bin/env node
/**
 * server.js — スタンプラリー ローカル管理サーバ（開発者用・127.0.0.1専用）
 *
 * 役割:
 *   - public/rally-builder.html（ビルダーUI）を配信
 *   - GET  /api/spots          … アプリ保存スポット(imagedownload)を地図用に返す
 *   - GET  /api/rallies?year=  … 既存ラリー一覧
 *   - GET  /api/rally/:id      … 1ラリー取得（編集/複製用）
 *   - POST /api/rally          … 検証して stampRallies に upsert（status は書かない）
 *
 * 使い方:
 *   cd admin && npm install        # 初回（express, firebase-admin）
 *   # 認証は importRallies.js と同じ（serviceAccount.json か gcloud ADC）
 *   node server.js                 # → http://127.0.0.1:4317
 *
 * ⚠️ 本番Firestoreに読み書きします。公開サーバにはしないでください（127.0.0.1 のみ待受）。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const admin = require("firebase-admin");
const { normalizeOverride, isEmptyOverride } = require("./lib/roadOverrides");
const { execFile } = require("child_process");
const { validateRally } = require("./lib/rallyValidation");
const { ROMAJI, REGION } = require("./lib/prefectures");

const PROJECT_ID = "biketeilen";
const PORT = process.env.PORT || 4317;
const HOST = "127.0.0.1"; // ローカル専用（公開しない）

// ---- 認証（importRallies.js と同じ） ----
function initAdmin() {
  const saPath = path.join(__dirname, "serviceAccount.json");
  if (fs.existsSync(saPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(saPath)), projectId: PROJECT_ID });
    console.log("🔑 認証: serviceAccount.json");
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
    console.log("🔑 認証: applicationDefault（gcloud ADC）");
  }
}
initAdmin();
const db = admin.firestore();

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "rally-builder.html")));

// アプリ保存スポット（imagedownload）を地図用に整形して返す。
// 読取コスト削減：1週間メモリキャッシュ。?refresh=1 で createTimeTimeStamp による「新着のみ」差分取得して追記。
let spotsCache = null; // { t, spots:[], byId:Set, maxTs:Timestamp|null }
const SPOTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function mapSpot(d) {
  const x = d.data() || {};
  const lat = Number(x.lat), lng = Number(x.lng);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return {
    spotId: d.id,
    name: x.location_name || x.locality || x.administrative || "スポット",
    lat, lng,
    address: x.administrative || x.locality || null,
    imageURL: (Array.isArray(x.locationImageURLs) && x.locationImageURLs[0]) || x.iconImageURL || null,
    _ts: x.createTimeTimeStamp || null,
  };
}
function tsMs(t) { return t && typeof t.toMillis === "function" ? t.toMillis() : (typeof t === "number" ? t : 0); }
function cleanSpots(arr) {
  return arr.map((s) => ({ spotId: s.spotId, name: s.name, lat: s.lat, lng: s.lng, address: s.address, imageURL: s.imageURL }));
}
app.get("/api/spots", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    const fresh = spotsCache && Date.now() - spotsCache.t < SPOTS_TTL_MS;

    if (spotsCache && fresh && !force) {
      return res.json({ count: spotsCache.spots.length, cached: true, spots: cleanSpots(spotsCache.spots) });
    }
    if (spotsCache && force) {
      // 新着のみ：createTimeTimeStamp > 既知の最大 だけ取得して追記
      let q = db.collection("imagedownload");
      if (spotsCache.maxTs) q = q.where("createTimeTimeStamp", ">", spotsCache.maxTs);
      const snap = await q.get();
      let added = 0;
      snap.forEach((d) => {
        const s = mapSpot(d);
        if (!s || spotsCache.byId.has(s.spotId)) return;
        spotsCache.spots.push(s);
        spotsCache.byId.add(s.spotId);
        if (s._ts && tsMs(s._ts) > tsMs(spotsCache.maxTs)) spotsCache.maxTs = s._ts;
        added++;
      });
      spotsCache.t = Date.now();
      console.log(`📥 incremental read: +${added}（計 ${spotsCache.spots.length}）`);
      return res.json({ count: spotsCache.spots.length, cached: false, added, spots: cleanSpots(spotsCache.spots) });
    }
    // 初回 or TTL切れ：全件
    const limit = Math.min(parseInt(req.query.limit, 10) || 8000, 30000);
    const snap = await db.collection("imagedownload").limit(limit).get();
    const spots = []; const byId = new Set(); let maxTs = null;
    snap.forEach((d) => {
      const s = mapSpot(d);
      if (!s) return;
      spots.push(s); byId.add(s.spotId);
      if (s._ts && tsMs(s._ts) > tsMs(maxTs)) maxTs = s._ts;
    });
    spotsCache = { t: Date.now(), spots, byId, maxTs };
    console.log(`📥 full read: ${spots.length} 件（1週間キャッシュ）`);
    res.json({ count: spots.length, cached: false, spots: cleanSpots(spots) });
  } catch (e) {
    console.error("spots error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Web地名検索（OpenStreetMap Nominatim プロキシ／APIキー不要・日本限定）
// ※ Nominatim 利用規約: 適切な User-Agent・低頻度。県別コンテンツ作成の用途を想定。
app.get("/api/geocode", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    const url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=10" +
      "&accept-language=ja&countrycodes=jp&q=" + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: { "User-Agent": "biketeilen-rally-builder/1.0 (local admin tool)", "Accept-Language": "ja" },
    });
    if (!r.ok) return res.status(502).json({ error: "geocode upstream " + r.status });
    const data = await r.json();
    const results = (Array.isArray(data) ? data : [])
      .map((x) => {
        const a = x.address || {};
        const addr = [a.state || a.province, a.city || a.town || a.village || a.county].filter(Boolean).join(" ");
        return {
          name: x.name || String(x.display_name || "").split(",")[0] || q,
          address: addr || String(x.display_name || ""),
          lat: Number(x.lat),
          lng: Number(x.lon),
          kind: x.type || x.category || "",
        };
      })
      .filter((o) => isFinite(o.lat) && isFinite(o.lng));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 都道府県マスタ（ラリー情報の県プルダウン用。lib/prefectures.js が単一の出典）
// 県別データの保存先（dataset=spots は県データ／recommend はおすすめ）
function prefDataDir(dataset) {
  return path.join(__dirname, "data", dataset === "recommend" ? "prefecture-recommend" : "prefecture-spots");
}
function isDataset(d) { return d === "spots" || d === "recommend"; }
function readPrefSpots(dataset, romaji) {
  const f = path.join(prefDataDir(dataset), `${romaji}.json`);
  if (!fs.existsSync(f)) return [];
  try { return (JSON.parse(fs.readFileSync(f, "utf8")).spots) || []; } catch (_) { return []; }
}

app.get("/api/prefectures", (_req, res) => {
  const prefectures = Object.keys(ROMAJI).map((name) => {
    const romaji = ROMAJI[name];
    const sp = readPrefSpots("spots", romaji);
    const rec = readPrefSpots("recommend", romaji);
    return {
      name, romaji, region: REGION[name] || "",
      count: sp.length, manual: sp.filter((s) => s.source === "manual").length,
      recommend: rec.length,
    };
  });
  res.json({ prefectures });
});

// ========== おすすめ道路（road_recommend）==========
//
// 生成物   data/road-recommend/<romaji>.json … 配信するもの（ポリライン込み）
// 調整     data/road-overrides/<romaji>.json … 開発者の手直し。再生成しても消えない
// 重み調整 data/road-tuning/<romaji>.json    … ポリライン抜きの軽い版。順位の試算に使う
//
// 画面は public/road-builder.html（http://127.0.0.1:4317/roads）

const roadDir = (kind) => path.join(__dirname, "data", kind);

app.get("/roads", (_req, res) => res.sendFile(path.join(__dirname, "public", "road-builder.html")));

/** 県の一覧（生成済みかどうか・調整の件数つき） */
app.get("/api/roads/prefectures", (_req, res) => {
  const list = Object.keys(ROMAJI).map((name) => {
    const r = ROMAJI[name];
    const built = fs.existsSync(path.join(roadDir("road-recommend"), `${r}.json`));
    let overrides = 0;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(roadDir("road-overrides"), `${r}.json`), "utf8"));
      overrides = Object.keys(raw.overrides || {}).length;
    } catch { /* 調整はまだ無い */ }
    return { name, romaji: r, region: REGION[name] || "", built, overrides };
  });
  res.json({ prefectures: list });
});

/** 1県ぶんの区間（地図に描くのでポリラインを含む） */
app.get("/api/roads/segments/:romaji", (req, res) => {
  const file = path.join(roadDir("road-recommend"), `${req.params.romaji}.json`);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "未生成です。node buildRoadRecommend.js --build を実行してください。", segments: [] });
  }
  try { res.json(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (e) { res.status(500).json({ error: e.message, segments: [] }); }
});

/** 重み調整用。ポリラインを含まないので全県まとめて返しても軽い */
app.get("/api/roads/tuning", (_req, res) => {
  const dir = roadDir("road-tuning");
  if (!fs.existsSync(dir)) return res.json({ prefectures: [] });
  const prefectures = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try { prefectures.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); }
    catch { /* 壊れたファイルは飛ばす */ }
  }
  res.json({ prefectures });
});

/** 調整の読み書き */
app.get("/api/roads/overrides/:romaji", (req, res) => {
  const file = path.join(roadDir("road-overrides"), `${req.params.romaji}.json`);
  if (!fs.existsSync(file)) return res.json({ overrides: {} });
  try { res.json(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (e) { res.status(500).json({ error: e.message, overrides: {} }); }
});

app.put("/api/roads/overrides/:romaji", (req, res) => {
  const { romaji } = req.params;
  const incoming = (req.body && req.body.overrides) || {};
  // 空の調整はファイルに残さない（消したものが残り続けないように）
  const cleaned = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!isEmptyOverride(value)) cleaned[key] = { ...normalizeOverride(value), updatedAt: new Date().toISOString() };
  }
  const dir = roadDir("road-overrides");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${romaji}.json`),
                   JSON.stringify({ romaji, updatedAt: new Date().toISOString(), overrides: cleaned }, null, 1) + "\n");
  res.json({ ok: true, count: Object.keys(cleaned).length });
});

/**
 * 再生成 → 配信 をまとめて実行する。
 *
 * ⚠️ 本番の Firestore と Storage に書き込む。
 *    誤爆すると全ユーザーに出るので、次の3つを必ず守ること:
 *      1. 既定は下見（dryRun）。commit=true を明示したときだけ書き込む
 *      2. 1県ずつしか実行しない（--all は画面から叩けない）
 *      3. 実行の中身をそのまま画面へ返す（何が起きたか隠さない）
 *
 * 調整は生成時に当たるので、保存しただけでは配信されない。ここで必ず再生成を挟む。
 */
const PUBLISH_TIMEOUT_MS = 10 * 60 * 1000;

function run(script, args) {
  return new Promise((resolve) => {
    execFile("node", ["--max-old-space-size=8192", path.join(__dirname, script), ...args],
      { cwd: __dirname, timeout: PUBLISH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, code: error ? (error.code ?? 1) : 0, stdout, stderr: stderr || (error ? String(error) : "") });
      });
  });
}

app.post("/api/roads/publish/:romaji", async (req, res) => {
  const { romaji } = req.params;
  const commit = req.body && req.body.commit === true;
  const prefecture = Object.keys(ROMAJI).find((n) => ROMAJI[n] === romaji);
  if (!prefecture) return res.status(400).json({ error: "県が分かりません: " + romaji });

  const steps = [];
  // 1. 調整を当てて作り直す
  const built = await run("buildRoadRecommend.js", ["--build", "--prefecture", prefecture]);
  steps.push({ name: "再生成", ...built });
  if (!built.ok) return res.json({ ok: false, steps });

  // 2. 検証（--commit を付けなければ書き込まない）
  const importArgs = ["--prefecture", prefecture];
  if (commit) importArgs.push("--commit");
  const imported = await run("importRoadRecommend.js", importArgs);
  steps.push({ name: commit ? "配信" : "下見（書き込みなし）", ...imported });

  // いまの世代を返す（画面に出して確認できるように）
  let generation = null;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "road-generation.json"), "utf8"));
    generation = g[romaji] || null;
  } catch { /* まだ無い */ }

  res.json({ ok: imported.ok, commit, prefecture, generation, steps });
});

// ========== 通行規制（road_restrictions）==========
//
// 候補   data/restriction-candidates/<romaji>.json … 自動生成した下書き
// 登録   data/road-restrictions/<romaji>.json      … 開発者が確認して確定したもの（配信対象）
//
// ⚠️ 候補はそのまま配信しない。ジオコーディングの精度が場所によって大きく違い、
//    茨城で試したとき 1,300m の規制区間が 510m、別の区間が 21m になった。
//    必ず画面で地図を見て、始点・終点を直してから登録する。

app.get("/api/restrictions/candidates/:romaji", (req, res) => {
  const file = path.join(__dirname, "data", "restriction-candidates", `${req.params.romaji}.json`);
  if (!fs.existsSync(file)) {
    return res.status(404).json({
      error: "候補が未生成です。node buildRestrictionCandidates.js --prefecture <県名> を実行してください。",
      candidates: [],
    });
  }
  try { res.json(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (e) { res.status(500).json({ error: e.message, candidates: [] }); }
});

app.get("/api/restrictions/:romaji", (req, res) => {
  const file = path.join(__dirname, "data", "road-restrictions", `${req.params.romaji}.json`);
  if (!fs.existsSync(file)) return res.json({ restrictions: [] });
  try { res.json(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (e) { res.status(500).json({ error: e.message, restrictions: [] }); }
});

app.put("/api/restrictions/:romaji", (req, res) => {
  const { romaji } = req.params;
  const incoming = (req.body && req.body.restrictions) || [];
  const cleaned = [];
  for (const r of incoming) {
    if (!r || !r.id || !r.polyline || !r.name) continue;
    cleaned.push({
      id: String(r.id),
      kind: ["noMotorcycle", "noPassenger", "winterClosure", "closed"].includes(r.kind) ? r.kind : "noMotorcycle",
      name: String(r.name),
      prefecture: String(r.prefecture || ""),
      polyline: String(r.polyline),
      note: r.note ? String(r.note) : null,
      activeMonths: Array.isArray(r.activeMonths) ? r.activeMonths.filter((m) => m >= 1 && m <= 12) : null,
      minCc: Number.isFinite(r.minCc) ? r.minCc : null,
      maxCc: Number.isFinite(r.maxCc) ? r.maxCc : null,
      // いつ確認したか。規制は変わるので必ず持たせる
      checkedAt: r.checkedAt || new Date().toISOString().slice(0, 10),
      source: r.source || "admin",
    });
  }
  const dir = path.join(__dirname, "data", "road-restrictions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${romaji}.json`),
                   JSON.stringify({ romaji, updatedAt: new Date().toISOString(),
                                    count: cleaned.length, restrictions: cleaned }, null, 1) + "\n");
  res.json({ ok: true, count: cleaned.length });
});

/**
 * 規制を新規に追加するための道路検索。
 *
 * ⚠️ 二普協の一覧に無い規制もある（冬季閉鎖は道路管理者の情報で二普協には載らない、
 *    ユーザー報告から起こすもの、住所しか書かれておらず候補を作れなかったもの）。
 *    道路名から引いて地図で区間を切れるようにしておく。
 *
 * 索引は data/road-index/<romaji>.json（buildRoadIndex.js で作る）。
 * 1県 0.2MB 程度だが、まるごとブラウザへ送らず名前で絞って返す。
 */
const roadIndexCache = new Map();

function loadRoadIndex(romaji) {
  if (roadIndexCache.has(romaji)) return roadIndexCache.get(romaji);
  const file = path.join(__dirname, "data", "road-index", `${romaji}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    roadIndexCache.set(romaji, data);
    return data;
  } catch { return null; }
}

app.get("/api/restrictions/roads/:romaji", (req, res) => {
  const index = loadRoadIndex(req.params.romaji);
  if (!index) {
    return res.status(404).json({
      error: "道路の索引が未生成です。node buildRoadIndex.js --prefecture <県名> を実行してください。",
      roads: [],
    });
  }
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ prefecture: index.prefecture, roads: [] });
  // 部分一致。長い道から出す（幹線を先に見せたい）
  const roads = index.roads
    .filter((r) => r.name.includes(q))
    .slice(0, 40)
    .map((r) => ({ name: r.name, highway: r.highway, lengthMeters: r.lengthMeters, polyline: r.polyline }));
  res.json({ prefecture: index.prefecture, roads, total: roads.length });
});

/** いま使っている重みと正規化の基準（画面の初期値に使う） */
app.get("/api/roads/weights", (_req, res) => {
  const { WEIGHTS, NORMALIZERS, CLASS_RANK } = require("./lib/funSegments");
  res.json({ weights: WEIGHTS, normalizers: NORMALIZERS, classRank: CLASS_RANK });
});

// 汎用：県別データ取得（dataset=spots|recommend）
app.get("/api/prefecture-data/:dataset/:romaji", (req, res) => {
  const { dataset, romaji } = req.params;
  if (!isDataset(dataset)) return res.status(400).json({ error: "unknown dataset: " + dataset, spots: [] });
  const file = path.join(prefDataDir(dataset), `${romaji}.json`);
  if (!fs.existsSync(file)) {
    const how = dataset === "recommend" ? "node savePrefectureRecommend.js" : "node savePrefectureData.js";
    return res.status(404).json({ error: `未生成です。admin で ${how} を実行してください。`, spots: [] });
  }
  try { res.json(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (e) { res.status(500).json({ error: e.message, spots: [] }); }
});

// 県別に保存したスポットデータ（savePrefectureData.js が生成）を返す（互換: dataset=spots）
app.get("/api/prefecture-spots/:romaji", (req, res) => {
  const file = path.join(__dirname, "data", "prefecture-spots", `${req.params.romaji}.json`);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "未生成です。admin で node savePrefectureData.js を実行してください。", spots: [] });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    res.status(500).json({ error: e.message, spots: [] });
  }
});

// 県別データに追加（dataset=spots|recommend）。重複除外、追加分は source:manual。
function addPrefData(dataset, romaji, body, res) {
  const pref = Object.keys(ROMAJI).find((p) => ROMAJI[p] === romaji);
  if (!pref) return res.status(400).json({ error: "未知の都道府県: " + romaji });
  const incoming = Array.isArray(body && body.spots) ? body.spots : [];
  if (!incoming.length) return res.status(400).json({ error: "spots が空です" });

  const dir = prefDataDir(dataset);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${romaji}.json`);
  let doc = { prefecture: pref, romaji, spots: [] };
  if (fs.existsSync(file)) { try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {} }
  const spots = Array.isArray(doc.spots) ? doc.spots : [];

  const keyOf = (s) =>
    s.spotId ? "id:" + s.spotId : "g:" + Number(s.lat).toFixed(4) + "," + Number(s.lng).toFixed(4) + ":" + (s.name || "");
  const have = new Set(spots.map(keyOf));
  let added = 0;
  for (const s of incoming) {
    const lat = Number(s.lat), lng = Number(s.lng);
    if (!isFinite(lat) || !isFinite(lng) || !s.name) continue;
    const norm = { spotId: s.spotId || null, name: String(s.name), lat, lng, address: s.address || null, imageURL: s.imageURL || null, source: "manual" };
    const k = keyOf(norm);
    if (have.has(k)) continue;
    have.add(k);
    spots.push(norm);
    added++;
  }
  spots.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
  fs.writeFileSync(file, JSON.stringify({ prefecture: pref, romaji, count: spots.length, total: spots.length, spots }, null, 2) + "\n");
  res.json({ ok: true, prefecture: pref, added, count: spots.length });
}

// 県別データを丸ごと置換（編集・削除）。source は維持（既定: recommend=curated / spots=app）。
function replacePrefData(dataset, romaji, body, res) {
  const pref = Object.keys(ROMAJI).find((p) => ROMAJI[p] === romaji);
  if (!pref) return res.status(400).json({ error: "未知の都道府県: " + romaji });
  const incoming = Array.isArray(body && body.spots) ? body.spots : null;
  if (!incoming) return res.status(400).json({ error: "spots 配列が必要です" });
  const baseSource = dataset === "recommend" ? "curated" : "app";

  const spots = [];
  for (const s of incoming) {
    const lat = Number(s.lat), lng = Number(s.lng);
    if (!isFinite(lat) || !isFinite(lng) || !s.name) continue;
    spots.push({
      spotId: s.spotId || null,
      name: String(s.name),
      lat, lng,
      address: s.address || null,
      imageURL: s.imageURL || null,
      source: s.source === "manual" ? "manual" : baseSource,
    });
  }
  spots.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
  const dir = prefDataDir(dataset);
  fs.mkdirSync(dir, { recursive: true });
  const manualCount = spots.filter((s) => s.source === "manual").length;
  fs.writeFileSync(
    path.join(dir, `${romaji}.json`),
    JSON.stringify({ prefecture: pref, romaji, count: spots.length, curatedCount: spots.length - manualCount, manualCount, spots }, null, 2) + "\n"
  );
  res.json({ ok: true, prefecture: pref, count: spots.length });
}

// 汎用ルート（dataset=spots|recommend）＋ 互換エイリアス（spots）
app.post("/api/prefecture-data/:dataset/:romaji", (req, res) => {
  if (!isDataset(req.params.dataset)) return res.status(400).json({ error: "unknown dataset: " + req.params.dataset });
  addPrefData(req.params.dataset, req.params.romaji, req.body, res);
});
app.put("/api/prefecture-data/:dataset/:romaji", (req, res) => {
  if (!isDataset(req.params.dataset)) return res.status(400).json({ error: "unknown dataset: " + req.params.dataset });
  replacePrefData(req.params.dataset, req.params.romaji, req.body, res);
});
app.post("/api/prefecture-spots/:romaji", (req, res) => addPrefData("spots", req.params.romaji, req.body, res));
app.put("/api/prefecture-spots/:romaji", (req, res) => replacePrefData("spots", req.params.romaji, req.body, res));

// 既存ラリー一覧（任意で年度フィルタ）
app.get("/api/rallies", async (req, res) => {
  try {
    let q = db.collection("stampRallies");
    if (req.query.year) q = q.where("fiscalYear", "==", Number(req.query.year));
    const snap = await q.get();
    const rallies = snap.docs
      .map((d) => {
        const x = d.data() || {};
        return {
          id: d.id,
          name: x.name || "",
          theme: x.theme || "",
          region: x.region || "",
          fiscalYear: x.fiscalYear,
          status: x.status || "active",
          targetCount: (x.targets || []).length,
        };
      })
      .sort((a, b) => b.fiscalYear - a.fiscalYear || a.id.localeCompare(b.id));
    res.json({ rallies });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 1ラリー取得（編集/複製用）。Timestamp は ISO 文字列で返す。
app.get("/api/rally/:id", async (req, res) => {
  try {
    const doc = await db.collection("stampRallies").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });
    const x = doc.data() || {};
    const toISO = (t) => (t && typeof t.toDate === "function" ? t.toDate().toISOString() : t || null);
    res.json({
      rally: {
        rallyId: doc.id,
        name: x.name,
        theme: x.theme,
        region: x.region || "",
        description: x.description || "",
        coverImageURL: x.coverImageURL || "",
        fiscalYear: x.fiscalYear,
        startAt: toISO(x.startAt),
        endAt: toISO(x.endAt),
        activeMonths: Array.isArray(x.activeMonths) ? x.activeMonths : [],
        rewardBadgeId: x.rewardBadgeId || "",
        completionTitle: x.completionTitle || "",
        status: x.status || "active",
        category: x.category || "standard",
        prefecture: x.prefecture || "",
        targets: x.targets || [],
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 検証して upsert（status は書かない＝運営状態は setRallyStatus.js 管理）
app.post("/api/rally", async (req, res) => {
  try {
    const json = req.body || {};
    const { rallyId, doc, targetCount } = validateRally(json, "builder", json.fiscalYear, admin);
    await db.collection("stampRallies").doc(rallyId).set(doc, { merge: true });
    console.log(`⬆️  upsert stampRallies/${rallyId}（targets ${targetCount}）`);
    res.json({ ok: true, rallyId, targetCount });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ラリーの状態変更（active/paused/ended/archived）。setRallyStatus.js と同等。
app.post("/api/rally/:id/status", async (req, res) => {
  const ALLOWED = ["active", "paused", "ended", "archived"];
  const status = (req.body && req.body.status) || "";
  if (!ALLOWED.includes(status)) return res.status(400).json({ ok: false, error: "status は " + ALLOWED.join("/") + " のいずれか" });
  try {
    const ref = db.collection("stampRallies").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "not found" });
    const update = { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (status === "ended" && req.body && req.body.endNow) update.endAt = admin.firestore.Timestamp.fromDate(new Date());
    await ref.set(update, { merge: true });
    console.log(`🚦 status stampRallies/${req.params.id} → ${status}`);
    res.json({ ok: true, id: req.params.id, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ラリーの物理削除（完全削除）。通常はアーカイブ(status=archived)推奨。
// 注: 獲得スタンプ(users/{uid}/stamps)は別コレクションのため残る（履歴名は解決不可になる）。
app.delete("/api/rally/:id", async (req, res) => {
  try {
    const ref = db.collection("stampRallies").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "not found" });
    await ref.delete();
    console.log(`🗑  delete stampRallies/${req.params.id}`);
    res.json({ ok: true, id: req.params.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ビルダーの「🎨カバー生成」から生成画像を public/images/rallies/{rallyId}.jpg に書き出す（ローカル専用）。
// 規約: coverImageURL = https://biketeilen.web.app/images/rallies/{rallyId}.jpg
app.post("/api/rally-cover/:rallyId", (req, res) => {
  try {
    const rallyId = String(req.params.rallyId || "");
    if (!/^[a-z0-9-]+$/i.test(rallyId)) return res.status(400).json({ error: "invalid rallyId" });
    const m = String((req.body && req.body.dataUrl) || "").match(/^data:image\/(?:jpeg|png);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: "invalid image data" });
    const dir = path.join(__dirname, "..", "public", "images", "rallies");
    fs.mkdirSync(dir, { recursive: true });
    const rel = `/images/rallies/${rallyId}.jpg`;
    fs.writeFileSync(path.join(dir, `${rallyId}.jpg`), Buffer.from(m[1], "base64"));
    console.log(`🖼  rally cover saved: public${rel}`);
    res.json({ ok: true, path: rel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 開発者用：ユーザーの購読状態を確認（admin SDK で読取。user_stats/{uid}.subscription は iOS が保存）。
app.get("/api/user/:uid", async (req, res) => {
  const uid = String(req.params.uid || "").trim();
  if (!uid) return res.status(400).json({ error: "uid が必要です" });
  try {
    const [infoSnap, subSnap] = await Promise.all([
      db.collection("userInfo").doc(uid).get(),
      db.collection("subscriptions").doc(uid).get(),
    ]);
    if (!infoSnap.exists && !subSnap.exists) {
      return res.status(404).json({ error: "ユーザーが見つかりません", uid });
    }
    const info = infoSnap.data() || {};
    const sub = subSnap.exists ? subSnap.data() : null;
    const toISO = (t) => (t && typeof t.toDate === "function" ? t.toDate().toISOString() : t || null);
    res.json({
      uid,
      userName: info.userName || null,
      userIcon: info.userIcon || null,
      subscription: sub
        ? {
            tier: sub.tier || "free",
            isSubscribed: sub.isSubscribed === true,
            productID: sub.productID || null,
            platform: sub.platform || null,
            expiration: toISO(sub.expiration),
            updatedAt: toISO(sub.updatedAt),
            referralBonusExpiresAt: toISO(sub.referralBonusExpiresAt),
            referralBonusGrantedCount: sub.referralBonusGrantedCount || 0,
          }
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 開発者用：紹介報酬の月次カウンタを確認（サポート/デバッグ用、読み取り専用）。
app.get("/api/referrals/:uid", async (req, res) => {
  const uid = String(req.params.uid || "").trim();
  if (!uid) return res.status(400).json({ error: "uid が必要です" });
  try {
    const ledgerSnap = await db.collection("referralRewards").doc(uid).get();
    if (!ledgerSnap.exists) {
      return res.json({ uid, monthKey: null, rewardsThisMonth: 0, totalRewardsGranted: 0 });
    }
    const d = ledgerSnap.data();
    const toISO = (t) => (t && typeof t.toDate === "function" ? t.toDate().toISOString() : t || null);
    res.json({
      uid,
      monthKey: d.monthKey || null,
      rewardsThisMonth: d.rewardsThisMonth || 0,
      totalRewardsGranted: d.totalRewardsGranted || 0,
      updatedAt: toISO(d.updatedAt),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`🛠  スタンプラリー ビルダー: http://${HOST}:${PORT}`);
  console.log("   ローカル専用。Firestore 認証は importRallies.js と同じ（serviceAccount.json / ADC）。");
});
