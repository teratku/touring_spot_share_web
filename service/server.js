/**
 * service/server.js
 *
 * **配信用のルート生成API。** Cloud Run で Valhalla と同じコンテナに入る。
 *
 * ⚠️ **`admin/server.js` とは別物。** あちらは開発者用でローカル専用
 *    （`const HOST = "127.0.0.1"`）、認証なし、管理の窓口が全部載っている。
 *    **あれを公開してはいけない。** こちらは `/v1/route` と `/v1/snap` だけを出す。
 *
 * 【判断のもと】
 * ⚠️ **`admin/lib` を複製しないこと。** 規制の判断（排気量・時間・重なり）が
 *    2か所に分かれると必ずずれる。Dockerfile がリポジトリの根から
 *    `admin/lib` をそのまま入れるので、`require("../admin/lib/…")` が
 *    手元でもコンテナでも同じように効く。
 *
 * 【売り物としての線引き】
 * ⚠️ **二普協（jmpsa）由来と、由来の記録が無い規制は載せない**
 *    （`admin/lib/restrictionOrigin.js`）。二普協の規約は
 *    「非営利目的ならリンク自由」で、データ転用の許諾ではない。
 *    ⚠️ **いまは販売できる規制がほぼ無い。** 登録済み279件はすべて記録が無く、
 *       JARTIC の候補（1,442件）を確認して昇格させたぶんだけ効いていく。
 *
 * ⚠️ **出典を必ず応答に入れること。** OSM は ODbL で表示が義務、
 *    JARTIC は規約が出典と「加工した」旨の明記を求めている。
 */
"use strict";

const express = require("express");
const admin = require("firebase-admin");

const { isSellable } = require("../admin/lib/restrictionOrigin");
const { PrefectureLocator } = require("../admin/lib/prefectureLocator");
const { ROMAJI } = require("../admin/lib/prefectureRomaji");
const { buildRouteResponse } = require("./lib/buildRoute");
const { buildSnapResponse } = require("./lib/snapRoads");

const PORT = process.env.PORT || 8080;
/** ⚠️ Cloud Run は 0.0.0.0 で待つこと。127.0.0.1 だと外から繋がらない */
const HOST = "0.0.0.0";
/** ⚠️ Valhalla は同じコンテナの中。外に出さない */
const VALHALLA_URL = process.env.VALHALLA_URL || "http://127.0.0.1:8002";
const COLLECTION = "road_restrictions";

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const locator = new PrefectureLocator();

const app = express();
app.use(express.json({ limit: "1mb" }));

// MARK: 認証

/**
 * Firebase の ID トークンを確かめる。
 *
 * ⚠️ **無認証で出さないこと。** 1本引くのに Valhalla が数百msのCPUを使う。
 *    ⚠️ 販売するなら、この先に**APIキーと使用量の計測**が要る。
 *       Firebase Auth は「アプリの利用者」を見るもので、「顧客企業」ではない。
 *       いまは自社アプリ向けの入口として作ってある。
 */
async function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authorization: Bearer <IDトークン> が要ります" });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (e) {
    res.status(401).json({ error: "トークンを確かめられません" });
  }
}

// MARK: 規制

/**
 * 県ぶんの規制を Firestore から読む。
 *
 * ⚠️ **イメージに焼かないこと。** 規制は月次で増える。焼くとイメージを
 *    作り直すまで反映されない。
 * ⚠️ **1日1回で足りる。** 規制はめったに変わらない（アプリの
 *    `RoadRestrictionStore` も同じ考え方で24時間）。
 */
const cache = new Map();
const CACHE_TTL_MS = 24 * 3600 * 1000;

async function loadPrefecture(romaji) {
  const hit = cache.get(romaji);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.list;
  let list = [];
  try {
    const doc = await db.collection(COLLECTION).doc(romaji).get();
    list = doc.exists ? (doc.data().restrictions || []) : [];
  } catch (e) {
    // ⚠️ 読めなくても経路は返す。**規制が無いことにはしない**ので、
    //    避けきれなかったことが応答に出る（`restrictionHits`）
    console.error(`規制が読めません ${romaji}: ${e.message}`);
    list = hit ? hit.list : [];
  }
  cache.set(romaji, { at: Date.now(), list });
  return list;
}

/**
 * 経路が通る県の規制を集める。
 *
 * ⚠️ **両端の県だけでは足りない。** 実測: 東京→大阪の両端は [東京都, 大阪府] だが
 *    実際に通るのは8県で、**6県ぶんの規制を見落とす**。
 *    ⚠️ Valhalla の `trace_attributes` は**200kmまで**なので県決めには使えない。
 */
async function restrictionsForRoute(routePoints) {
  const step = Math.max(1, Math.floor((routePoints || []).length / 400));
  const prefectures = [];
  const seen = new Set();
  for (let i = 0; i < (routePoints || []).length; i += step) {
    const p = routePoints[i];
    let name = null;
    try { name = locator.locate(p[0], p[1]); } catch (e) { name = null; }
    if (name && !seen.has(name)) { seen.add(name); prefectures.push(name); }
  }

  const out = [];
  for (const pref of prefectures) {
    const romaji = ROMAJI[pref];
    if (!romaji) continue;
    // ⚠️ **売ってよい出どころだけ**（`restrictionOrigin.js`）
    out.push(...(await loadPrefecture(romaji)).filter(isSellable));
  }
  return { restrictions: out, prefectures };
}

// MARK: 窓口

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * ルートを1本引く。
 *
 * ⚠️ **管理の窓口は載せない。** 規制の編集・取り込み・道路データの生成は
 *    `admin/` の仕事で、外に出すものではない。
 */
app.post("/v1/route", requireAuth, async (req, res) => {
  const out = await buildRouteResponse(req.body || {}, {
    baseUrl: VALHALLA_URL, restrictionsFor: restrictionsForRoute,
  });
  res.status(out.status).json(out.body);
});

/**
 * なぞった線を道路に載せる（アプリの「なぞる」。もとは Google の Roads API）。
 *
 * ⚠️ **認証を外さないこと。** `/v1/route` と同じく Valhalla の CPU を使う
 */
app.post("/v1/snap", requireAuth, async (req, res) => {
  const out = await buildSnapResponse(req.body || {}, { baseUrl: VALHALLA_URL });
  res.status(out.status).json(out.body);
});

app.listen(PORT, HOST, () => {
  console.log(`🛣  ルート生成API: http://${HOST}:${PORT}  （Valhalla: ${VALHALLA_URL}）`);
});
