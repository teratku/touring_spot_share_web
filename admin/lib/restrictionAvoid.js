/**
 * restrictionAvoid.js
 *
 * **引いた経路が二輪の通行規制に掛かっていないか**を見て、掛かっていれば
 * その場所を `exclude_polygons` で塞ぐための形を作る（純ロジック。通信はしない）。
 *
 * 【なぜ「引いてから」なのか】
 * ⚠️ **`exclude_polygons` は周囲の合計に上限がある**（Valhalla の
 *    `max_exclude_polygons_length`、既定 10,000m）。船を避けるときに実際に踏んだ:
 *    ±0.005度の四角3個で「Exceeded maximum circumference」になる。
 *    県内の規制を全部渡すことはできない（神奈川だけで登録済み27件＋JARTIC21件）。
 *    **引いた経路に実際に掛かったものだけ塞ぐ**なら、たいてい0〜数件で収まる。
 *
 * ⚠️ 上限は設定で変えられる（自前の Valhalla なので）。ただし上げると
 *    Valhalla が全部の辺を全部の多角形と突き合わせることになるので、
 *    **まず「当たったものだけ」で足りるか確かめること。**
 *
 * 【時間・曜日を見る】
 * ⚠️ **おすすめ道路の一覧づくりとは判断が違う。** あちらは時刻を持たないので
 *    「全員が・いつでも通れない」ものだけ落とす（`restrictionOverlap.blocksAlways`）。
 *    こちらは**いつ走るかが分かっている**ので、その時刻に効いている規制を避ける。
 *    実測: JARTIC の候補1,442件のうち388件が時間つき。千葉の通学路規制
 *    「07:00〜08:00」のように、時間を見ないと避けすぎ・避けなさすぎになる。
 */
"use strict";

const { findOverlaps, appliesToRange, BLOCKING_KINDS } = require("./restrictionOverlap");
const { isActiveAt } = require("./restrictionTime");
const { decode } = require("./polyline");

/**
 * 排気量の区分 → 範囲。
 * ⚠️ アプリの `BikeDisplacement.ccRange` と同じ（`BikeProfile.swift`）。
 *    片方だけ変えると、避ける道が食い違う。
 */
const DISPLACEMENT_CC = {
  moped50:   [0, 50],
  small125:  [51, 125],
  medium250: [126, 250],
  large:     [251, 99_999],
};

/** 規制の線をどれだけ膨らませて塞ぐか。⚠️ 大きくすると上限にすぐ当たる */
const BUFFER_METERS = 25;

/**
 * その乗り手が、その時刻に通れない規制だけを選ぶ。
 *
 * @param {Array}  restrictions `data/road-restrictions/<romaji>.json` の `restrictions`
 * @param {object} opts { displacement, at, isHoliday }
 *   `at` を渡さなければ**時間の判断をしない**（＝時間指定のあるものも対象に含める）。
 *   ⚠️ 走る時刻が分からないのに「いまは通れる」と判断してはいけない。
 */
function applicable(restrictions, opts = {}) {
  const range = DISPLACEMENT_CC[opts.displacement] || null;
  const out = [];
  for (const r of restrictions || []) {
    if (!r || !BLOCKING_KINDS.has(r.kind)) continue;
    // ⚠️ 排気量が分からないときは絞らない（避けすぎより見落としのほうが危ない）
    if (range && !appliesToRange(r, range)) continue;
    if (opts.at && !isActiveAt(r, opts.at, { isHoliday: !!opts.isHoliday })) continue;
    const points = r.points || (r.polyline ? decode(r.polyline) : null);
    if (!points || points.length < 2) continue;
    out.push({ ...r, points });
  }
  return out;
}

/**
 * 引いた経路に掛かっている規制を返す。
 *
 * ⚠️ **判定は `restrictionOverlap.findOverlaps` を使い回す。** おすすめ道路の
 *    除外と同じ物差しにしておかないと、「一覧からは消えたのに経路は通る」
 *    「一覧には出るのに経路が避ける」という食い違いが起きる。
 *
 * @returns {Array} [{ id, name, kind, ratio, points }] 掛かっている順ではなく重なりの大きい順
 */
function hitsOnRoute(routePoints, restrictions, options = {}) {
  if (!Array.isArray(routePoints) || routePoints.length < 2) return [];
  const found = findOverlaps(restrictions, [{ id: "route", points: routePoints }], options);
  const hits = found.get("route") || [];
  const byId = new Map(restrictions.map((r) => [r.id, r]));
  return hits
    .map((h) => {
      const src = byId.get(h.restrictionId) || {};
      // ⚠️ **確認済みかどうかを落とさない。** 未確認（JARTIC の候補）を避けたのか、
      //    人が地図で見て登録したものを避けたのかは、見る側にとって意味が違う
      return { ...h, id: h.restrictionId, points: src.points, verified: src.verified !== false };
    })
    .filter((h) => h.points && h.points.length >= 2)
    .sort((a, b) => b.ratio - a.ratio);
}

