/**
 * michiNoEki.js
 *
 * **経路の途中で休憩に寄る道の駅**を選ぶ（アプリの「道の駅で休憩」）。
 *
 * 利用者の要望（2026-10-01）:「途中で道の駅によるモードあったらいいなー」。
 * 判断（2026-10-03）: **休憩の間隔で足す**（走る時間で約1時間ごと・間隔は選べる）。
 *
 * 【選び方】前の休憩（最初は出発）から「間隔」走ったあたりで、経路のそばにある道の駅を、
 *   目標に近い順に**実際に引いて**確かめる（SA/PA と同じ: 経路の手前 → 道の駅 → 先 を引き、
 *   まっすぐ行くより何 m 余計に走るか）。遠回りが 3km 未満なら寄る。寄ったら、そこから次の間隔を数える。
 *   探す範囲は前の休憩から間隔の 0.5〜1.25倍 → 無ければ 1.5倍まで → それでも無ければその先で最初に寄れる駅。
 * ⚠️ **目標の前後だけで探さないこと。** 平地の郊外は道の駅がまばらで、見つからない時刻を飛ばしていくと
 *   休憩が大きく空く（実測・国道398号 834分・60分間隔: 前後25%だけだと最初の休憩が233分後）
 * ⚠️ **着く直前の休憩は足さない**（ゴールの手前20分以内）。
 * ⚠️ **おすすめ道路を走っている途中では寄らせない**（`excludedRanges`）。道の途中で寄り道させると、
 *   アプリが道の駅を「その道の手前の立ち寄り先」として足すので、道を走る前に寄ることになる
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { cumulative, decode6 } = require("./sapa");

const FILE = path.join(__dirname, "..", "data", "michinoeki.json");

//: 経路からこの距離（m）以内の道の駅を候補にする
const NEAR_METERS = 1500;
//: 探す範囲（前の休憩からの、間隔に対する割合）。まず [早い, 遅い]、無ければ [早い, もっと遅い]、それでも無ければその先全部
const WINDOW_EARLY = 0.5;
const WINDOW_LATE = 1.25;
const WINDOW_LATER = 1.5;
//: 寄るかを確かめる区間（経路の手前と先、m）
const TRIAL_METERS = 1000;
//: これ未満の遠回り（m）なら寄る
const MAX_EXTRA_METERS = 3000;
//: ゴールの手前この時間（秒）以内には休憩を置かない
const MIN_TAIL_SECONDS = 20 * 60;
//: 1回の休憩につき試す道の駅の数（目標に近い順）
const MAX_TRIALS = 4;
const TIMEOUT_MS = 15_000;

function meters(lat1, lon1, lat2, lon2) {
  const k = Math.cos((lat1 * Math.PI) / 180) * 111320;
  return Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * k);
}

let cached = null;
function load(file = FILE) {
  if (cached && cached.file === file) return cached.stations;
  let stations = [];
  try {
    stations = (JSON.parse(fs.readFileSync(file, "utf8")).stations || [])
      .map(([lat, lon, name]) => ({ lat, lon, name }));
  } catch (e) {
    stations = [];
  }
  cached = { file, stations };
  return stations;
}

/**
 * 経路の点ごとの、出発からの秒数。
 * @param stepTimes [[その区切りの点の番号, そこまでの秒数], ...]（アプリの指示ごと）。無ければ距離で割り振る
 */
function timeline(points, cum, durationSeconds, stepTimes) {
  const total = cum[cum.length - 1] || 1;
  const marks = [[0, 0], ...((stepTimes || []).filter(([i, s]) => Number.isInteger(i) && Number.isFinite(s)
    && i > 0 && i < points.length)), [points.length - 1, durationSeconds]]
    .sort((a, b) => a[0] - b[0]);
  if (marks.length === 2) return cum.map((m) => (m / total) * durationSeconds);
  const out = new Array(points.length).fill(0);
  for (let k = 1; k < marks.length; k++) {
    const [i0, s0] = marks[k - 1], [i1, s1] = marks[k];
    const span = cum[i1] - cum[i0] || 1;
    for (let i = i0; i <= i1; i++) out[i] = s0 + ((cum[i] - cum[i0]) / span) * (s1 - s0);
  }
  return out;
}

/** 経路のそばの道の駅（いちばん近い点の番号と距離つき） */
function stationsNear(points, stations) {
  const out = [];
  for (const st of stations) {
    let best = Infinity, index = -1;
    for (let i = 0; i < points.length; i++) {
      const [lon, lat] = points[i];
      if (Math.abs(lat - st.lat) > 0.02 || Math.abs(lon - st.lon) > 0.025) continue;
      const d = meters(lat, lon, st.lat, st.lon);
      if (d < best) { best = d; index = i; }
    }
    if (index >= 0 && best <= NEAR_METERS) out.push({ station: st, index, offMeters: Math.round(best) });
  }
  return out;
}

