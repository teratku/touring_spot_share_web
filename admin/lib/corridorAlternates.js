/**
 * corridorAlternates.js
 *
 * **道筋の違う候補**を探す（Google マップの「別のルート」のように、別の幹線を通る案）。
 *
 * ⚠️ 利用者の要望（2026-09-28）:「ルート生成で google map みたいなルートも生成できるといいな。
 *    現状254号線以降は全く違いがない」。赤城大沼→新座で、Valhalla の代替（251cc以上）は2本とも
 *    国道254号・川越を通り、本命との重なり50〜64%。Google は国道17号・上尾を通る案（+8%）を出す。
 * ⚠️ 利用者の判断: 候補画面の「別の道筋を探す」を押したときだけ探す（最初の表示は今の速さのまま）。
 *
 * 【作り方（実測で決めた）】
 *   本命の中ほど〜後半（50・65・80%）から左右に10・15km 離した点を、国道・主要地方道（primary〜trunk）に
 *   乗せ、通るだけの点にして引く。時間が本命の1.25倍以内・Uターンが本命より多くない・本命から離れて続けて
 *   走る区間が本命の2割以上のものから、**離れて走る区間がゴール寄りまで続くもの**を先に最大2本
 *   （互いに6割以上重なるものは1本に）。
 * ⚠️ **重なりの割合（経路全体）で選ばないこと。** 前半だけ違って後半で本命に戻る案が「別の道筋」に
 *    見えてしまう。赤城大沼→新座で、35%地点からずらした案は重なり34〜47% でも本命の79%地点（川越・254号）
 *    から先が同じだった＝利用者の不満そのもの。17号・上尾の案（65%地点から東へ）は49〜94% を別の道で走る。
 * ⚠️ 前半の違いは Valhalla の代替で既に出る（赤城大沼→新座の代替2など）。ずらすのは中ほど〜後半
 * ⚠️ **塞いで引き直す案は駄目だった。** 本命の中ほどを塞ぐと脇を小さく回り込むだけで（重なり49〜75%）、
 *    塞ぐ範囲を広げると `exclude_polygons` の周の上限（10km）に当たって引けない。
 * ⚠️ 立ち寄り先があるときは使わない（区間ごとに道筋を変えることになり、組み合わせが増える）。
 */
"use strict";

const { distanceToLine } = require("./restrictionOverlap");

