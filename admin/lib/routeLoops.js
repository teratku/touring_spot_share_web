"use strict";
/**
 * 無駄な輪（小道に入って、ぐるっと回って元の場所へ戻ってくる形）を見つける。
 *
 * ⚠️ **形だけでは判断できない。** 峠のヘアピンは、まったく同じ形に見える
 *    （60m以内を200m走って通り過ぎる）。実測でこれらは見分けられなかった:
 *      ・輪の大きさ           … ヘアピン200〜800m / 無駄も200〜800m
 *      ・おすすめ道路の上か   … 普通の山道のヘアピンが「上に無い」と出る
 *      ・入口と出口の向きの差 … ヘアピン0〜176度 / 無駄141〜171度（重なる）
 *
 * ⚠️ **見分けられるのは「近道があるか」だけ。** 輪の入口から出口へ直接引いてみる。
 *    実測（高崎→草津・甲府→富士吉田の輪 22本）:
 *      ・ヘアピン … 直接引いても **0.99〜1.00倍**（近道が無い＝その道しかない）
 *      ・無駄な輪 … **0.00倍**（8,858mの輪に対し、直接なら36m）
 *    間には何も無い。確かめは1回 7〜13ms。
 */

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** [経度, 緯度] の2点間の距離（m） */
function distance(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(a[0] - b[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** これ以上走って元の場所へ戻るものを輪とみなす（m） */
const MIN_ALONG_METERS = 200;
/**
 * これより大きい輪は見ない（**経路そのものに対する割合**）。
 *
 * ⚠️ **固定の上限にしてはいけない。** 5,000m で切っていたため、実測
 *    （現在地→道の駅大滝温泉→広瀬ダム・442.6km）で **119.7kmの往復**が
 *    まったく見えていなかった（直接引けば0.1km＝ほぼ完全な無駄）。
 * ⚠️ **かといって上限を外してもいけない。** 出発と行き先が同じ「周回」の旅では、
 *    経路まるごとが1つの輪に見える。それを塞ぐと経路が壊れる。
 *    経路の半分までにしておけば、周回そのものは拾わない。
 */
const MAX_ALONG_RATIO = 0.5;
/**
 * 帯の区切り（m）。
 *
 * ⚠️ **一度にまとめて数えてはいけない。** 重なる輪をまとめると、
 *    大きい輪が中の小さい輪を飲み込む。実測: 26.9km の輪が中の
 *    小さな輪を全部飲み込み、画面に見えている輪が**1本も報告されなかった**。
 */
const BAND_EDGES = [200, 1_000, 3_000, 10_000, 50_000, 300_000];
/**
 * 1つの帯で確かめる本数の上限。
 *
 * ⚠️ **全体で切ってはいけない。** 40本を頭から取っていたため、小さい輪
 *    （実測: 200〜1,000mに38本のヘアピン）が枠を食い潰し、
 *    **119.7kmの往復が一度も確かめられなかった**。帯ごとに枠を分ける。
 * ⚠️ **大きいものから確かめる。** 無駄な往復は大きいほど害が大きい
 */
const MAX_PROBES_PER_BAND = 8;
/** 「元の場所」とみなす近さ（m）。⚠️ 広げすぎると並走する道を輪と誤る */
const MAX_SPATIAL_METERS = 60;
/** 直接引いた距離が輪の何倍未満なら無駄とみなすか */
const WASTE_RATIO = 0.5;
/** 確かめる本数の上限。⚠️ 1本 7〜13ms なので、増えても数百ms */
const MAX_PROBES = 40;
/**
 * 塞いで引き直す周回数の上限。
 *
 * ⚠️ **1回で終わらせないこと。** 塞ぐと経路が変わるので、塞いだ先に
 *    新しい輪ができる（実測・西まわり125.9km: 2本塞いだ後に1,002mと3,001mが出た）。
 * ⚠️ **際限なくやらないこと。** 1周につき経路を1本引き直す
 */
const MAX_ROUNDS = 3;

/**
 * 線が「走ってきた場所へ戻る」ところを拾う。
 * @returns {{begin:number, end:number, meters:number}[]} 重なるものはまとめて長い方を採る
 */
function loops(points, {
  minAlongMeters = MIN_ALONG_METERS,
  maxAlongMeters = Infinity,
  maxSpatialMeters = MAX_SPATIAL_METERS,
} = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + distance(points[i - 1], points[i]));
  }
  // 近い点だけを比べる（総当たりは重い）
  const cell = Math.max(maxSpatialMeters, 1);
  const mLat = 111320;
  const mLon = 111320 * Math.cos(toRad(points[0][1]));
  const key = (x, y) => `${Math.floor(x / cell)}_${Math.floor(y / cell)}`;
  const xs = [];
  const ys = [];
  const buckets = new Map();
  for (let k = 0; k < points.length; k++) {
    xs[k] = (points[k][0] - points[0][0]) * mLon;
    ys[k] = (points[k][1] - points[0][1]) * mLat;
    const kk = key(xs[k], ys[k]);
    if (!buckets.has(kk)) buckets.set(kk, []);
    buckets.get(kk).push(k);
  }
  const found = [];
  for (let i = 0; i < points.length; i++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(key(xs[i] + dx * cell, ys[i] + dy * cell)) || []) {
          if (j <= i) continue;
          const meters = cum[j] - cum[i];
          if (meters < minAlongMeters || meters > maxAlongMeters) continue;
          if (distance(points[i], points[j]) <= maxSpatialMeters) {
            found.push({ begin: i, end: j, meters });
          }
        }
      }
    }
  }
  if (!found.length) return [];
  found.sort((a, b) => a.begin - b.begin);
  // ⚠️ **重なったら「一番小さい」を残すこと。** 大きい方を残すと、
  //    中にある小さな輪が飲み込まれて報告されない（実測: 26.9kmの輪が全部飲んだ）
  const merged = [];
  for (const c of found) {
    const last = merged[merged.length - 1];
    if (last && c.begin <= last.end) {
      if (c.meters < last.meters) merged[merged.length - 1] = c;
    } else {
      merged.push(c);
    }
  }
  return merged;
}

