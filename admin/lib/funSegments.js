/**
 * funSegments.js
 *
 * 連続した道路から「走って楽しい区間」を切り出して点数をつける。
 *
 * ⚠️ ここが「正」。アプリ側（RoadCurvinessScorer）にも似た計算が残っているが、
 *    そちらは配信が取れなかったときのフォールバック専用。
 *    重みや閾値を変えるときはここだけを直す。
 */
"use strict";

const { profile } = require("./polyline");

// ---- 区間の切り出し ----

const EXTRACT = {
  /** 局所曲率を測る窓の長さ（m） */
  windowMeters: 1000,
  /** これを超える曲率（度/km）の窓を「楽しい」とみなす */
  curvinessThreshold: 90,
  /** これより短い直線で分断されているだけなら繋ぐ（m）。峠が細切れにならないように */
  bridgeMeters: 1000,
  /** 短すぎる区間は出さない（m） */
  minMeters: 3000,
  /** 長すぎる区間は一番良いところで切る（m） */
  maxMeters: 30000,
};

/**
 * 曲率の高いところを抜き出す。
 * 1本の道路から複数の区間が出てよい（峠の東側と西側など）。
 *
 * @param {Array} points [lng, lat] の並び
 * @returns {Array} { points, lengthMeters, curviness, flow, turnCount }
 */
function extract(points, options = {}) {
  const cfg = { ...EXTRACT, ...options };
  const p = profile(points);
  if (p.points.length < 3 || p.totalMeters < cfg.minMeters) return [];

  // 各頂点を「窓の中心」とみなしたときの局所曲率
  const local = localCurviness(p, cfg.windowMeters);

  // 閾値を超える連続範囲を拾う
  let runs = [];
  let start = -1;
  for (let i = 0; i < local.length; i++) {
    if (local[i] >= cfg.curvinessThreshold) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, local.length - 1]);
  if (runs.length === 0) return [];

  // 長い直線をまたいでいる範囲を割る。
  //
  // ⚠️ 添字だけで範囲を切ると、長い直線が1本の辺に潰れたときに切れ目が消える。
  //    間引きで直線が2点になると「峠の終わり」と「次の峠の始まり」が隣り合う添字になり、
  //    5km 離れていても1つの区間として繋がってしまう（実際にそうなった）。
  runs = splitLongChords(runs, p.cumulative, cfg.bridgeMeters);

  // 短い直線で切れているだけなら繋ぐ
  runs = bridge(runs, p.cumulative, cfg.bridgeMeters);

  const segments = [];
  for (const [from, to] of runs) {
    const lengthMeters = p.cumulative[to] - p.cumulative[from];
    if (lengthMeters < cfg.minMeters) continue;
    if (lengthMeters <= cfg.maxMeters) {
      segments.push(build(p, from, to));
    } else {
      // 長すぎる。一番曲率の高い maxMeters ぶんだけ採る
      const best = bestWindow(p, from, to, cfg.maxMeters);
      if (best) segments.push(build(p, best[0], best[1]));
    }
  }
  return segments;
}

/** 各頂点の周り windowMeters ぶんの曲率（度/km） */
function localCurviness(p, windowMeters) {
  const half = windowMeters / 2;
  const result = new Array(p.points.length).fill(0);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < p.points.length; i++) {
    const center = p.cumulative[i];
    while (lo < i && p.cumulative[lo] < center - half) { sum -= p.turns[lo]; lo++; }
    while (hi < p.points.length && p.cumulative[hi] <= center + half) { sum += p.turns[hi]; hi++; }
    const span = p.cumulative[Math.min(hi, p.points.length) - 1] - p.cumulative[lo];
    result[i] = span > 0 ? (sum / span) * 1000 : 0;
  }
  return result;
}

/** 1辺が長すぎる（＝そこが直線）ところで範囲を割る */
function splitLongChords(runs, cumulative, maxChordMeters) {
  const out = [];
  for (const [from, to] of runs) {
    let start = from;
    for (let i = from; i < to; i++) {
      if (cumulative[i + 1] - cumulative[i] > maxChordMeters) {
        if (i > start) out.push([start, i]);
        start = i + 1;
      }
    }
    if (to > start) out.push([start, to]);
  }
  return out;
}

