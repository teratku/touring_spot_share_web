/**
 * service/lib/michiNoEki.js
 *
 * `/v1/michinoeki` の中身。経路の線と走る時間から、休憩に寄る道の駅を経路の順に返す（判断は `admin/lib/michiNoEki.js`）。
 *
 * ⚠️ 利用者の要望（2026-10-01）:「途中で道の駅によるモードあったらいいなー」。判断: 休憩の間隔で足す（約1時間ごと・選べる）
 * ⚠️ **経路を引くたびには呼ばせない。** 休憩ごとに Valhalla で寄り道を引く（手元で1本 0.1〜0.4秒）。
 *    アプリは「道の駅で休憩」を選んだときに1回だけ呼ぶ
 * ⚠️ **形の崩れた入力は Valhalla に渡さず 400 で返す。**
 */
"use strict";

const { restStopsAlongRoute } = require("../../admin/lib/michiNoEki");
const { DISPLACEMENTS } = require("../../admin/lib/valhallaRoute");
const { decode } = require("../../admin/lib/polyline");
const { MAX_POINTS } = require("./sapa");

/** ⚠️ 道の駅の場所は OSM から */
const MICHINOEKI_ATTRIBUTION = ["© OpenStreetMap contributors（ODbL） https://www.openstreetmap.org/copyright"];

//: 選べる休憩の間隔（分）。アプリのつまみと同じ
const INTERVALS = [60, 90, 120];

async function buildMichiNoEkiResponse(body, deps = {}) {
  const { polyline, displacement, intervalMinutes, durationSeconds, stepTimes, excludedRanges } = body || {};
  if (typeof polyline !== "string" || !polyline.length) {
    return { status: 400, body: { error: "polyline（5桁の符号化した線）が要ります" } };
  }
  if (!INTERVALS.includes(Number(intervalMinutes))) {
    return { status: 400, body: { error: `intervalMinutes は ${INTERVALS.join("・")} のどれかで要ります` } };
  }
  if (!(Number(durationSeconds) > 0)) {
    return { status: 400, body: { error: "durationSeconds（走る時間・秒）が要ります" } };
  }
  let points;
  try { points = decode(polyline); } catch (e) { points = null; }
  const ok = (p) => Array.isArray(p) && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS || !points.every(ok)) {
    return { status: 400, body: { error: `polyline は2〜${MAX_POINTS}点の線で要ります` } };
  }
  const pairs = (list) => (Array.isArray(list) ? list : [])
    .filter((x) => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite));
  const bike = typeof displacement === "string" ? DISPLACEMENTS[displacement] : null;
  try {
    const stops = await restStopsAlongRoute(points, {
      intervalMinutes: Number(intervalMinutes), durationSeconds: Number(durationSeconds),
      stepTimes: pairs(stepTimes), excludedRanges: pairs(excludedRanges),
      baseUrl: deps.baseUrl, fetch: deps.fetch, ask: deps.ask, stations: deps.stations,
      // ⚠️ 寄り道は乗り手の乗り物で引く（原付は原付の道で）
      costing: (bike && bike.costing) || "motorcycle",
    });
    return {
      status: 200,
      body: {
        // ⚠️ `index` は送られた線の点の番号。アプリはこれで「どの立ち寄り先の前に足すか」を決める
        stops: stops.map((s) => ({ name: s.name, stop: s.stop, index: s.index, alongMeters: s.alongMeters,
                                   atSeconds: s.atSeconds, extraMeters: s.extraMeters })),
        attribution: MICHINOEKI_ATTRIBUTION,
      },
    };
  } catch (e) {
    return { status: 502, body: { error: e.message } };
  }
}

module.exports = { buildMichiNoEkiResponse, MICHINOEKI_ATTRIBUTION, INTERVALS };
