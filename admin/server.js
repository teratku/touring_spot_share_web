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
const { HTML_PLACEHOLDERS } = require("./lib/mapsKey");
const admin = require("firebase-admin");
const { normalizeOverride, isEmptyOverride,
        normalizeAdded, isValidAdded, reshape } = require("./lib/roadOverrides");
const { execFile } = require("child_process");
const { validateRally } = require("./lib/rallyValidation");
const { ROMAJI, REGION } = require("./lib/prefectures");
const { roadsAtPoint, GRID_DIR } = require("./lib/roadsAtPoint");
const { routeBetween } = require("./lib/roadRoute");
const { routeWithValhalla, BASE: VALHALLA_URL } = require("./lib/valhallaRoute");
const { buildSideVariants, selectFunRoads } = require("./lib/funRouteSelect");
const { toGpx, toSimctl } = require("./lib/gpx");
const { segmentsBetween } = require("./lib/roadRecommendIndex");
const { dropBacktrackingRoads, blame } = require("./lib/funRouteRefine");
const { simulate } = require("./lib/navSimulate");
const { spokenRoadName } = require("./lib/navName");
const { ATTRIBUTION, normalizeOrigin, isSellable } = require("./lib/restrictionOrigin");
const { toAppManeuver } = require("./lib/navManeuver");
const { ROMAJI: PREF_ROMAJI } = require("./lib/prefectureRomaji");
const { PrefectureLocator } = require("./lib/prefectureLocator");
const restrictionLocator = new PrefectureLocator();
const { normalized: normalizedAnnounce } = require("./lib/navGuide");
const { normalizeHours, normalizeDays } = require("./lib/restrictionTime");
const { findOverlaps } = require("./lib/restrictionOverlap");
const { midFrom, kmlUrl, parseKml } = require("./lib/myMapsKml");
const { decode: decodePolylineServer, encode: encodePolyline } = require("./lib/polyline");

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

/**
 * HTML を返すときに、Google Maps のキーを差し込む。
 *
 * ⚠️ **`express.static` より前に置くこと。** 後ろに置くと static が先に素の HTML を返し、
 *    目印（`__GOOGLE_MAPS_API_KEY__`）がそのまま画面に出て地図が動かない。
 * ⚠️ キーの実体は `lib/mapsKey.js` にしかない。HTML に直書きしないこと
 *    （直書きすると、キーを差し替えてもそこだけ古いまま残る）。
 */
function sendHtml(res, file) {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, "public", file), "utf8"); }
  catch (e) { return res.status(404).send("見つかりません: " + file); }
  for (const [placeholder, value] of Object.entries(HTML_PLACEHOLDERS)) {
    html = html.split(placeholder).join(value);
  }
  res.type("html").send(html);
}

// ⚠️ .html への直アクセスもここで受ける。static に任せると差し込みが効かない
app.get(/^\/[\w-]+\.html$/, (req, res) => sendHtml(res, path.basename(req.path)));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => sendHtml(res, "rally-builder.html"));

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

app.get("/roads", (_req, res) => sendHtml(res, "road-builder.html"));
app.get("/valhalla", (_req, res) => sendHtml(res, "valhalla.html"));

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

/**
 * アプリの評価ツール（開発者用）で付けた評価を返す。
 *
 * ⚠️ 書き込みはしない。ここは**アプリが貯めた生の評価を読むだけ**で、
 *    調整として採用するかどうかは画面で人が決める（`road_reviews` を
 *    自動で調整に流し込むと、試しに付けた評価がそのまま配信されてしまう）。
 *
 * ⚠️ ドキュメントIDは**アプリの道路まとめキー**そのもの。
 *      ref がある: `r:埼玉県|361|secondary`
 *      ref が無い: `n:埼玉県|白鳥通り|primary`
 *    `/` だけ `_` に置き換わっている（Firestore が ID に `/` を許さないため）。
 *    生成データの区間は県ごとの連番ID（`埼玉県:0`）で別物なので、
 *    画面側で ref・name・highway から同じキーを組み立てて突き合わせる。
 *
 * 読み取り回数を抑えるため1時間メモリにためる。?refresh=1 で取り直す。
 */
let reviewsCache = null; // { t, reviews }
const REVIEWS_TTL_MS = 60 * 60 * 1000;

app.get("/api/roads/reviews", async (req, res) => {
  const fresh = req.query.refresh === "1";
  if (!fresh && reviewsCache && Date.now() - reviewsCache.t < REVIEWS_TTL_MS) {
    return res.json({ reviews: reviewsCache.reviews, cached: true });
  }
  try {
    const snap = await db.collection("road_reviews").get();
    const reviews = {};
    snap.forEach((doc) => {
      const d = doc.data() || {};
      reviews[doc.id] = {
        verdict: d.verdict || "",
        title: d.title || "",
        note: d.note || "",
        tags: Array.isArray(d.tags) ? d.tags : [],
        roadName: d.roadName || "",
        ref: d.ref || "",
        highway: d.highway || "",
        lengthKm: typeof d.lengthKm === "number" ? d.lengthKm : null,
        curviness: typeof d.curviness === "number" ? d.curviness : null,
        reviewedAt: d.reviewedAt && d.reviewedAt.toDate ? d.reviewedAt.toDate().toISOString() : null,
      };
    });
    reviewsCache = { t: Date.now(), reviews };
    res.json({ reviews, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message, reviews: {} });
  }
});

/**
 * 通行規制と重なっているおすすめ道路を返す。
 *
 * ⚠️ 生成もアプリも規制を見ていないので、**二輪通行禁止の道がおすすめとして
 *    配信され得る**。走れない道へ案内することになるので、配信の前に気付けるようにする。
 *
 * ⚠️ ここは知らせるだけ。実際に外すかどうかは画面で人が決める
 *    （規制が道の一部にしか掛かっていないこともあり、機械的に消すと行き過ぎる）。
 */
app.get("/api/roads/restricted/:romaji", (req, res) => {
  const { romaji } = req.params;
  const recFile = path.join(roadDir("road-recommend"), `${romaji}.json`);
  const resFile = path.join(__dirname, "data", "road-restrictions", `${romaji}.json`);
  if (!fs.existsSync(recFile) || !fs.existsSync(resFile)) return res.json({ overlaps: {}, count: 0 });
  try {
    const rec = JSON.parse(fs.readFileSync(recFile, "utf8"));
    const rest = JSON.parse(fs.readFileSync(resFile, "utf8"));
    const restrictions = (rest.restrictions || []).map((r) => ({
      id: r.id, name: r.name, kind: r.kind, points: decodePolylineServer(r.polyline),
    }));
    const roads = (rec.segments || []).map((seg) => ({
      id: seg.id, name: seg.name, points: decodePolylineServer(seg.polyline),
    }));
    const found = findOverlaps(restrictions, roads);
    res.json({ overlaps: Object.fromEntries(found), count: found.size });
  } catch (e) {
    res.status(500).json({ error: e.message, overlaps: {} });
  }
});

/** 調整の読み書き */
app.get("/api/roads/overrides/:romaji", (req, res) => {
  const file = path.join(roadDir("road-overrides"), `${req.params.romaji}.json`);
  // ⚠️ `added`（手で足した道）も必ず返すこと。返し忘れると画面が空で読み込み、
  //    そのまま保存したときに**足した道が消える**
  if (!fs.existsSync(file)) return res.json({ overrides: {}, added: {} });
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    res.json({ ...raw, overrides: raw.overrides || {}, added: raw.added || {} });
  } catch (e) { res.status(500).json({ error: e.message, overrides: {}, added: {} }); }
});