/**
 * その道の駅に寄れるか（経路の手前 → 道の駅 → 先 を引いて、まっすぐより余計に走る距離）。
 * @returns {{ok:boolean, extraMeters?:number, stop?:[number, number]}} stop は寄ると確かめた点（敷地の中の道）
 */
async function checkStop(points, cum, cand, { ask, costing }) {
  let i0 = cand.index;
  while (i0 > 0 && cum[cand.index] - cum[i0] < TRIAL_METERS) i0--;
  let i1 = cand.index;
  while (i1 < points.length - 1 && cum[i1] - cum[cand.index] < TRIAL_METERS) i1++;
  const direct = cum[i1] - cum[i0];
  const loc = ([lon, lat]) => ({ lat, lon });
  const body = {
    locations: [loc(points[i0]),
      // ⚠️ 敷地の中の道（駐車場）に寄せる。寄せないと前の道に吸い付いて、寄ったことにならない
      { lat: cand.station.lat, lon: cand.station.lon, type: "break", search_filter: { max_road_class: "service_other" } },
      loc(points[i1])],
    costing,
    directions_type: "none",
  };
  let json;
  try { json = await ask(body); } catch (e) { json = null; }
  if (!json || !json.trip || !Array.isArray(json.trip.legs) || json.trip.legs.length < 2) return { ok: false };
  const extra = (json.trip.summary.length || 0) * 1000 - direct;
  if (!(extra < MAX_EXTRA_METERS)) return { ok: false, extraMeters: Math.round(extra) };
  const first = decode6(json.trip.legs[0].shape || "");
  const stop = first[first.length - 1];
  return { ok: true, extraMeters: Math.round(Math.max(0, extra)),
           stop: [Number(stop[0].toFixed(6)), Number(stop[1].toFixed(6))] };
}

/**
 * 休憩に寄る道の駅を、経路の順に返す。
 * @param points 経路の線 [[経度, 緯度], ...]
 * @param opts { intervalMinutes, durationSeconds, stepTimes, excludedRanges, baseUrl, costing, fetch, stations }
 * @returns [{ name, stop:[経度, 緯度], index, alongMeters, atSeconds, extraMeters }]
 */
async function restStopsAlongRoute(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const interval = Number(opts.intervalMinutes) * 60;
  const duration = Number(opts.durationSeconds);
  if (!(interval > 0) || !(duration > 0)) return [];
  const stations = opts.stations || load();
  const fetchImpl = opts.fetch || globalThis.fetch;
  const base = opts.baseUrl || process.env.VALHALLA_URL || "http://localhost:8002";
  const ask = opts.ask || (async (body) => {
    const res = await fetchImpl(`${base}/route`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.json();
  });
  const cum = cumulative(points);
  const secs = timeline(points, cum, duration, opts.stepTimes);
  const excluded = (opts.excludedRanges || []).filter((r) => Array.isArray(r) && r.length === 2);
  const allowed = (i) => !excluded.some(([a, b]) => i >= a && i <= b);
  const near = stationsNear(points, stations).filter((c) => allowed(c.index));
  const out = [];
  const lastAt = Math.max(0, duration - MIN_TAIL_SECONDS);
  let from = 0;
  for (;;) {
    const target = from + interval;
    if (target >= lastAt) break;
    const earliest = from + interval * WINDOW_EARLY;
    const pool = near.filter((c) => secs[c.index] >= earliest && secs[c.index] < lastAt
                                    && !out.some((o) => o.name === c.station.name));
    let picked = null;
    // ⚠️ 範囲を段々広げる。最後は「その先で最初に寄れる駅」（目標から遠くても、休憩が無いよりよい）
    for (const latest of [from + interval * WINDOW_LATE, from + interval * WINDOW_LATER, Infinity]) {
      const cands = pool
        .filter((c) => secs[c.index] <= latest)
        .sort(latest === Infinity
          ? (a, b) => secs[a.index] - secs[b.index] || a.offMeters - b.offMeters
          : (a, b) => Math.abs(secs[a.index] - target) - Math.abs(secs[b.index] - target) || a.offMeters - b.offMeters)
        .slice(0, MAX_TRIALS);
      for (const c of cands) {
        const r = await checkStop(points, cum, c, { ask, costing: opts.costing || "motorcycle" });
        if (r.ok) { picked = { c, r }; break; }
      }
      if (picked) break;
    }
    if (!picked) break;
    out.push({ name: picked.c.station.name, stop: picked.r.stop, index: picked.c.index,
               alongMeters: Math.round(cum[picked.c.index]), atSeconds: Math.round(secs[picked.c.index]),
               extraMeters: picked.r.extraMeters });
    // ⚠️ 次の休憩は、実際に寄ったところから数える
    from = secs[picked.c.index];
  }
  return out;
}

module.exports = {
  load, timeline, stationsNear, checkStop, restStopsAlongRoute,
  NEAR_METERS, WINDOW_EARLY, WINDOW_LATE, WINDOW_LATER, TRIAL_METERS, MAX_EXTRA_METERS, MIN_TAIL_SECONDS, MAX_TRIALS, FILE,
};
