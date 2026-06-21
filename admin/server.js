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
app.use(express.json({ limit: "2mb" }));
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

app.listen(PORT, HOST, () => {
  console.log(`🛠  スタンプラリー ビルダー: http://${HOST}:${PORT}`);
  console.log("   ローカル専用。Firestore 認証は importRallies.js と同じ（serviceAccount.json / ADC）。");
});