/**
 * 手で直した形・足した道を、**生成と同じ式で測り直す**。
 *
 * ⚠️ **ブラウザ側で計算を書かないこと。** 点数の式は `lib/funSegments.js` にあり、
 *    重みの調整でも動く。画面に写しを置くと、いずれ本物と食い違い、
 *    「ツールでは62点、配信は48点」という状態になる。
 * ⚠️ 形を直したのに距離・曲率・点数が元のままだと、
 *    「直したのに変わらない」ように見える（実機で報告）。ここで測って画面に返す。
 */
app.post("/api/roads/measure", (req, res) => {
  const items = (req.body && req.body.items) || [];
  const results = {};
  for (const item of items) {
    if (!item || !item.key || !item.shape) continue;
    const built = reshape({ name: "x", highway: item.highway || "secondary" }, item.shape);
    // reshape は壊れた線だと元をそのまま返す。測れていないものは返さない
    if (!built.reshaped) continue;
    results[item.key] = {
      lengthKm: built.lengthKm, curviness: built.curviness, flow: built.flow,
      turnCount: built.turnCount, score: built.score,
    };
  }
  res.json({ results });
});

app.put("/api/roads/overrides/:romaji", (req, res) => {
  const { romaji } = req.params;
  const incoming = (req.body && req.body.overrides) || {};
  // 空の調整はファイルに残さない（消したものが残り続けないように）
  const cleaned = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!isEmptyOverride(value)) cleaned[key] = { ...normalizeOverride(value), updatedAt: new Date().toISOString() };
  }
  // 手で足した道。名前と形が揃っているものだけ残す
  // ⚠️ 中途半端なものを保存しないこと。生成のときに黙って落ちて、
  //    「保存したのに配信に出ない」ことになる（`isValidAdded`）。
  const addedIn = (req.body && req.body.added) || {};
  const addedOut = {};
  const rejected = [];
  for (const [key, value] of Object.entries(addedIn)) {
    if (!isValidAdded(value)) { rejected.push(key); continue; }
    addedOut[key] = { ...normalizeAdded(value), updatedAt: new Date().toISOString() };
  }

  const dir = roadDir("road-overrides");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${romaji}.json`),
                   JSON.stringify({ romaji, updatedAt: new Date().toISOString(),
                                    overrides: cleaned, added: addedOut }, null, 1) + "\n");
  res.json({ ok: true, count: Object.keys(cleaned).length,
             addedCount: Object.keys(addedOut).length, rejected });
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
// 候補   data/restriction-candidates/<romaji>.json … 二普協の一覧から作った下書き
//        data/restriction-osm/<romaji>.json        … OSM のタグから拾った下書き
// 登録   data/road-restrictions/<romaji>.json      … 開発者が確認して確定したもの（配信対象）
//
// ⚠️ 候補はそのまま配信しない。ジオコーディングの精度が場所によって大きく違い、
//    茨城で試したとき 1,300m の規制区間が 510m、別の区間が 21m になった。
//    必ず画面で地図を見て、始点・終点を直してから登録する。
//
// ⚠️ **候補を1つのファイルにまとめないこと。** 作っているスクリプトが別（
//    `buildRestrictionCandidates.js` と `fetchOsmRestrictions.js`）で、
//    どちらも県ぶんを丸ごと書き直す。同じファイルにすると互いを消し合う。
//    それぞれが自分のファイルだけを書き、読むときにここで合わせる。

function readCandidateFile(dir, romaji) {
  const file = path.join(__dirname, "data", dir, `${romaji}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { error: `${dir}/${romaji}.json を読めません: ${e.message}`, candidates: [] }; }
}

app.get("/api/restrictions/candidates/:romaji", (req, res) => {
  const { romaji } = req.params;
  const jmpsa = readCandidateFile("restriction-candidates", romaji);
  const osm = readCandidateFile("restriction-osm", romaji);
  // ⚠️ **JARTIC は公安委員会の規制そのもの。** 曜日・時間が入っているのはここだけ
  //    （OSM の日本データに曜日は0件・二普協の一覧にも無い）
  const jartic = readCandidateFile("restriction-jartic", romaji);

  // ⚠️ 1つしか無くても 404 にしないこと。OSM 側だけがある県（石川・新潟・大阪など）で
  //    「候補が未生成です」と出て、拾えているはずの規制が見えなくなる
  if (!jmpsa && !osm && !jartic) {
    return res.status(404).json({
      error: "候補が未生成です。node fetchJarticRestrictions.js --prefecture <県名>"
           + "（または fetchOsmRestrictions.js / buildRestrictionCandidates.js）を実行してください。",
      candidates: [],
    });
  }

  const errors = [jmpsa, osm, jartic].filter((d) => d && d.error).map((d) => d.error);
  res.json({
    prefecture: (jartic && jartic.prefecture) || (jmpsa && jmpsa.prefecture)
      || (osm && osm.prefecture) || "",
    romaji,
    // ⚠️ **JARTIC を先頭に。** 出どころが公安委員会で、曜日・時間まで入っている。
    //    次が OSM（区間が道なりに繋がっていて確かめやすい）、最後が二普協
    candidates: [...((jartic && jartic.candidates) || []),
                 ...((osm && osm.candidates) || []),
                 ...((jmpsa && jmpsa.candidates) || [])],
    sourceUrl: jmpsa && jmpsa.sourceUrl,
    sourceFetchedAt: jmpsa && jmpsa.sourceFetchedAt,
    osmBuiltAt: osm && osm.builtAt,
    osmAttribution: osm && osm.attribution,
    // ⚠️ **出典は必ず一緒に返すこと。** JARTIC の規約が求めている
    jarticAttribution: jartic && jartic.attribution,
    jarticTargetMonth: jartic && jartic.targetMonth,
    jarticFetchedAt: jartic && jartic.fetchedAt,
    error: errors.length ? errors.join(" / ") : undefined,
  });
});

/**
 * 始点と終点を渡して、そのあいだを道でつないだ線を返す。
 *
 * 規制は「◯◯橋から△△トンネルまで」と両端で決まっていることが多い。
 * 1本の道を選んでドラッグする方式では、複数の道路にまたがる規制を表せない。
 *
 * ⚠️ 車の経路探索ではない。一方通行も進入禁止も見ていない。
 *    規制区間の形を作るための「道でつながった線」。
 */