/** 本命のどこから横へずらすか（道のりの割合） */
const FRACTIONS = [0.5, 0.65, 0.8];
/** 横へずらす距離（km） */
const OFFSETS_KM = [10, 15];
/** 本命の何倍までの時間なら候補にするか */
const MAX_TIME_RATIO = 1.25;
/** 本命から離れて続けて走る区間が、本命の道のりのこれ未満なら「同じ道筋」 */
const MIN_AWAY_SHARE = 0.2;
/** 候補どうしがこれ以上重なるなら1本にまとめる */
const MAX_MUTUAL_OVERLAP = 0.6;
/** 返す本数 */
const MAX_RESULTS = 2;
/** 一度に引く本数（Valhalla を詰まらせない） */
const CONCURRENCY = 4;
/** 幹線を探す半径（m） */
const SNAP_RADIUS_METERS = 3000;
/** 線から、これ以内の点を「重なっている」とみなす（m）。離れて走る区間もこれで測る */
const OVERLAP_NEAR_METERS = 30;
/** 重なりを測るとき、点をこれだけおきに見る（m） */
const OVERLAP_STEP_METERS = 200;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const meters = (a, b) => {
  const la1 = rad(a[1]), la2 = rad(b[1]);
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};
function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function pointFrom([lng, lat], degrees, m) {
  const R = 6_371_000, d = m / R, br = rad(degrees), la1 = rad(lat), lo1 = rad(lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [deg(lo2), deg(la2)];
}

/** 線の道のりの割合 `frac` の点と、そこでの向き（前後1km ほどで測る） */
function pointAlong(points, frac) {
  if (!points || points.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + meters(points[i - 1], points[i]));
  const target = cum[cum.length - 1] * frac;
  let i = cum.findIndex((c) => c >= target);
  if (i < 0) i = points.length - 1;
  const back = cum.findIndex((c) => c >= target - 1000);
  const ahead = cum.findIndex((c) => c >= target + 1000);
  const a = points[Math.max(0, back)], b = points[ahead < 0 ? points.length - 1 : ahead];
  return { point: points[i], bearing: bearing(a, b) };
}

/** 横へずらす点の一覧（割合 × 左右 × 距離） */
function offsetPoints(points) {
  const out = [];
  for (const frac of FRACTIONS) {
    const at = pointAlong(points, frac);
    if (!at) continue;
    for (const side of [-1, 1]) {
      for (const km of OFFSETS_KM) {
        out.push({ frac, side, km, point: pointFrom(at.point, at.bearing + 90 * side, km * 1000) });
      }
    }
  }
  return out;
}

/** `a` の点（`OVERLAP_STEP_METERS` おき）のうち、`b` の線から `OVERLAP_NEAR_METERS` 以内にある割合 */
function overlapRatio(a, b) {
  if (!a || a.length < 2 || !b || b.length < 2) return 0;
  let walked = OVERLAP_STEP_METERS, n = 0, near = 0;
  for (let i = 0; i < a.length; i++) {
    if (i > 0) walked += meters(a[i - 1], a[i]);
    if (walked < OVERLAP_STEP_METERS && i !== a.length - 1) continue;
    walked = 0;
    n++;
    if (distanceToLine(a[i], b) <= OVERLAP_NEAR_METERS) near++;
  }
  return n ? near / n : 0;
}

/**
 * `a` が `b` の線から離れて続けて走る一番長い区間。
 * @returns `{ meters, endShare }` 長さ（m）と、その区間が `a` のどこで終わるか（道のりの割合）
 */
function longestAway(a, b) {
  if (!a || a.length < 2 || !b || b.length < 2) return { meters: 0, endShare: 0 };
  const steps = [];
  let total = 0;
  for (let i = 1; i < a.length; i++) { const m = meters(a[i - 1], a[i]); steps.push(m); total += m; }
  let best = 0, run = 0, walked = 0, bestEnd = 0, walkedSinceCheck = OVERLAP_STEP_METERS, away = false;
  for (let i = 1; i < a.length; i++) {
    walked += steps[i - 1];
    walkedSinceCheck += steps[i - 1];
    // ⚠️ 点ごとに測ると長い経路で重い。`OVERLAP_STEP_METERS` おき（と最後）に測り、あいだは前の判定のまま
    if (walkedSinceCheck >= OVERLAP_STEP_METERS || i === a.length - 1) {
      walkedSinceCheck = 0;
      away = distanceToLine(a[i], b) > OVERLAP_NEAR_METERS;
    }
    if (away) {
      run += steps[i - 1];
      if (run > best) { best = run; bestEnd = walked; }
    } else run = 0;
  }
  return { meters: best, endShare: total ? bestEnd / total : 0 };
}

/**
 * 引いた候補から、返すものを選ぶ（純ロジック）。
 * @param main 本命 `{ points, durationSeconds, uTurns }`
 * @param candidates `[{ route, via }]`
 * @returns `[{ route, via, timeRatio, overlap, awayMeters, awayEndShare }]`
 *   （離れて走る区間がゴール寄りまで続く順・同じなら速い順・最大 MAX_RESULTS 本）
 */
function pickDistinct(main, candidates) {
  const scored = [];
  const mainMeters = main.lengthMeters || 0;
  for (const c of candidates) {
    const r = c.route;
    if (!r || r.error || !Array.isArray(r.points) || r.points.length < 2) continue;
    const timeRatio = r.durationSeconds / main.durationSeconds;
    if (!(timeRatio <= MAX_TIME_RATIO)) continue;
    if ((r.uTurns || 0) > (main.uTurns || 0)) continue;
    const away = longestAway(r.points, main.points);
    if (!(away.meters >= MIN_AWAY_SHARE * mainMeters)) continue;
    scored.push({ ...c, timeRatio, overlap: overlapRatio(r.points, main.points),
                  awayMeters: Math.round(away.meters), awayEndShare: away.endShare });
  }
  // ⚠️ ゴール寄りまで別の道を走るものを先に（0.05刻みで同じとみなし、速い方を先に）
  const band = (x) => Math.round(x.awayEndShare / 0.05);
  scored.sort((x, y) => band(y) - band(x) || x.timeRatio - y.timeRatio);
  const picked = [];
  for (const c of scored) {
    if (picked.some((p) => overlapRatio(c.route.points, p.route.points) > MAX_MUTUAL_OVERLAP
                         || overlapRatio(p.route.points, c.route.points) > MAX_MUTUAL_OVERLAP)) continue;
    picked.push(c);
    if (picked.length >= MAX_RESULTS) break;
  }
  return picked;
}

/** 一度に `limit` 本ずつ走らせる */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = { error: e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 道筋の違う候補を探す。
 * @param deps.routeFn  `(from, to, opts) => 経路`（`routeWithValhallaSegmented`）
 * @param deps.locateFn `(point, costing) => [経度, 緯度] | null`（幹線の上に乗せる）
 * @param opts 本命と同じ条件（`routeOptionsFromBody`）。⚠️ 立ち寄り先が無いこと
 * @returns `{ main, alternates: [{ route, via, timeRatio, overlap }], tried }`
 */
async function corridorAlternates(from, to, opts, { routeFn, locateFn }) {
  const main = await routeFn(from, to, opts);
  if (!main || main.error || !Array.isArray(main.points) || main.points.length < 2) {
    return { main, alternates: [], tried: 0 };
  }
  const offsets = offsetPoints(main.points);
  const tried = await mapLimited(offsets, CONCURRENCY, async (o) => {
    const via = await locateFn(o.point, main.costing);
    if (!via) return null;
    // ⚠️ **通るだけの点にする**（止まる場所にしない。着いたと言わない・その場で折り返さない）
    const route = await routeFn(from, to, { ...opts, vias: [via], stopAt: [], throughStopAt: [], viaHeadings: [] });
    return { route, via, ...o };
  });
  const candidates = tried.filter(Boolean);
  return { main, alternates: pickDistinct(main, candidates), tried: candidates.length };
}

/**
 * Valhalla の `/locate` で、点の近くの国道・主要地方道（primary〜trunk）に乗せる。
 * ⚠️ その乗り手が通れる道だけ（costing を渡す）。見つからなければ null
 */
function makeLocate(baseUrl) {
  return async (point, costing) => {
    const res = await fetch(`${baseUrl}/locate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ costing, verbose: false, locations: [{ lon: point[0], lat: point[1], radius: SNAP_RADIUS_METERS,
        search_filter: { min_road_class: "primary", max_road_class: "trunk" } }] }),
    });
    const json = await res.json();
    const edge = json && json[0] && json[0].edges && json[0].edges[0];
    return edge ? [edge.correlated_lon, edge.correlated_lat] : null;
  };
}

module.exports = {
  corridorAlternates, pickDistinct, offsetPoints, pointAlong, overlapRatio, longestAway, makeLocate,
  FRACTIONS, OFFSETS_KM, MAX_TIME_RATIO, MIN_AWAY_SHARE, MAX_MUTUAL_OVERLAP, MAX_RESULTS, CONCURRENCY,
  SNAP_RADIUS_METERS, OVERLAP_NEAR_METERS,
};