/** 隙間が短い範囲どうしを繋ぐ */
function bridge(runs, cumulative, bridgeMeters) {
  if (runs.length === 0) return [];
  const merged = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const previous = merged[merged.length - 1];
    const gap = cumulative[runs[i][0]] - cumulative[previous[1]];
    if (gap <= bridgeMeters) previous[1] = runs[i][1];
    else merged.push(runs[i]);
  }
  return merged;
}

/** from..to の中で、maxMeters に収まる範囲のうち曲がり角の合計が最大のもの */
function bestWindow(p, from, to, maxMeters) {
  let best = null;
  let bestTurn = -1;
  let hi = from;
  let sum = 0;
  for (let lo = from; lo <= to; lo++) {
    while (hi < to && p.cumulative[hi + 1] - p.cumulative[lo] <= maxMeters) {
      hi++;
      sum += p.turns[hi];
    }
    if (sum > bestTurn) { bestTurn = sum; best = [lo, hi]; }
    sum -= p.turns[lo];
  }
  return best;
}

function build(p, from, to) {
  const points = p.points.slice(from, to + 1);
  const lengthMeters = p.cumulative[to] - p.cumulative[from];
  let totalTurn = 0;
  let turnCount = 0;
  for (let i = from; i <= to; i++) {
    totalTurn += p.turns[i];
    // 5度未満は道なりのぶれ。曲がったとは数えない
    if (p.turns[i] >= 5) turnCount++;
  }
  return {
    points,
    lengthMeters,
    curviness: lengthMeters > 0 ? (totalTurn / lengthMeters) * 1000 : 0,
    // 1曲がりあたりの平均角度。峠は大きく、市街地は小さい
    flow: turnCount > 0 ? totalTurn / turnCount : 0,
    turnCount,
  };
}

// ---- 点数 ----

/**
 * 信号ごとの重み。合計 1.0。
 *
 * curviness だけだと市街地のごちゃごちゃした道が上位に来る。
 * flow（1曲がりあたりの平均角度）で「大きい角が緩やかに続く峠」と
 * 「小さい角が細かく続く市街地」を分ける。ここが今回いちばん効く。
 */
const WEIGHTS = {
  curviness: 0.35,
  flow: 0.25,
  length: 0.15,
  classRank: 0.10,
  /** 走行実績。集計基盤ができるまでは 0 のまま（枠だけ用意しておく） */
  popularity: 0.15,
};

/**
 * 信号を 0〜1 に均すための基準値。
 *
 * ⚠️ 実データの分布に合わせること。低すぎると上位が全部振り切れて順位がつかない。
 *    栃木県で試したとき curviness=300 / flow=18 では 22% / 41% が振り切れ、
 *    上位20件の点数が 82.6〜84.7 に潰れて「どれが良いか」が消えていた。
 *    抜き出した区間の 90 パーセンタイル付近に置くと素直に並ぶ。
 *    分布は `--build` の出力で毎回確認できる。
 */
const NORMALIZERS = {
  /** これ以上曲がっていれば満点（度/km） */
  curviness: 550,
  /** 1曲がりあたりこれだけ曲がっていれば満点（度） */
  flow: 28,
  /** これだけ長ければ満点（m）。対数で効かせる */
  length: 30000,
};

/** 道の種別。生活道・県道級を高く、幹線を低く */
const CLASS_RANK = {
  tertiary: 1.0,
  secondary: 1.0,
  primary: 0.85,
  trunk: 0.5,
  motorway: 0.3,
};

function signals(segment, highway) {
  return {
    curviness: clamp01(segment.curviness / NORMALIZERS.curviness),
    flow: clamp01(segment.flow / NORMALIZERS.flow),
    // 対数。3km と 6km の差は大きいが、25km と 30km の差は小さい
    length: clamp01(Math.log1p(segment.lengthMeters) / Math.log1p(NORMALIZERS.length)),
    classRank: CLASS_RANK[highway] ?? 0.7,
    popularity: 0,
  };
}

function score(segment, highway, weights = WEIGHTS) {
  const s = signals(segment, highway);
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) total += (s[key] ?? 0) * weight;
  return { score: total * 100, signals: s };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

module.exports = { extract, score, signals, localCurviness, bestWindow, EXTRACT, WEIGHTS, NORMALIZERS, CLASS_RANK };
