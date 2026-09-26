/**
 * service/lib/sapa.js
 *
 * `/v1/sapa` の中身。経路の線から、寄れる高速の SA/PA を経路の順に返す（判断は `admin/lib/sapa.js`）。
 * 設計は app repo `docs/sapa-plan.md`。
 *
 * ⚠️ **経路を引くたびには呼ばせない。** 1本で1秒ほどかかる（候補ごとに Valhalla で寄り道を引く）。
 *    アプリは候補を選んだあと・ナビを始めたときに1回だけ呼ぶ
 * ⚠️ **形の崩れた入力は Valhalla に渡さず 400 で返す。**
 */
"use strict";

const { sapaAlongRoute } = require("../../admin/lib/sapa");
const { DISPLACEMENTS } = require("../../admin/lib/valhallaRoute");
const { decode } = require("../../admin/lib/polyline");

/** ⚠️ SA/PA の場所とガソリンスタンドは OSM から。JARTIC は使っていない */
const SAPA_ATTRIBUTION = ["© OpenStreetMap contributors（ODbL） https://www.openstreetmap.org/copyright"];

//: 受け取る線の点の上限。東京→鹿児島（約1,300km）でアプリの線は 2万点ほど
const MAX_POINTS = 60_000;

async function buildSapaResponse(body, deps = {}) {
  const { polyline, displacement } = body || {};
  if (typeof polyline !== "string" || !polyline.length) {
    return { status: 400, body: { error: "polyline（5桁の符号化した線）が要ります" } };
  }
  let points;
  try { points = decode(polyline); } catch (e) { points = null; }
  const ok = (p) => Array.isArray(p) && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS || !points.every(ok)) {
    return { status: 400, body: { error: `polyline は2〜${MAX_POINTS}点の線で要ります` } };
  }
  // ⚠️ 高速に乗れない排気量には SA/PA は無い（下道の経路）
  const bike = typeof displacement === "string" ? DISPLACEMENTS[displacement] : null;
  if (bike && !bike.canUseExpressway) return { status: 200, body: { sapa: [], attribution: SAPA_ATTRIBUTION } };
  try {
    const sapa = await sapaAlongRoute(points, {
      baseUrl: deps.baseUrl, fetch: deps.fetch, costing: (bike && bike.costing) || "motorcycle",
      areas: deps.areas, gates: deps.gates,
    });
    return { status: 200, body: { sapa, attribution: SAPA_ATTRIBUTION } };
  } catch (e) {
    return { status: 502, body: { error: e.message } };
  }
}

module.exports = { buildSapaResponse, SAPA_ATTRIBUTION, MAX_POINTS };