/**
 * 線の上に、通せんぼの小さな四角を点々と置く。
 *
 * ⚠️ **線全体を包んではいけない。** 最初そうしたら、10km級の規制（芦ノ湖スカイライン）で
 *    周囲が **21,700m** になり、上限10,000mを超えて**まるごと捨てられた**（塞げていない）。
 * ⚠️ **道を通れなくするのに、道全体を塞ぐ必要はない。** 1点塞げばそこは通れない。
 *    ただし1点だけだと、その手前で入って手前で出る経路が残るので、
 *    **一定の間隔で点々と置く**。25m四方なら1個あたり周囲200mで、
 *    10km級の規制でも 10個 × 200m = 2,000m に収まる。
 * ⚠️ **四角は小さく保つこと。** 大きくすると規制されていない交差道路まで巻き込む。
 */
const BLOCK_EVERY_METERS = 1_000;

function boxesAround(points, bufferMeters = BUFFER_METERS, everyMeters = BLOCK_EVERY_METERS) {
  const spots = spotsAlong(points, everyMeters);
  const dLat = bufferMeters / 110_540;
  return spots.map(([lng, lat]) => {
    const dLng = bufferMeters / (111_320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    const a = [lng - dLng, lat - dLat];
    const b = [lng + dLng, lat - dLat];
    const c = [lng + dLng, lat + dLat];
    const d = [lng - dLng, lat + dLat];
    return [a, b, c, d, a];
  });
}

/** 線の上に、おおよそ `everyMeters` ごとの点を取る。⚠️ 端は避ける（交差点に掛かりやすい） */
function spotsAlong(points, everyMeters) {
  const total = lengthOf(points);
  if (total <= 0) return [points[0]];
  const count = Math.max(1, Math.round(total / everyMeters));
  const out = [];
  for (let i = 0; i < count; i++) {
    // ⚠️ 端ではなく、区切りの真ん中を取る。端は他の道との接続点になりやすい
    out.push(pointAt(points, total * (i + 0.5) / count));
  }
  return out;
}

function lengthOf(points) {
  let t = 0;
  for (let i = 1; i < points.length; i++) t += metersBetween(points[i - 1], points[i]);
  return t;
}

function pointAt(points, along) {
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const step = metersBetween(points[i - 1], points[i]);
    if (run + step >= along) {
      const t = step > 0 ? (along - run) / step : 0;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
              points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
    }
    run += step;
  }
  return points[points.length - 1];
}

function metersBetween(a, b) {
  const dLat = (b[1] - a[1]) * 110_540;
  const dLng = (b[0] - a[0]) * 111_320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

/** 環の周囲（m）。⚠️ Valhalla の上限に収まるかを、渡す前に自分で確かめるため */
function perimeterOf(ring) {
  let total = 0;
  for (let i = 1; i < ring.length; i++) total += metersBetween(ring[i - 1], ring[i]);
  return total;
}

/**
 * 掛かっている規制から、Valhalla に渡す多角形を作る。
 *
 * ⚠️ **上限に収まるぶんだけ返すこと。** 超えると Valhalla は
 *    「Exceeded maximum circumference for exclude_polygons」で**経路ごと失敗する**。
 *    一部しか渡せなかったことは呼び出し側へ返し、黙って落とさない。
 *
 * @returns {{polygons: Array, used: Array, skipped: Array, perimeter: number}}
 */
function excludePolygonsFor(hits, options = {}) {
  const budget = options.maxPerimeterMeters ?? 10_000;
  const buffer = options.bufferMeters ?? BUFFER_METERS;
  const polygons = [];
  const used = [];
  const skipped = [];
  let perimeter = 0;

  for (const hit of hits) {
    const rings = boxesAround(hit.points, buffer);
    const cost = rings.reduce((a, r) => a + perimeterOf(r), 0);
    if (perimeter + cost > budget) { skipped.push({ ...hit, perimeter: cost }); continue; }
    polygons.push(...rings);
    perimeter += cost;
    used.push({ ...hit, perimeter: cost });
  }
  return { polygons, used, skipped, perimeter: Math.round(perimeter) };
}

module.exports = {
  applicable, hitsOnRoute, excludePolygonsFor, boxesAround, perimeterOf,
  DISPLACEMENT_CC, BUFFER_METERS, BLOCK_EVERY_METERS, spotsAlong,
};