/**
 * 帯ごとに数えて繋ぐ。
 *
 * ⚠️ 一度にまとめると大きい輪が小さい輪を飲み込む（`BAND_EDGES` 参照）。
 * ⚠️ **帯ごとに本数を切る。** 全体で切ると小さい輪が枠を食い潰す（`MAX_PROBES_PER_BAND`）。
 * @param {number} routeMeters 経路の全長。上限をこれに対する割合で決める
 */
function loopBands(points, routeMeters = Infinity, {
  edges = BAND_EDGES,
  perBand = MAX_PROBES_PER_BAND,
  maxRatio = MAX_ALONG_RATIO,
} = {}) {
  const 上限 = Number.isFinite(routeMeters) ? routeMeters * maxRatio : Infinity;
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const lo = edges[i];
    const hi = Math.min(edges[i + 1], 上限);
    if (hi <= lo) continue;
    const found = loops(points, { minAlongMeters: lo, maxAlongMeters: hi });
    // ⚠️ **大きいものから。** 枠に入りきらないとき、害の大きいほうを残す
    found.sort((a, b) => b.meters - a.meters);
    for (const l of found.slice(0, perBand)) out.push(l);
  }
  return out;
}

/**
 * 守る点を選ぶ。**利用者が置いた立ち寄り先だけ**。
 *
 * ⚠️ **おすすめ道路の中継点を混ぜないこと。** 混ぜると、消すべき往復が
 *    1本も残らない（実測: 野火止→オギノパンの5候補すべてで0本になった）。
 *    利用者の意図は「おすすめ道路は上りか下りのどちらか一度だけ通って、
 *    出口からそのまま進む」で、同じ道の反対車線を戻ってよいのは
 *    **立ち寄り先へ寄るときだけ**（実機で明言された）。
 * @param {number[]} stopAt `vias` のうち立ち寄り先の番号
 */
function viasToKeep(vias, stopAt) {
  const stops = new Set(Array.isArray(stopAt) ? stopAt : []);
  return (Array.isArray(vias) ? vias : []).filter((_, i) => stops.has(i));
}

/** 経由地が輪の中にあるとみなす近さ（m） */
const VIA_NEAR_METERS = 100;

/**
 * その輪の中に「通ってほしい」と指定された点があるか。
 *
 * ⚠️ **渡すのは「利用者が置いた立ち寄り先」だけにすること。**
 *    おすすめ道路の中継点まで渡すと、消すべき往復が1本も残らない
 *    （実測: 野火止→オギノパンの5候補すべてで0本になった）。
 *    利用者の意図は「おすすめ道路は一度だけ通って出口からそのまま進む」で、
 *    同じ道を戻ってよいのは**立ち寄り先へ寄るときだけ**。
 * ⚠️ 行って戻る形は折り返し地点で小さな輪に見え、幾何では無駄な回り道と
 *    区別できない（実測: 20kmの往復でも折り返しの200mが輪として出る）。
 */
function holdsVia(points, loop, vias, within = VIA_NEAR_METERS) {
  if (!Array.isArray(vias) || !vias.length) return false;
  for (let i = loop.begin; i <= loop.end && i < points.length; i++) {
    for (const via of vias) {
      if (!Array.isArray(via) || via.length < 2) continue;
      if (distance(points[i], via) <= within) return true;
    }
  }
  return false;
}

/**
 * 直接引いた距離から「無駄な輪か」を決める（純粋な判断）。
 *
 * @param {number} loopMeters   輪を走る距離
 * @param {number|null} directMeters 入口から出口へ直接引いた距離。引けなければ null
 */
function isWasteful(loopMeters, directMeters, ratio = WASTE_RATIO) {
  // ⚠️ **引けないときは無駄とみなさない。** 近道が無いということ
  if (directMeters == null || !Number.isFinite(directMeters)) return false;
  if (!(loopMeters > 0)) return false;
  return directMeters < loopMeters * ratio;
}

/**
 * 塞ぐ形（輪の中ほど）。
 *
 * ⚠️ **端は塞がないこと。** 輪の出入口は通り抜ける道の上にあるので、
 *    そこまで塞ぐと経路ごと引けなくなる
 */
function interiorOf(points, loop, edgeRatio = 0.15) {
  const slice = points.slice(loop.begin, loop.end + 1);
  const edge = Math.max(1, Math.floor(slice.length * edgeRatio));
  const inner = slice.slice(edge, slice.length - edge);
  return inner.length >= 2 ? inner : null;
}

module.exports = {
  loops, loopBands, isWasteful, interiorOf, holdsVia, viasToKeep, distance,
  MIN_ALONG_METERS, MAX_ALONG_RATIO, BAND_EDGES, MAX_PROBES_PER_BAND,
  MAX_SPATIAL_METERS, WASTE_RATIO, MAX_PROBES, MAX_ROUNDS, VIA_NEAR_METERS,
};