app.get("/api/restrictions/route", async (req, res) => {
  const nums = ["fromLat", "fromLng", "toLat", "toLng"].map((k) => Number(req.query[k]));
  if (nums.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: "fromLat/fromLng/toLat/toLng が要ります" });
  }
  if (!fs.existsSync(GRID_DIR)) {
    return res.status(404).json({ error: `道路CSVが見つかりません: ${GRID_DIR}` });
  }
  try {
    const [fromLat, fromLng, toLat, toLng] = nums;
    res.json(await routeBetween([fromLng, fromLat], [toLng, toLat]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Valhalla に経路を頼む（ローカル確認用）。
 *
 * 自前探索（`/api/restrictions/route`）との違いは、**曲がる指示が付くこと**と
 * **一方通行を見ていること**。画面は /valhalla。
 *
 * ⚠️ Valhalla が立っていなくても、ここが 502 を返すだけで済むこと。
 *    他の画面を巻き込まないよう、起動時に繋ぎに行ったりしない。
 */
/**
 * その両端が掛かる県の、登録済みの通行規制を集める。
 *
 * ⚠️ **経路を引くときに渡すもの。** おすすめ道路の一覧づくり
 *    （`buildRoadRecommend.js`）とは判断が違う。あちらは時刻を持たないので
 *    「全員が・いつでも通れない」ものだけ落とす。こちらは走る時刻が分かるので、
 *    その時刻に効いている規制を避ける。
 * ⚠️ **JARTIC の候補は入れない。** あれは未確認の下書き。
 *    road-builder で確認して `road-restrictions` に入ったものだけを使う。
 */
/**
 * 県ぶんの登録済み規制を読む。
 *
 * ⚠️ **県は経路が通るところを渡すこと**（`routeWithValhalla` が `restrictionsFor` で
 *    引いた後に決める）。**両端の県だけでは足りない。** 実測: 東京→大阪の両端は
 *    [東京都, 大阪府] だが、実際に通るのは8県で **6県ぶんの規制を見落とす**。
 *    ⚠️ 東京→箱根・名古屋→伊勢では0件なので、**短い区間で試すと気づけない。**
 *
 * ⚠️ **JARTIC の候補は使わない。** あれは未確認の下書き。区間の切れ目が
 *    道の単位と違うので、避けると走れる道を回り込ませる。
 *    road-builder で確認して `road-restrictions` に入ったものだけ。
 */
/**
 * @param {object} [opts] `sellableOnly` … 販売APIで使う。
 *   `includeUnverified` … **JARTIC の未確認候補も混ぜる**（1,442件・47県）。
 *
 * ⚠️ **既定では混ぜない。** 候補は区間の切れ目が交通規制の単位で決まっていて、
 *    アプリで見せたい「道」の単位とは限らない。行き過ぎて避けると走れる道を回り込ませる。
 * ⚠️ ただし**登録があるのは25県だけ**で、候補はあるのに登録0件の県が14ある
 *    （富山98・福岡21・広島21・岡山12 など）。そこでは規制を避けずに経路が引かれる。
 *    実測（候補を跨ぐ26区間・原付）: 混ぜると合計距離 +14.5%、10/26本で経路が変わり、
 *    **上限超過で塞げなかったものは0件**（当たったものだけ塞ぐ設計なので予算は問題にならない）。
 * ⚠️ **販売APIには混ぜない。** あちらは Firestore の `road_restrictions` だけを読む
 *    （候補はそこに無い）。混ぜるのは開発者用ツールとアプリの検討まで。
 *   ⚠️ **商用利用が許されている出どころだけに絞る**（`SELLABLE_ORIGINS`）。
 *      いまある279件は由来の記録が無いので**1件も残らない**。
 *      販売に載せるには JARTIC の候補から作り直すこと。
 */
function restrictionsForPrefectures(routePoints, opts = {}) {
  // ⚠️ **経路の線が通る県を全部拾うこと。** 両端だけでは足りない（上の説明）。
  //    ⚠️ 全点を調べると長距離で重い。間引いて見る（1県は最小でも十数km分の点を持つ）
  const step = Math.max(1, Math.floor((routePoints || []).length / 400));
  const prefectures = [];
  const seenPref = new Set();
  for (let i = 0; i < (routePoints || []).length; i += step) {
    const p = routePoints[i];
    let name = null;
    try { name = restrictionLocator.locate(p[0], p[1]); } catch (e) { name = null; }
    if (name && !seenPref.has(name)) { seenPref.add(name); prefectures.push(name); }
  }

  const out = [];
  const seen = new Set();
  for (const pref of prefectures) {
    const romaji = PREF_ROMAJI[pref];
    if (!romaji || seen.has(romaji)) continue;
    seen.add(romaji);
    const file = path.join(__dirname, "data", "road-restrictions", `${romaji}.json`);
    // ⚠️ **登録が無くても抜けないこと。** ここで `continue` すると、
    //    **登録0件の14県（富山・福岡・広島・岡山…）が候補を読む前に素通りする**——
    //    未確認を混ぜる機能が、いちばん要る県で効かなくなる（実際にそうなっていた）
    if (fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, "utf8"));
        // ⚠️ 登録済みは確認済み。印を付けて、未確認と混ざっても見分けられるようにする
        out.push(...(d.restrictions || []).map((r) => ({ ...r, verified: true })));
      } catch (e) { /* 壊れた県は飛ばす。他の県の規制は活かす */ }
    }

    if (!opts.includeUnverified) continue;
    const candFile = path.join(__dirname, "data", "restriction-jartic", `${romaji}.json`);
    if (!fs.existsSync(candFile)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(candFile, "utf8"));
      // ⚠️ **すでに登録済みのものと二重に数えない。** 作り直しで昇格した候補は
      //    `road-restrictions` 側に同じ id で入っている
      const known = new Set(out.map((r) => r.id));
      for (const c of d.candidates || []) {
        if (!c || known.has(c.id)) continue;
        if (!Array.isArray(c.points) || c.points.length < 2) continue;
        out.push({ ...c, verified: false });
      }
    } catch (e) { /* 壊れた県は飛ばす */ }
  }
  // ⚠️ 販売APIでは、商用利用が許されている出どころだけ（`lib/restrictionOrigin.js`）
  const usable = opts.sellableOnly ? out.filter(isSellable) : out;
  // ⚠️ どの県を見たかも返す。見落としが起きていないか確かめるため
  return { restrictions: usable, prefectures };
}

