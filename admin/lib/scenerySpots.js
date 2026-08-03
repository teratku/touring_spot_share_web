/**
 * scenerySpots.js
 *
 * 投稿スポットの密度から「景色の良さ」を見積もる。
 *
 * 【なぜ要るのか】
 * 曲率だけで並べると、眺望のないワインディングが上位に来て、
 * 絶景ロードが埋もれる。群馬の実測でそれがはっきり出た:
 *
 *   志賀草津道路   スポット11件 / 曲率 496（150区間中で中位）
 *   万座道路       スポット 9件 / 曲率 822
 *   国道254号      スポット 0件 / 曲率1019（曲率1位）
 *
 * 曲率とスポット数の相関は r=+0.21 しかない。
 * つまりスポット密度は**曲率では拾えない情報**を持っている。
 *
 * ⚠️ 加点だけにすること。減点してはいけない。
 *    スポットがあるのは全区間の30%だけで、平均0.6件と**データが疎**。
 *    「スポットが多い＝景色が良い」は言えるが、
 *    「0件＝景色が悪い」は言えない（誰もまだ走っていないだけかもしれない）。
 *    減点にすると、単に人が行っていない良い道を不当に沈めてしまう。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { distanceMeters } = require("./roadCsv");

/** スポットがこの距離以内にあれば「その道から見える景色」とみなす（m） */
const SPOT_RADIUS_METERS = 3000;

/** 区間上にサンプル点を置く間隔（m）。長い区間を端点だけで判定しないため */
const SAMPLE_INTERVAL_METERS = 1000;

/** これだけスポットがあれば満点の加点。実測の最大が11件だったので10に置く */
const SATURATION_SPOTS = 10;

/**
 * 景色の加点の上限（100点満点のスコアに対して）。
 *
 * 実測での効き方（群馬）:
 *   万座道路     83.0 → 92.5（スポット9件）
 *   志賀草津道路 75.0 → 85.0（スポット11件・曲率は中位）
 *   国道254号    84.0 → 84.0（スポット0件・曲率1位）
 * 絶景ロードが曲率1位の道と並ぶくらい。効きすぎず、埋もれもしない。
 */
const MAX_BONUS = 10;

/**
 * スポットの座標を読む。
 *
 * 無ければ空で返す。**景色の加点が無いだけで生成は通る**ようにしてある
 * （スポットの取得に失敗しても、おすすめ道路の生成は止めない）。
 *
 * @returns {[number, number][]} [lon, lat] の配列（roadCsv と同じ並びに揃える）
 */
function loadSpots(file = path.join(__dirname, "..", "data", "spots.json")) {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.spots || [];
    return list
      .map((s) => (Array.isArray(s) ? s : [s.lng, s.lat]))
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  } catch {
    return [];
  }
}

/**
 * 総当たりを避けるための粗い格子。
 * 全国600件程度なら総当たりでも足りるが、区間数×スポット数は簡単に増えるので index を作る。
 */
function buildIndex(spots, cellDegrees = 0.05) {
  const cells = new Map();
  const key = (lon, lat) =>
    `${Math.floor(lon / cellDegrees)}_${Math.floor(lat / cellDegrees)}`;
  for (const p of spots) {
    const k = key(p[0], p[1]);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  return { cells, cellDegrees, key };
}

/** 半径内に入りうるセルだけを見る */
function nearbySpots(index, point) {
  const span = Math.ceil(
    SPOT_RADIUS_METERS / (index.cellDegrees * 111320)
  );
  const cx = Math.floor(point[0] / index.cellDegrees);
  const cy = Math.floor(point[1] / index.cellDegrees);
  const found = [];
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      const list = index.cells.get(`${cx + dx}_${cy + dy}`);
      if (list) found.push(...list);
    }
  }
  return found;
}

/**
 * 区間の近くにある投稿スポットの数を数える。
 *
 * 区間に沿って一定間隔でサンプル点を置き、そのいずれかの近くにあるスポットを数える。
 * ⚠️ 同じスポットを何度も数えないこと（長い区間ほど有利になってしまう）。
 *
 * @param {[number, number][]} points 区間のジオメトリ（[lon, lat]）
 * @param {object} index buildIndex() の結果
 */
function countNearbySpots(points, index) {
  if (!points || points.length < 2 || index.cells.size === 0) return 0;

  const samples = sampleAlong(points, SAMPLE_INTERVAL_METERS);
  const seen = new Set();
  for (const s of samples) {
    for (const spot of nearbySpots(index, s)) {
      const id = `${spot[0]},${spot[1]}`;
      if (seen.has(id)) continue;
      if (distanceMeters(s, spot) <= SPOT_RADIUS_METERS) seen.add(id);
    }
  }
  return seen.size;
}

/** 道なりに等間隔でサンプル点を取る（両端は必ず含める） */
function sampleAlong(points, interval) {
  const out = [points[0]];
  let carried = 0;
  for (let i = 1; i < points.length; i++) {
    const d = distanceMeters(points[i - 1], points[i]);
    carried += d;
    if (carried >= interval) {
      out.push(points[i]);
      carried = 0;
    }
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * スポット数を加点に変える。
 * 対数で頭打ちにする（1件目の価値が大きく、10件と11件の差は小さい）。
 */
function sceneryBonus(spotCount) {
  if (!Number.isFinite(spotCount) || spotCount <= 0) return 0;
  const ratio = Math.log1p(spotCount) / Math.log1p(SATURATION_SPOTS);
  return MAX_BONUS * Math.min(1, ratio);
}

module.exports = {
  loadSpots,
  buildIndex,
  countNearbySpots,
  sceneryBonus,
  SPOT_RADIUS_METERS,
  SAMPLE_INTERVAL_METERS,
  SATURATION_SPOTS,
  MAX_BONUS,
};
