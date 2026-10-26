/**
 * roadPaceCalc.js
 *
 * 走行の点（位置と時刻）から、おすすめ道路ごとの走りの速さを要約する（純ロジック）。
 * アプリの `RoadPace.summarize` / `RoadPace.rides` と `NavRecommendedSpans.spans` を写したもの。
 *
 * ⚠️ 利用者の判断（2026-10-26）:「投稿しているルートデータは取得して PC で計算できるようにしたい」
 *    「バックアップしているデータからも」→ `buildRoadPaceOffline.js` がこれで計算する。
 * ⚠️ **アプリと同じ答えにすること。** 片方だけ直すと、アプリから届いた回と PC で計算した回の物差しがずれる。
 *    test/roadPaceCalc.test.js がアプリの RoadPaceTests と同じ例で見ている
 */
"use strict";

const STOP_KMH = 5;
const STOP_MIN_SECONDS = 10;
const MAX_GAP_SECONDS = 30;
const MAX_PLAUSIBLE_KMH = 200;
const MIN_KM = 1.0;
const MIN_MOVING_SECONDS = 60;
/** 道の線からこれ以内なら「その道を走っている」・これだけ続けて走ったら当たり（NavRecommendedSpans） */
const NEAR_METERS = 30;
const MIN_RUN_METERS = 300;

const M = 111_320;

/** 2点の距離（m）。アプリの NavGeometry.distance と同じ平面近似 */
function distance(a, b) {
  const latMid = (a.lat + b.lat) * 0.5 * Math.PI / 180;
  const dLat = (b.lat - a.lat) * M;
  const dLng = (b.lng - a.lng) * M * Math.cos(latMid);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** RoadRestrictionMatcher.roughDistance と同じ */
function roughDistance(a, b) {
  const dLat = (a.lat - b.lat) * M;
  const dLng = (a.lng - b.lng) * M * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function distanceToSegment(p, a, b) {
  const scale = Math.cos(p.lat * Math.PI / 180);
  const px = (p.lng - a.lng) * scale * M, py = (p.lat - a.lat) * M;
  const ex = (b.lng - a.lng) * scale * M, ey = (b.lat - a.lat) * M;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return Math.sqrt(px * px + py * py);
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / len2));
  return Math.hypot(px - t * ex, py - t * ey);
}

function distanceToLine(p, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, distanceToSegment(p, line[i - 1], line[i]));
    if (best < 1) break;
  }
  return best;
}

function bounds(line) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of line) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  return { minLat, maxLat, minLng, maxLng };
}

function boxContains(box, p, margin) {
  const dLat = margin / M, dLng = margin / (M * Math.cos(p.lat * Math.PI / 180));
  return p.lat >= box.minLat - dLat && p.lat <= box.maxLat + dLat && p.lng >= box.minLng - dLng && p.lng <= box.maxLng + dLng;
}

/** 経路のうち、道の上を続けて走った範囲（点の番号・両端を含む）。NavRecommendedSpans.spans と同じ */
function spans(route, roads) {
  const lines = roads.filter((l) => l.length >= 2);
  if (route.length < 2 || !lines.length) return [];
  const boxes = lines.map(bounds);
  const out = [];
  let start = null, run = 0;
  const close = (end) => {
    if (start !== null && end > start && run >= MIN_RUN_METERS) out.push([start, end]);
    start = null; run = 0;
  };
  for (let i = 0; i < route.length; i++) {
    const p = route[i];
    const onRoad = lines.some((l, k) => boxContains(boxes[k], p, NEAR_METERS) && distanceToLine(p, l) <= NEAR_METERS);
    if (onRoad) {
      if (start === null) start = i; else run += roughDistance(route[i - 1], p);
    } else {
      close(i - 1);
    }
  }
  close(route.length - 1);
  return out;
}

