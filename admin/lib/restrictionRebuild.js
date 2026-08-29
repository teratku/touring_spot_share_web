/**
 * restrictionRebuild.js
 *
 * 二普協由来の規制を、**JARTIC の候補で置き換えるための突き合わせ**。
 *
 * 【なぜ機械で決めないか（実測）】
 * ⚠️ **幾何の重なりだけでは決まらない。**
 *   ・片側だけ見ると誤る: 短い「市道」が長い「首都圏中央連絡自動車道」に
 *     **100%重なる**（区間が中に収まってしまうため）。
 *   ・両方向を見ると今度は正しいものが落ちる: 「日立有料道路」→「日立有料道路」が
 *     **順100% / 逆59%**。同じ道で、JARTIC 側の区間が長いだけ。
 * ⚠️ **名前は独立した手がかり。** ただし「市道」「県道」だけの総称は手がかりにならない。
 *
 * したがって、ここでやるのは**順位付けと注記**であって判定ではない。
 * ⚠️ **自動で昇格させないこと。** 1件ずつ人が地図で見て決める。
 */
"use strict";

const R = 6371000;
const rad = (x) => (x * Math.PI) / 180;

/** 2点の距離（メートル）。⚠️ 点は [経度, 緯度] */
function meters(a, b) {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const la = rad(a[1]), lb = rad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 点が多いと総当たりが重い。等間隔に間引く。
 *
 * ⚠️ **間引くのは「数える側」だけ**（`rankCandidates` を見ること）。相手側を
 *    full のまま照合するので、**点の数は速度の調整つまみで、精度には効かない**
 *    （25→5 に粗くしてもテストは通る）。相手側まで間引くと精度に直結する。
 */
function sampled(points, count = 25) {
  if (!Array.isArray(points) || !points.length) return [];
  const step = Math.max(1, Math.floor(points.length / count));
  return points.filter((_, i) => i % step === 0);
}

/** A の点のうち、B から `within` メートル以内にあるものの割合 */
function coverage(A, B, within = 60) {
  if (!A.length || !B.length) return 0;
  let hit = 0;
  for (const a of A) {
    let min = Infinity;
    for (const b of B) { const d = meters(a, b); if (d < min) min = d; if (min < within) break; }
    if (min < within) hit++;
  }
  return hit / A.length;
}

/**
 * ⚠️ **総称は手がかりにならない。** 「市道」同士が一致しても同じ道とは限らない
 */
const GENERIC_NAMES = new Set([
  "市道", "町道", "村道", "区道", "県道", "国道", "道道", "府道", "都道",
  "一般道", "その他の道路", "農道", "林道", "私道", "",
]);

/** 表記ゆれを均す。⚠️ 「一般国道23号線」と「国道23号」は同じもの */
function normalizeName(name) {
  return String(name || "")
    .replace(/[\s　]/g, "")
    .replace(/^一般/, "")
    .replace(/(号)線$/, "$1")
    .replace(/線$/, "");
}

/** 道路名が一致しているか。⚠️ 総称同士は一致とみなさない */
function sameRoadName(a, b) {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return false;
  if (GENERIC_NAMES.has(x) || GENERIC_NAMES.has(y)) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 見極めの段階。⚠️ どれも「確認せずに昇格してよい」という意味ではない */
const TIERS = { STRONG: "強い一致", REVIEW: "要確認", NONE: "候補なし" };

function tierOf(forward, backward, nameAgrees) {
  // ⚠️ 名前が一致していれば、区間の長さが違っても同じ道とみている
  //    （実測「日立有料道路」順100%/逆59%）
  if (nameAgrees && forward >= 0.5) return TIERS.STRONG;
  if (forward >= 0.6 && backward >= 0.6) return TIERS.STRONG;
  if (forward >= 0.6) return TIERS.REVIEW;
  return TIERS.NONE;
}

/**
 * 1件の登録済み規制に対して、JARTIC の候補を順位付けする。
 *
 * @param {{name:string, points:Array}} registered  points は [経度, 緯度] の配列
 * @param {Array} candidates                        JARTIC の候補
 * @returns {Array<{candidate, forward, backward, nameAgrees, tier}>} 上位から
 */
function rankCandidates(registered, candidates, opts = {}) {
  const within = opts.within || 60;
  const limit = opts.limit || 3;
  // ⚠️ **間引くのは数える側だけ。** 相手側まで間引くと解像度が落ちて、
  //    実際には重なっている道を取りこぼす（長い道ほどひどい）
  const aFull = (registered && registered.points) || [];
  const A = sampled(aFull);
  if (!A.length) return [];

  const out = [];
  for (const c of candidates || []) {
    const bFull = c.points || [];
    if (!bFull.length) continue;
    const forward = coverage(A, bFull, within);
    // 重ならないものに逆向きを計算しない（総当たりが重い）。
    // ⚠️ **速さのためだけ。** この行を外しても答えは変わらない（下の tier で落ちる）
    if (forward < 0.3) continue;
    const backward = coverage(sampled(bFull), aFull, within);
    const nameAgrees = sameRoadName(registered.name, c.name || c.sourceRoad);
    const tier = tierOf(forward, backward, nameAgrees);
    if (tier === TIERS.NONE) continue;
    out.push({ candidate: c, forward, backward, nameAgrees, tier });
  }
  // 名前が一致するものを先に、次に重なりの小さいほうが大きい順
  out.sort((a, b) =>
    (b.nameAgrees - a.nameAgrees) ||
    (Math.min(b.forward, b.backward) - Math.min(a.forward, a.backward)));
  return out.slice(0, limit);
}

module.exports = {
  meters, sampled, coverage, normalizeName, sameRoadName,
  rankCandidates, tierOf, TIERS, GENERIC_NAMES,
};
