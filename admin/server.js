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
// フィールド対応は web の plan-suggest.html と同一。
app.get("/api/spots", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 6000, 30000);
    const snap = await db.collection("imagedownload").limit(limit).get();
    const spots = [];
    snap.forEach((d) => {
      const x = d.data() || {};
      const lat = Number(x.lat), lng = Number(x.lng);
      if (!isFinite(lat) || !isFinite(lng)) return;
      spots.push({
        spotId: d.id,
        name: x.location_name || x.locality || x.administrative || "スポット",
        lat,
        lng,
        address: x.administrative || x.locality || null,
        imageURL: (Array.isArray(x.locationImageURLs) && x.locationImageURLs[0]) || x.iconImageURL || null,
      });
    });
    res.json({ count: spots.length, limited: snap.size >= limit, spots });
  } catch (e) {
    console.error("spots error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

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