app.post("/api/valhalla/route", async (req, res) => {
  const { from, to, vias, variant, costing, excludePolygons,
          displacement, avoidHighways, avoidTolls, arriveOnNearSide,
          at, isHoliday, includeUnverified, stopAt } = req.body || {};
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!ok(from) || !ok(to)) {
    return res.status(400).json({ error: "from / to は [経度, 緯度] で要ります" });
  }
  try {
    // ⚠️ **楽しい道はこの口では選ばない。** 最短・ふつうに混ぜないため、
    //    自動で選ぶのは /api/valhalla/fun-routes の方だけにしてある
    const out = await routeWithValhalla(from, to,
      { vias, variant, costing, excludePolygons,
        displacement, avoidHighways, avoidTolls, arriveOnNearSide,
        restrictionsFor: (pts) => restrictionsForPrefectures(pts, { includeUnverified }),
        stopAt: Array.isArray(stopAt) ? stopAt : [],
        at: at ? new Date(at) : undefined, isHoliday: !!isHoliday });
    if (out.error) return res.status(502).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 楽しい道を通したルートを、**何通りか**返す。
 *
 * ⚠️ **最短・ふつうと分けてあること。** 同じ口で作ると、最短にまで
 *    おすすめ道路が入ってしまう（実機で報告された）。
 *    最短・ふつうは経由地なしの `/api/valhalla/route` で引く。
 *
 * ⚠️ 県は指定させない。両端のあいだに掛かる県を全部集める
 *    （lib/roadRecommendIndex.js）。
 */
/**
 * 引いた経路を、Xcode / simctl で流せる位置情報にして返す。
 *
 * ⚠️ **書式の作り方は `lib/gpx.js` にしかない。** 端末（`makeGpx.js`）と
 *    ここで同じものを使う。2か所に持つと必ずずれる。
 * ⚠️ **画面から線をそのまま送ってもらう。** ここで引き直すと、
 *    画面に出ている案と違う道の位置情報を渡すことになる
 */
app.post("/api/valhalla/gpx", (req, res) => {
  const { points, format, speedKmh, everyMeters, name } = req.body || {};
  if (!Array.isArray(points) || points.length < 2) {
    return res.status(400).json({ error: "points（[経度, 緯度] の配列）が要ります" });
  }
  const simctl = format === "simctl";
  const made = simctl
    ? toSimctl(points, { everyMeters: Number(everyMeters) || 100 })
    : toGpx(points, { speedKmh: Number(speedKmh) || 40,
                      everyMeters: Number(everyMeters) || 20, name });
  const file = simctl ? "route-points.txt" : "route.gpx";
  res.setHeader("Content-Type", simctl ? "text/plain; charset=utf-8" : "application/gpx+xml");
  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  res.setHeader("X-Point-Count", String(made.count));
  res.send(made.text);
});

app.post("/api/valhalla/fun-routes", async (req, res) => {
  const { from, to, vias, costing, excludePolygons, funCount, budgetRatio,
          corridorScale, minScore, displacement, avoidHighways, avoidTolls, arriveOnNearSide,
          at, isHoliday, includeUnverified, stopAt } = req.body || {};
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!ok(from) || !ok(to)) {
    return res.status(400).json({ error: "from / to は [経度, 緯度] で要ります" });
  }
  try {
    const rideAt = at ? new Date(at) : undefined;
    const near = segmentsBetween(from, to);
    // ⚠️ **まわり方は選ばせず、全部作って並べる。**
    //    同じ顔ぶれになる方角（南西へ向かう旅の「北」と「西」など）は
    //    buildSideVariants がまとめる
    const built = buildSideVariants(from, to, near.segments,
      { count: funCount || 4, budgetRatio, corridorScale, minScore });
    const picks = built.variants;
    const sideEmpties = built.empties;

    const routes = [];
    const seen = new Set();
    // ⚠️ **往復の原因は案をまたいで覚える。** 道路網の性質なので、
    //    別の方角の案でも同じところで往復する。
    //    ⚠️ ゴールの回り込みは覚えない（今回の行き先との関係でしかない）
    const bannedForever = new Set();
    for (const pick of picks) {
      // ⚠️ 手で置いた経由地は残す。自動で選んだぶんの前に置く
      const handVias = Array.isArray(vias) ? vias.slice() : [];
      // ⚠️ **二輪が通れない道を避ける。** 走る日時が分かっていれば、その時刻に
      //    効いている規制だけを避ける（`lib/restrictionAvoid.js`）。
      //    ⚠️ 日時を渡さなければ時間の判断をしない（＝時間指定つきも避ける対象になる）
      const routeFn = (autoVias) => routeWithValhalla(from, to,
        { vias: handVias.concat(autoVias), variant: "fun", costing, excludePolygons,
          displacement, avoidHighways, avoidTolls, arriveOnNearSide,
          restrictionsFor: (pts) => restrictionsForPrefectures(pts, { includeUnverified }),
        stopAt: Array.isArray(stopAt) ? stopAt : [], at: rideAt, isHoliday: !!isHoliday });

      // ⚠️ **実際に引いてから、余計に走らせている道を外す。**
      //    選ぶ側（直線の幾何）では見えない（lib/funRouteRefine.js 参照）。
      //    ⚠️ 原因を外したら**案を丸ごと組み立て直す**。1本ずつ抜く方式では、
      //       楽しい道が1本しかない案で何もできず往復が残った
      const rebuild = (banIds) => {
        const usable = near.segments.filter((s) => !banIds.has(s.id));
        return selectFunRoads(from, to, usable, pick.pickOptions);
      };
      const refined = await dropBacktrackingRoads(pick, to, rebuild, routeFn,
        { bannedIds: bannedForever });
      const r = refined.route;
      if (!r || r.error) continue;
      // ⚠️ **往復の原因は次の案でも外しておく。** 道路網の性質なので、
      //    案が変わっても同じところで往復する
      for (const seg of refined.bannedForever) bannedForever.add(seg.id);

      // ⚠️ 外した結果、別の案と同じ顔ぶれになることがある。同じものを並べない
      const key = refined.picked.segments.map((s) => s.id).sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);

      r.kind = pick.kind;
      // ⚠️ **`uTurns`（maneuver の数）と並べて出すこと。** 片方だけだと
      //    「Uターン0回なのに往復している」に気づけない（実際に見落とした）
      r.retracedMeters = refined.retracedMeters;
      r.backtracks = refined.backtracks;
      r.passedDestinationAlong = refined.passedDestinationAlong;
      // ⚠️ **到着のための切り返しは、道のせいではない。** 分けて出さないと
      //    「Uターン1」だけが見えて、直せない不具合に見える
      r.arrivalUTurns = refined.arrivalUTurns || 0;
      // ⚠️ **避けきれなかった規制は必ず出す。** 黙って通させない
      // ⚠️ **表示名は返さない。** 呼ぶ側が `funPick.sides` から作る
      r.funRoads = refined.picked.segments.map((s) => ({
        id: s.id, name: s.name, lengthKm: s.lengthKm,
        score: s.score, curviness: s.curviness, start: s.start, end: s.end,
      }));
      r.funPick = {
        // ⚠️ **「県」ではなく「地域」。** 海外では州・県・地方と呼び名が変わる。
        //    値は不透明な小文字ローマ字（yamanashi / tw-taipei / de-bayern）
        regions: near.prefectures,
        considered: pick.considered,
        estimatedMeters: pick.estimatedMeters,
        baselineMeters: pick.baselineMeters,
        detourRatio: pick.detourRatio,
        //: この案がどの方角から出たか（まとまっていれば複数）
        sides: pick.sides,
        // 方角の指定で落とした本数（0本になったときに理由が分かるように）
        sideDropped: pick.sideDropped || 0,
        uTurnOnly: pick.uTurnOnly,
        // Uターンを起こしたので外した道
        // ⚠️ 同上。名前だけだとAPIに日本語が混ざる
        uTurnDropped: refined.dropped.map((s) => ({ id: s.id, name: s.name })),
        routeCalls: refined.calls,
        //: 楽しい道が無くなった（原因を外し切った）
        ranOut: refined.ranOut,
      };
      routes.push(r);
    }
    if (!routes.length) {
      return res.json({ routes: [], prefectures: near.prefectures, sideEmpties,
                        note: "この範囲に通せるおすすめ道路がありません" });
    }
    // ⚠️ 候補が無かった方角も返す。「出ない」のか「試していない」のかが
    //    分からないと、画面で誤解される
    res.json({ routes, prefectures: near.prefectures, sideEmpties });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * ナビの窓口。**アプリがそのまま食べられる形**でルートと案内を返す。
 *
 * ⚠️ **`/api/valhalla/fun-routes` とは目的が違う。** あちらは確認ツールの画面用で、
 *    案を並べて見せるためのもの。こちらは**アプリ向け**で、
 *    `NavRoute` / `NavStep` に流し込める鍵だけを返す。両方を混ぜないこと。
 *
 * ⚠️ **`guidance` は確かめるためのもの。** 本番のアプリは `NavigationEngine` が
 *    自分で組み立てる（同じ規則なので同じ文言になるはず）。
 *    アプリを載せ替える前に、案内が使い物になるかをここで見る。
 *
 * ⚠️ **`funCount` を渡さなければ、おすすめ道路は通さない。** 素直な経路が要るとき
 *    （最短・ふつう）に、勝手に寄り道を足さない。
 */
app.post("/api/nav/route", async (req, res) => {
  // ⚠️ **`stopAt` を受け取り忘れないこと。** 下で使っているのに取り出しておらず、
  //    この窓口が丸ごと ReferenceError で 500 を返していた（テスト16件が落ちた）
  const { from, to, vias, variant, funCount, budgetRatio, corridorScale, minScore,
          displacement, avoidHighways, avoidTolls, arriveOnNearSide,
          announce, guidance, roadNameStyle, includeUnverified, stopAt,
          heading, headingTolerance, viaHeadings } = req.body || {};
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!ok(from) || !ok(to)) {
    return res.status(400).json({ error: "from / to は [経度, 緯度] で要ります" });
  }

  try {
    const handVias = Array.isArray(vias) ? vias.slice() : [];
    const kind = variant || (funCount > 0 ? "fun" : "normal");
    // ⚠️ `roadNameStyle`: "number"（既定・国道◯号線／県道◯号線）or "name"（路線名のまま）
    // ⚠️ **二輪が通れない道を避ける。** 引いてから掛かったところを塞ぎ直す
    //    （`lib/restrictionAvoid.js`）。`at` を渡さなければ時間の判断をしない
    const drawOptions = { variant: kind, displacement, avoidHighways, avoidTolls,
                          arriveOnNearSide, roadNameStyle, withRoadClass: false,
                          restrictionsFor: (pts) => restrictionsForPrefectures(pts, { includeUnverified }),
                          // ⚠️ **止まる場所（立ち寄り先）の番号。** 空だと経由地が
                          //    全部「通るだけ」になり、着いても知らせられない
                          stopAt: Array.isArray(stopAt) ? stopAt : [],
                          // ⚠️ 走っている向き（引き直しでUターンを避けるため）
                          heading, headingTolerance, viaHeadings,
                          at: req.body.at ? new Date(req.body.at) : undefined,
                          isHoliday: !!req.body.isHoliday };

    let picked = { segments: [], waypoints: [] };
    let refined = null;

    if (funCount > 0) {
      // ⚠️ **おすすめ道路を通すときは、往復の始末までやる。** 画面と同じ手順。
      //    引いてみないと往復は分からない（lib/funRouteRefine.js）
      const near = segmentsBetween(from, to);
      const built = buildSideVariants(from, to, near.segments,
        { count: funCount, budgetRatio, corridorScale, minScore });
      const pick = built.variants[0];
      if (pick) {
        const routeFn = (autoVias) => routeWithValhalla(from, to,
          { ...drawOptions, vias: handVias.concat(autoVias) });
        const rebuild = (banIds) => selectFunRoads(from, to,
          near.segments.filter((seg) => !banIds.has(seg.id)), pick.pickOptions);
        refined = await dropBacktrackingRoads(pick, to, rebuild, routeFn);
        picked = refined.picked;
      }
    }

    const route = refined ? refined.route : await routeWithValhalla(from, to,
      { ...drawOptions, vias: handVias.concat(picked.waypoints) });
    if (!route || route.error) {
      return res.status(502).json({ error: (route && route.error) || "経路が引けません" });
    }

    // ⚠️ **アプリの `NavStep` に対応する鍵だけを返す。**
    //    `instruction` は画面のバナー用、`roadName` は表示用（番号もローマ字も
    //    つないである）、`spokenRoad` が読み上げ用。取り違えないこと
    const steps = route.steps.map((step, i) => ({
      // ⚠️ **アプリの生値に直す**（`lib/navManeuver.js`）。ここは「アプリの NavRoute の形」
      //    を返す口なので、camelCase のまま出すと曲がり角の案内が黙って消える
      maneuver: toAppManeuver(step.maneuver),
      instruction: step.instruction,
      roadName: step.roadName || null,
      spokenRoad: step.spokenRoad || null,
      // ⚠️ 呼び方を後から変えられるように、生の名前と県を渡す
      roadNames: step.roadNames || [],
      prefecture: step.prefecture || null,
      intersectionName: step.intersectionName || null,
      distanceMeters: step.distanceMeters,
      durationSeconds: step.durationSeconds,
      isCurvyAhead: !!step.isCurvyAhead,
      roadKind: step.roadKind,
      beginIndex: step.beginIndex,
      endIndex: step.endIndex,
      // ⚠️ **番号で決めないこと。** 最後の1つだけを終点にすると、途中の
      //    立ち寄り先が「着いた」にならず、アプリが何も言わない（実機で報告）。
      //    区間の切れ目は `lib/valhallaRoute.js` が印を付けている
      //    （配信API `service/lib/buildRoute.js` と同じ扱いにそろえる）
      isLegEnd: step.isLegEnd === true || i === route.steps.length - 1,
    }));

    // ⚠️ 返す線を、そのまま見て数える（上の注意書きを読むこと）
    const shape = blame(route, picked.segments || [], to);

    res.json({
      route: {
        totalDistanceMeters: route.lengthMeters,
        totalDurationSeconds: route.durationSeconds,
        // ⚠️ **6桁ではなく5桁で返す。** アプリ・Google と同じ精度。
        //    Valhalla の6桁のまま渡すと座標が10倍ずれる（実際にやった）
        polyline: encodePolyline(route.points),
        steps,
        funRoads: (picked.segments || []).map((seg) => ({
          id: seg.id, name: seg.name, lengthKm: seg.lengthKm,
          start: seg.start, end: seg.end, score: seg.score, curviness: seg.curviness,
        })),
        // 走らせる前に知っておきたいこと
        uTurns: route.uTurns,
        //: 小道に入って戻る形。見つけた数と、塞いで消せた数（調べもの用）
        wastefulLoops: route.wastefulLoops,
        wastefulLoopsDropped: route.wastefulLoopsDropped,
        //: 塞げずに残った輪の場所。アプリが原因のおすすめ道路を外すのに使う
        wastefulLoopSpans: route.wastefulLoopSpans,
        // ⚠️ **返す線そのものから数え直すこと。** 始末をした結果を持ち回ると、
        //    始末を通らない道筋（おすすめ道路なしのとき）で**いつも0と嘘をつく**。
        //    ここが嘘だと「往復していないはず」で受け入れてしまう
        retracedMeters: shape.retracedMeters,
        arrivalUTurns: shape.arrivalUTurns || 0,
        backtracks: shape.backtracks,
        ferryMeters: route.ferryMeters,
        // ⚠️ **避けきれなかった規制は必ず返す。** 黙って通させない
        restrictionTries: route.restrictionTries,
        restrictionHits: route.restrictionHits,
        restrictionSkipped: route.restrictionSkipped,
        arrivedSide: route.arrivedSide,
        sideGaveUp: !!route.sideGaveUp,
        costing: route.costing,
        costingOptions: route.costingOptions,
      },
      // ⚠️ 要らないときは渡さない。長い経路では数百件になる
      guidance: guidance === false ? undefined
        : simulate({ steps }, { announce }),
      announce: normalizedAnnounce(announce),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 指示の並びから、案内だけを組み立てて返す。
 *
 * ⚠️ **画面の「走らせる」用。** すでに引いてある経路の `steps` を渡してもらう。
 *    経路を引き直さないので速い（読み上げ設定を変えるたびに叩かれる）。
 * ⚠️ **文言を画面側で作らないこと。** アプリと同じ規則をここ（`lib/navGuide.js`）に
 *    だけ置く。二重に持つと必ずずれる。
 */
app.post("/api/nav/guidance", (req, res) => {
  const { steps, announce, roadNameStyle } = req.body || {};
  if (!Array.isArray(steps) || steps.length < 2) {
    return res.status(400).json({ error: "steps が要ります" });
  }
  try {
    // ⚠️ **経路を引き直さずに呼び方を変えられるようにする。**
    //    `roadNames` と `prefecture` を持ち回っているので、ここで決め直せる
    //    （県ごとに都道／府道／道道／県道が変わるので、画面側では決められない）
    const shaped = steps.map((step) => (step.roadNames
      ? { ...step, spokenRoad: spokenRoadName(step.roadNames,
            { prefecture: step.prefecture, style: roadNameStyle }) }
      : step));
    res.json({ guidance: simulate({ steps: shaped }, { announce }),
               announce: normalizedAnnounce(announce) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * JARTIC の取り込み結果を見る窓口。
 *
 * ⚠️ **これは開発者が確かめるための窓口**であって、配信用ではない。
 *    候補はまだ road-builder の規制タブで確認していない下書き。
 * ⚠️ **出典を必ず一緒に返すこと。** JARTIC の規約が求めている
 *    （出典の記載＋加工した旨の明記）。画面にも出す。
 */
app.get("/api/jartic/prefectures", (_req, res) => {
  const dir = path.join(__dirname, "data", "restriction-jartic");
  if (!fs.existsSync(dir)) return res.json({ prefectures: [], note: "まだ取り込んでいません" });
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const c = d.candidates || [];
      out.push({
        prefecture: d.prefecture, romaji: d.romaji,
        targetMonth: d.targetMonth, fetchedAt: d.fetchedAt, totalRows: d.totalRows,
        count: c.length,
        withHours: c.filter((x) => x.activeHours).length,
        withDays: c.filter((x) => x.activeDays || x.includesHoliday).length,
        named: c.filter((x) => x.name).length,
      });
    } catch (e) { /* 壊れたファイルは飛ばす。他の県は見せる */ }
  }
  out.sort((a, b) => b.count - a.count);
  res.json({ prefectures: out });
});

/* ─────────── 二普協由来の規制を JARTIC で置き換える ─────────── */

/**
 * ⚠️ **販売APIに載せられるようにするための作業。**
 *    二普協の一覧は「非営利ならリンク自由」で転用の許諾ではないので、
 *    そこから作った規制（134件）は売れない。JARTIC は商用可なので、
 *    同じ規制が JARTIC 側にあれば作り直せる。
 *
 * ⚠️ **機械で決めない。** 実測で、短い「市道」が長い「首都圏中央連絡自動車道」に
 *    100%重なる。逆に「日立有料道路」は同じ道なのに逆向きが59%しかない。
 *    ここが返すのは順位付けした候補で、判定ではない（`lib/restrictionRebuild.js`）。
 */
const REBUILD_DIR = path.join(__dirname, "data", "restriction-rebuild");
const REBUILD_SKIPPED = path.join(REBUILD_DIR, "skipped.json");

/** 「JARTIC に代わりが無い」と人が判断したもの。⚠️ 消さない限り再び出てこない */
function loadSkipped() {
  try { return JSON.parse(fs.readFileSync(REBUILD_SKIPPED, "utf8")).ids || []; }
  catch { return []; }
}

app.get("/api/rebuild/prefectures", (req, res) => {
  const includeSkipped = req.query.includeSkipped === "1";
  if (!fs.existsSync(REBUILD_DIR)) {
    return res.json({ prefectures: [], note: "node matchJarticToRegistered.js を実行してください" });
  }
  const skipped = new Set(loadSkipped());
  const out = [];
  for (const file of fs.readdirSync(REBUILD_DIR).filter((f) => f.endsWith(".json") && f !== "skipped.json")) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(REBUILD_DIR, file), "utf8"));
      // ⚠️ 一覧と中身で数え方を変えないこと（片方だけ済んだ件を数え続ける）
      const items = pendingItems(d.items, d.romaji, { includeSkipped });
      if (!items.length) continue;
      out.push({
        prefecture: d.prefecture, romaji: d.romaji, builtAt: d.builtAt,
        count: items.length,
        strong: items.filter((x) => x.tier === "強い一致").length,
        review: items.filter((x) => x.tier === "要確認").length,
        none: items.filter((x) => x.tier === "候補なし").length,
        skipped: items.filter((x) => x.skipped).length,
      });
    } catch { /* 壊れたファイルは飛ばす */ }
  }
  out.sort((a, b) => b.strong - a.strong || b.count - a.count);
  res.json({ prefectures: out, skipped: skipped.size });
});

/**
 * まだ作り直していないものだけに絞る。
 *
 * ⚠️ **突き合わせファイルは静的な控え。** 置き換えたあとも中身は残るので、
 *    そのまま返すと済んだ1件が再読込で戻ってくる（実際にそうなった）。
 *    ⚠️ **いまの登録を見て決めること。** 置き換えると id が `jartic-…` に変わり、
 *       `origin` も jartic になるので、どちらでも外れる。
 */
function pendingItems(items, romaji, opts = {}) {
  const skipped = new Set(loadSkipped());
  let live = new Map();
  try {
    const reg = JSON.parse(fs.readFileSync(
      path.join(__dirname, "data", "road-restrictions", `${romaji}.json`), "utf8"));
    for (const r of reg.restrictions || []) live.set(r.id, r);
  } catch { /* 県ごと無ければ、残っているものは無い */ }
  const out = [];
  for (const it of items || []) {
    const now = live.get(it.registered.id);
    // 消えた（＝置き換わった）か、もう二普協由来ではない
    if (!now || now.origin !== "jmpsa") continue;
    const isSkipped = skipped.has(it.registered.id);
    // ⚠️ **見送ったものを見る手段を残すこと。** 隠したままだと、
    //    間違えて「JARTIC に無い」と決めた1件を戻せない
    if (isSkipped && !opts.includeSkipped) continue;
    out.push(isSkipped ? { ...it, skipped: true } : it);
  }
  return out;
}

/**
 * 作り直しの進み具合。
 *
 * ⚠️ **待ち行列が空になったとき、画面が「終わった」と言えるようにするため。**
 *    数字が無いと、片付いたのか壊れているのか見分けがつかない（実際に分からなかった）。
 */
app.get("/api/rebuild/progress", (_req, res) => {
  let jmpsa = 0, jartic = 0, osm = 0, total = 0, sellable = 0;
  try {
    const dir = path.join(__dirname, "data", "road-restrictions");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const r of d.restrictions || []) {
        total++;
        if (isSellable(r)) sellable++;
        if (r.origin === "jmpsa") jmpsa++;
        else if (r.origin === "jartic") jartic++;
        else if (r.origin === "osm") osm++;
      }
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }
  const skipped = loadSkipped().length;
  res.json({ total, sellable, osm, jartic, jmpsa, skipped,
             // 残っている＝まだ二普協由来で、見送ってもいないもの
             pending: Math.max(0, jmpsa - skipped) });
});

app.get("/api/rebuild/:romaji", (req, res) => {
  const file = path.join(REBUILD_DIR, `${req.params.romaji}.json`);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "突き合わせがまだです。node matchJarticToRegistered.js" });
  }
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    d.items = pendingItems(d.items, req.params.romaji,
      { includeSkipped: req.query.includeSkipped === "1" });
    res.json(d);
  } catch (e) { res.status(500).json({ error: `読めません: ${e.message}` }); }
});

/**
 * 1件を JARTIC の候補に置き換える。
 *
 * ⚠️ **入れ替えはサーバー側でやる。** 画面から県ぶんの配列を送り返させると、
 *    表示していない規制を巻き添えで消しうる。
 * ⚠️ **規制の中身は JARTIC のものを採る**（時間帯・排気量・種別）。人が引いた線ではなく
 *    JARTIC の区間形状に置き換わるので、`origin: "jartic"` と言い切れる。
 */
/**
 * 登録した規制を Firestore へ反映する（アプリが読む置き場）。
 *
 * ⚠️ **アプリはルート生成に規制を使っていない**（いまは Google Directions）。
 *    ここで配るのは**走行中の規制予告**と**ルート候補の絞り込み**に効く。
 * ⚠️ **未確認の JARTIC 候補は配らない。** `importRestrictions.js` が読むのは
 *    `data/road-restrictions` だけ。混ぜたければ先に road-builder で確認して登録すること。
 *
 * ⚠️ **`commit` を付けない限り書き込まない。** 本番の Firestore なので、
 *    まず下見して差分を見ること（`importRestrictions.js` の注意書きと同じ）。
 * ⚠️ 誤った区間を配ると「通れない」と誤案内することになる。
 */
app.post("/api/restrictions/publish", async (req, res) => {
  const commit = req.body && req.body.commit === true;
  const prefecture = req.body && req.body.prefecture;
  const args = prefecture ? ["--prefecture", String(prefecture)] : ["--all"];
  if (commit) args.push("--commit");

  const out = await run("importRestrictions.js", args);
  // 手元の件数も返す。⚠️ 反映できたかは Firestore 側の数字で確かめること
  let local = 0, files = 0;
  try {
    const dir = path.join(__dirname, "data", "road-restrictions");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const n = (d.restrictions || []).length;
      // ⚠️ **空のファイルを県として数えない。** `importRestrictions.js` は
      //    中身のある県だけを数えるので、揃えないと画面と出力が食い違う
      if (!n) continue;
      local += n;
      files++;
    }
  } catch (e) { /* 数えられなくても結果は返す */ }

  res.json({ ok: out.ok, commit, prefecture: prefecture || null,
             local, files, stdout: out.stdout, stderr: out.stderr });
});

