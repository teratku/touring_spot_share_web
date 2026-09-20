/**
 * service/lib/snapRoads.js
 *
 * `/v1/snap` の中身。なぞった線を道路に載せる（判断は `admin/lib/snapRoads.js`）。
 *
 * ⚠️ **形の崩れた入力は Valhalla に渡さず 400 で返す。** 数の上限もここで守る
 *    （1回で送れるのは100点。アプリは100点ずつに区切って送る）。
 */
"use strict";

const { snapToRoads, MAX_SNAP_POINTS } = require("../../admin/lib/snapRoads");
const { DISPLACEMENTS } = require("../../admin/lib/valhallaRoute");

/** ⚠️ 道路に載せるのに使うのは OSM だけ。JARTIC の出典は付けない（加工していない） */
const SNAP_ATTRIBUTION = ["© OpenStreetMap contributors（ODbL） https://www.openstreetmap.org/copyright"];

async function buildSnapResponse(body, deps = {}) {
  const { points, displacement } = body || {};
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_SNAP_POINTS
      || !points.every(ok)) {
    return { status: 400, body: { error: `points は [経度, 緯度] を2〜${MAX_SNAP_POINTS}個で要ります` } };
  }
  // ⚠️ 知らない排気量は無視する（既定の motorcycle で載せる）
  const known = typeof displacement === "string" && DISPLACEMENTS[displacement] ? displacement : undefined;
  try {
    const out = await snapToRoads(points, { displacement: known, baseUrl: deps.baseUrl, fetch: deps.fetch });
    return { status: 200, body: { points: out.points, attribution: SNAP_ATTRIBUTION } };
  } catch (e) {
    return { status: 502, body: { error: e.message } };
  }
}

module.exports = { buildSnapResponse, SNAP_ATTRIBUTION };