/** 時間の重み付きの分位点 */
function percentile(speeds, q) {
  const sorted = speeds.slice().sort((a, b) => a.kmh - b.kmh);
  const total = sorted.reduce((s, x) => s + x.seconds, 0);
  if (total <= 0) return 0;
  let acc = 0;
  for (const s of sorted) { acc += s.seconds; if (acc >= total * q) return s.kmh; }
  return sorted[sorted.length - 1].kmh;
}

/**
 * 点（{lat, lng, t: ミリ秒}）の範囲を要約する。RoadPace.summarize と同じ。短すぎれば null
 * @returns {{km, kmh, p85, stops, stopPct}|null}
 */
function summarize(points, ranges) {
  let meters = 0, moving = 0, stopped = 0, stops = 0, stopRun = 0;
  const speeds = [];
  for (const [lo, hi] of ranges) {
    if (lo < 0 || hi >= points.length) continue;
    stopRun = 0;
    for (let i = lo; i < hi; i++) {
      const a = points[i], b = points[i + 1];
      const dt = (b.t - a.t) / 1000;
      if (!(dt > 0) || dt > MAX_GAP_SECONDS) { stopRun = 0; continue; }
      const d = distance(a, b);
      const kmh = d / dt * 3.6;
      if (kmh > MAX_PLAUSIBLE_KMH) continue;
      if (kmh < STOP_KMH) {
        stopped += dt;
        if (stopRun < STOP_MIN_SECONDS && stopRun + dt >= STOP_MIN_SECONDS) stops += 1;
        stopRun += dt;
      } else {
        stopRun = 0;
        moving += dt;
        meters += d;
        speeds.push({ kmh, seconds: dt });
      }
    }
  }
  if (meters / 1000 < MIN_KM || moving < MIN_MOVING_SECONDS) return null;
  return {
    km: Math.round(meters / 100) / 10,
    kmh: Math.round(meters / moving * 3.6),
    p85: Math.round(percentile(speeds, 0.85)),
    stops,
    stopPct: Math.round(stopped / (stopped + moving) * 100),
  };
}

/**
 * 走ったおすすめ道路ごとの要約。
 * @param points [{lat, lng, t}]
 * @param roads [{id, name, lines: [[{lat,lng}]]}]（roads-lib の grouped の道の線を解いたもの）
 * @returns {Object<string, {name, ride}>}
 */
function ridesOnRoads(points, roads) {
  if (points.length < 2) return {};
  const box = bounds(points);
  const out = {};
  for (const road of roads) {
    if (!road.lines.some((l) => l.some((p) => boxContains(box, p, 50)))) continue;
    const ranges = spans(points, road.lines);
    if (!ranges.length) continue;
    const ride = summarize(points, ranges);
    if (ride) out[road.id] = { name: road.name, ride };
  }
  return out;
}

/** アプリが送るのと同じ形の1回分（日は年-月まで） */
function ridePayload(ride, cc, atMs, source) {
  const d = new Date(atMs);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { ym, km: ride.km, kmh: ride.kmh, p85: ride.p85, stops: ride.stops, stopPct: ride.stopPct, cc, src: source };
}

/** 記録の JSON（{routePoints:[{latitude, longitude, timestamp}]} か点の並び）を点に。時刻の無い点は捨てる */
function pointsFromRouteJson(json) {
  const list = Array.isArray(json) ? json : (json && json.routePoints) || [];
  const out = [];
  for (const p of list) {
    if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    let t = NaN;
    if (typeof p.timestamp === "string") t = Date.parse(p.timestamp);
    // ⚠️ Swift の既定の日付は 2001-01-01 からの秒
    else if (Number.isFinite(p.timestamp)) t = (p.timestamp + 978_307_200) * 1000;
    if (!Number.isFinite(t)) continue;
    out.push({ lat: p.latitude, lng: p.longitude, t });
  }
  return out.sort((a, b) => a.t - b.t);
}

module.exports = { summarize, spans, ridesOnRoads, ridePayload, pointsFromRouteJson, distance };