app.post("/api/rebuild/:romaji/promote", (req, res) => {
  const { romaji } = req.params;
  const { registeredId, candidateId } = req.body || {};
  if (!registeredId || !candidateId) {
    return res.status(400).json({ error: "registeredId と candidateId が要ります" });
  }

  const regFile = path.join(__dirname, "data", "road-restrictions", `${romaji}.json`);
  const candFile = path.join(__dirname, "data", "restriction-jartic", `${romaji}.json`);
  if (!fs.existsSync(regFile)) return res.status(404).json({ error: "その県の規制がありません" });
  if (!fs.existsSync(candFile)) return res.status(404).json({ error: "その県の JARTIC 候補がありません" });

  let reg, cand;
  try {
    reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
    cand = JSON.parse(fs.readFileSync(candFile, "utf8"));
  } catch (e) { return res.status(500).json({ error: `読めません: ${e.message}` }); }

  const at = (reg.restrictions || []).findIndex((r) => r.id === registeredId);
  if (at < 0) return res.status(404).json({ error: "その規制が見つかりません" });
  const c = (cand.candidates || []).find((x) => x.id === candidateId);
  if (!c) return res.status(404).json({ error: "その候補が見つかりません" });
  if (!Array.isArray(c.points) || !c.points.length) {
    return res.status(400).json({ error: "候補に線がありません" });
  }

  const old = reg.restrictions[at];

  // ⚠️ **同じ候補に2件を寄せると重複する。** 実際に5件そうなった。
  //    二普協側では隣り合う2区間でも、JARTIC 側では1区間ということがある。
  //    ⚠️ **2つ目を足さずに、元の1件を消す**（2区間が1区間にまとまる）
  const already = reg.restrictions.findIndex((r, i) => i !== at && r.id === c.id);
  if (already >= 0) {
    reg.restrictions.splice(at, 1);
    fs.writeFileSync(regFile, JSON.stringify(
      { romaji, updatedAt: new Date().toISOString(),
        count: reg.restrictions.length, restrictions: reg.restrictions }, null, 1) + "\n");
    return res.json({ ok: true, merged: true, replaced: { from: old.id, to: c.id },
                      total: reg.restrictions.length,
                      sellable: reg.restrictions.filter(isSellable).length });
  }

  reg.restrictions[at] = {
    id: c.id,
    kind: c.kind || old.kind,
    // ⚠️ JARTIC 側で名前が引けていないことがある。そのときは元の名前を残す
    name: c.name || old.name,
    prefecture: old.prefecture || cand.prefecture || "",
    // ⚠️ **5桁で書く。** 配信物も端末も5桁（`lib/polyline.js`）
    polyline: encodePolyline(c.points),
    note: c.note || null,
    activeMonths: c.activeMonths || null,
    activeDays: c.activeDays || null,
    includesHoliday: c.includesHoliday === true,
    activeHours: c.activeHours || null,
    minCc: Number.isFinite(c.minCc) ? c.minCc : null,
    maxCc: Number.isFinite(c.maxCc) ? c.maxCc : null,
    checkedAt: new Date().toISOString().slice(0, 10),
    source: "admin",
    // ⚠️ ここが目的。JARTIC は商用可なので販売APIに載る
    origin: "jartic",
  };

  fs.writeFileSync(regFile, JSON.stringify(
    { romaji, updatedAt: new Date().toISOString(),
      count: reg.restrictions.length, restrictions: reg.restrictions }, null, 1) + "\n");

  const sellable = reg.restrictions.filter(isSellable).length;
  res.json({ ok: true, replaced: { from: old.id, to: c.id },
             total: reg.restrictions.length, sellable });
});

/** 「JARTIC に代わりが無い」と決めたものを控える。⚠️ 規制自体は消さない（アプリでは使う） */
app.post("/api/rebuild/skip", (req, res) => {
  const id = req.body && req.body.registeredId;
  if (!id) return res.status(400).json({ error: "registeredId が要ります" });
  const ids = new Set(loadSkipped());
  if (req.body.undo) ids.delete(String(id)); else ids.add(String(id));
  fs.mkdirSync(REBUILD_DIR, { recursive: true });
  fs.writeFileSync(REBUILD_SKIPPED, JSON.stringify({ ids: [...ids] }, null, 1) + "\n");
  res.json({ ok: true, skipped: ids.size });
});

app.get("/api/jartic/:romaji", (req, res) => {
  const file = path.join(__dirname, "data", "restriction-jartic", `${req.params.romaji}.json`);
  if (!fs.existsSync(file)) {
    return res.status(404).json({
      error: "その県はまだ取り込んでいません。node fetchJarticRestrictions.js --prefecture <県名>",
    });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    res.status(500).json({ error: `読めません: ${e.message}` });
  }
});

/** Valhalla が立っているか。画面がまず聞きに来る */
app.get("/api/valhalla/status", async (_req, res) => {
  try {
    const r = await fetch(`${VALHALLA_URL}/status`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    res.json({ up: true, url: VALHALLA_URL, version: j.version });
  } catch (e) {
    res.json({ up: false, url: VALHALLA_URL, error: e.message });
  }
});

/**
 * Google マイマップから規制の区間を取り込む。
 *
 * 県警や二普協が規制区間をマイマップで公開していることがある。目で見て座標を
 * 写すと間違えるし、区間の形（何百点）は写せない。KML で読む。
 *
 * ⚠️ 公開されている地図だけ。限定公開のものは Google が 404 を返す。
 * ⚠️ 取り込むのは**形と名前だけ**。規制の種別・時間・排気量は説明文に日本語で
 *    書かれているだけなので、人が読んで画面で設定すること（自動で解釈しない）。
 */
app.get("/api/restrictions/mymaps", async (req, res) => {
  const mid = midFrom(req.query.url || req.query.mid);
  if (!mid) return res.status(400).json({ error: "マイマップの URL か mid を渡してください" });
  try {
    const r = await fetch(kmlUrl(mid), { headers: { "User-Agent": "biketeilen-admin/1.0" } });
    if (!r.ok) {
      return res.status(502).json({
        error: `マイマップを読めませんでした（${r.status}）。公開されている地図か確認してください`,
      });
    }
    const parsed = parseKml(await r.text());
    res.json({ mid, ...parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ⚠️ **`/api/restrictions/:romaji` より前に置くこと。** あとに置くと `roads-at` が
//    県のローマ字として食われ、規制の空配列が返る（実際に踏んだ）。
/**
 * 指した1点のまわりの道路を、手元のグリッドCSVから組み立てて返す。
 *
 * 【なぜ要るか】
 * 道路名で引く `/api/restrictions/roads` は県ごとの索引（buildRoadIndex.js）が要り、
 * 全国を作るには時間がかかるので3県しか用意できていない。加えて二普協の道路名と
 * 地図の名前は食い違うことがあり、名前が分からないと何も出せなかった。
 * 場所さえ分かれば道は特定できるので、**地図で指した点**から組み立てる。
 *
 * ⚠️ CSV は開発機のローカルにしかない（~/Documents/grid_csvs_japan_empty）。
 *    無ければ 404 で理由を返す。ここは 127.0.0.1 専用のツールなのでそれでよい。
 */
app.get("/api/restrictions/roads-at", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat と lng が要ります", roads: [] });
  }
  if (!fs.existsSync(GRID_DIR)) {
    return res.status(404).json({
      error: `道路CSVが見つかりません: ${GRID_DIR}`, roads: [],
    });
  }
  try {
    const result = await roadsAtPoint(lat, lng, {
      radiusMeters: req.query.radius,
      prefecture: String(req.query.prefecture || ""),
    });
    if (!result.roads.length && result.grids.length === 0) {
      return res.json({ ...result, error: "この場所のCSVが手元にありません" });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, roads: [] });
  }
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
      // 効いている曜日・時間帯。おかしな値は保存しない（`lib/restrictionTime.js`）
      activeDays: normalizeDays(r.activeDays),
      includesHoliday: r.includesHoliday === true,
      activeHours: normalizeHours(r.activeHours),
      minCc: Number.isFinite(r.minCc) ? r.minCc : null,
      maxCc: Number.isFinite(r.maxCc) ? r.maxCc : null,
      // いつ確認したか。規制は変わるので必ず持たせる
      checkedAt: r.checkedAt || new Date().toISOString().slice(0, 10),
      source: r.source || "admin",
      // ⚠️ **どの資料をもとに作ったか。販売できるかがこれで決まる。**
      //    jartic … JARTIC のオープンデータ。**CC BY 4.0 互換・商用可**（出典表示が条件）
      //    jmpsa  … 二普協の一覧。⚠️ **「非営利ならリンク自由」で転用の許諾ではない**
      //    osm    … OpenStreetMap のタグ。ODbL（商用可・出典表示が義務）
      //    survey … 自分で標識を見て作った。自前のもの
      //    ⚠️ **記録が無いものは販売APIに載せない。** 由来が分からないものを
      //       売り物に入れてはいけない（あとから切り分けられない）
      origin: normalizeOrigin(r.origin, r.id),
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

/**
 * 道路の索引をその場で作る。
 *
 * ⚠️ 索引が無い県では「道路名で探す」が何も返せない。作り方を文章で出すだけだと、
 *    ツールを離れて端末を開くことになる。実測で1県あたり約15秒なので、ここで作れる。
 * ⚠️ 作ったら**メモリの控えを捨てること**。捨てないと、作ったのに
 *    「未生成です」と言い続ける。
 */
app.post("/api/roads/index/:romaji", async (req, res) => {
  const { romaji } = req.params;
  const prefecture = Object.keys(ROMAJI).find((n) => ROMAJI[n] === romaji);
  if (!prefecture) return res.status(400).json({ ok: false, error: "県が分かりません: " + romaji });
  const r = await run("buildRoadIndex.js", ["--prefecture", prefecture]);
  roadIndexCache.delete(romaji);
  const index = loadRoadIndex(romaji);
  res.json({ ok: r.ok && !!index, count: index ? index.roads.length : 0,
             stdout: r.stdout, stderr: r.stderr });
});

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

/**
 * 区間のドラッグ修正で「別の道路へ乗り移る」ためのスナップ先。
 *
 * ⚠️ 二普協の道路名（例:「筑波公園永井線」）と、実際に地図・OSMがその場所に
 *    付けている名前（例:「フルーツライン」）が一致しないことがある
 *    （茨城の「道祖神峠≠笠間つくば線」と同じ問題）。
 *    候補の chainPolyline（1本の名前で繋いだ道）だけにドラッグ範囲を限ると、
 *    名前が変わった先で道が途切れて見え、「動かせない」ように見えてしまう。
 *
 * そのため県内の全道路をここから返し、ブラウザ側でドラッグ中に
 * 一番近い道路（元の候補と違う名前でもよい）へ乗り移れるようにする。
 * 1県 0.2MB 程度なのでまるごと返してよい。
 */
app.get("/api/restrictions/roads-all/:romaji", (req, res) => {
  const index = loadRoadIndex(req.params.romaji);
  if (!index) {
    return res.status(404).json({
      error: "道路の索引が未生成です。node buildRoadIndex.js --prefecture <県名> を実行してください。",
      roads: [],
    });
  }
  res.json({
    prefecture: index.prefecture,
    roads: index.roads.map((r) => ({ name: r.name, highway: r.highway, polyline: r.polyline })),
  });
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
