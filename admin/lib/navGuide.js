/**
 * navGuide.js
 *
 * **アプリと同じ読み上げ文を組み立てる。**
 *
 * ⚠️ **Valhalla 自身の読み上げ文は使わない。** 日本語が壊れているため（実測）:
 *      verbal_pre_transition_instruction:  "右方向です。。その先左方向です。"
 *      verbal_post_transition_instruction: "明治通り, 305を4キロメートル直進です。"
 *    句点が二重になり、道路番号をそのまま読む。
 *
 * ⚠️ **アプリ側の値をそのまま移すこと。** 向こうは実機で詰めた数字が入っている。
 *    こちらで勝手に変えると、アプリに載せ替えたときに違う聞こえ方になり、
 *    どちらが正しいのか分からなくなる。
 *    移し元:
 *      NavAnnouncementSettings.swift  … 何メートル手前で言うか
 *      NavigationEngine.swift `phrase` … 文の組み立て
 *      NavRoute.swift `spokenPhrase` / `acceptsIntersectionName` / `spokenDistance`
 */
"use strict";

const { spokenIntersection } = require("./navName");

// MARK: 何メートル手前で言うか

/**
 * 標準の設定。⚠️ **アプリの `NavAnnouncementSettings.standard` と同じ値。**
 *   遠め700m / 近め300m / 直前60m
 */
const STANDARD = { far: 700, near: 300, imminent: 60, longStretch: 0 };
/** 早め（高速・車線変更に余裕を持たせたい人向け） */
const EARLY = { far: 1000, near: 300, imminent: 100, longStretch: 0 };
/** 遅め（市街地で頻繁に喋られたくない人向け） */
const LATE = { far: 300, near: 100, imminent: 50, longStretch: 0 };

/**
 * 選べる値。⚠️ **読み上げて自然な数字だけ**を並べること（アプリと同じ）。
 *    「480メートル手前」のような値は選ばせない。
 */
const CHOICES = {
  far: [0, 300, 500, 700, 1000, 1500, 2000],
  near: [0, 100, 150, 200, 300, 500],
  imminent: [0, 30, 50, 60, 80, 100],
  longStretch: [0, 1000, 2000, 3000, 5000],
};

/**
 * 遠め > 近め > 直前 の順序を保つように直す。
 * ⚠️ **全部0にはしない。** 曲がる直前だけは必ず言う（アプリと同じ）。
 */
function normalized(settings) {
  const s = { ...STANDARD, ...(settings || {}) };
  if (s.far > 0 && s.near > 0 && s.far <= s.near) s.far = 0;
  if (s.near > 0 && s.imminent > 0 && s.near <= s.imminent) s.near = 0;
  if (!s.far && !s.near && !s.imminent) s.imminent = STANDARD.imminent;
  s.longStretch = Math.max(0, s.longStretch || 0);
  return s;
}

/** 実際に発火させる距離（大きい順・0 と重複を除く） */
function activeDistances(settings) {
  const s = normalized(settings);
  return [...new Set([s.far, s.near, s.imminent])]
    .filter((m) => m > 0)
    .sort((a, b) => b - a);
}

/**
 * 「直前」として扱う距離（有効な値のうち最小）。
 * ⚠️ **この距離だけは、ステップが短くても必ず言う。** 曲がる直前に何も言われないと
 *    曲がり損ねる。
 */
function imminentThreshold(settings) {
  const list = activeDistances(settings);
  return list.length ? list[list.length - 1] : null;
}

// MARK: 距離の読み

/**
 * 読み上げる距離。
 * ⚠️ **「1.0キロ」と言わせない。** 音声だと「いってんぜろキロ」になって耳障り
 *    （アプリの実機指摘）。ちょうどの値は整数で言う。
 * ⚠️ **1km未満は50m単位に丸める。**「480メートル先」より「500メートル先」が自然。
 */
function spokenDistance(meters) {
  if (meters >= 1000) {
    const km = meters / 1000;
    const rounded = Math.round(km * 10) / 10;
    if (rounded === Math.round(rounded)) return `${Math.round(rounded)}キロ`;
    return `${rounded.toFixed(1)}キロ`;
  }
  return `${Math.max(50, Math.round(meters / 50) * 50)}メートル`;
}

// MARK: 操作の言い回し

/** ⚠️ アプリの `NavManeuver.spokenPhrase` と一字一句そろえること */
const SPOKEN_PHRASE = {
  turnLeft: "左折です",
  turnRight: "右折です",
  turnSlightLeft: "斜め左方向です",
  turnSlightRight: "斜め右方向です",
  turnSharpLeft: "鋭く左折です",
  turnSharpRight: "鋭く右折です",
  keepLeft: "左側を進みます",
  keepRight: "右側を進みます",
  uturnLeft: "Uターンです",
  uturnRight: "Uターンです",
  rampLeft: "左の入口に入ります",
  rampRight: "右の入口に入ります",
  ramp: "入口に入ります",
  merge: "合流します",
  forkLeft: "左の分岐に進みます",
  forkRight: "右の分岐に進みます",
  roundaboutLeft: "ロータリーに入ります",
  roundaboutRight: "ロータリーに入ります",
  ferry: "フェリーに乗ります",
  ferryTrain: "フェリーに乗ります",
  straight: "直進します",
  none: "直進します",
};

/**
 * 交差点名を付けてよい操作。
 * ⚠️ **アプリの `acceptsIntersectionName` と同じ。** 「〇〇交差点を合流します」は
 *    不自然なので、曲がる・Uターン・直進だけに付ける。
 */
const ACCEPTS_INTERSECTION_NAME = new Set([
  "turnLeft", "turnRight", "turnSlightLeft", "turnSlightRight",
  "turnSharpLeft", "turnSharpRight", "uturnLeft", "uturnRight", "straight",
]);

// MARK: 曲がりくねり

/**
 * 曲率（度/km）。⚠️ アプリの `NavStep.curvinessDegPerKm` と同じ計算。
 * @param {Array<[number,number]>} points [経度, 緯度] の並び
 */
function curvinessDegPerKm(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let total = 0;
  for (let i = 1; i < points.length - 1; i++) {
    total += Math.abs(angleDelta(bearing(points[i - 1], points[i]),
                                 bearing(points[i], points[i + 1])));
  }
  const km = lengthOf(points) / 1000;
  return km > 0 ? total / km : 0;
}

/**
 * 「直進します」ではなく「道なりに進みます」と言うべきか。
 * ⚠️ **しきい値250はアプリの実測から。** まっすぐな幹線は100〜165度/km、
 *    峠は600〜900度/km。その谷が250。
 * ⚠️ Valhalla の straight は「この道を進み続けろ」の意味で、
 *    道がまっすぐという意味ではない。峠で「直進します」と言うと誤解される。
 */
const FOLLOW_THE_ROAD_DEG_PER_KM = 250;
const shouldSayFollowTheRoad = (points) =>
  curvinessDegPerKm(points) >= FOLLOW_THE_ROAD_DEG_PER_KM;

// MARK: 文の組み立て

/**
 * 読み上げる一文を作る。⚠️ **アプリの `NavigationEngine.phrase` と同じ組み立て。**
 *
 * 「〇〇交差点を、△△へ左折です」
 * 「まもなく△△へ左折です、その後300メートル先、右折です」
 *
 * ⚠️ **名前は無いことのほうが多い**（実測: 道路名70.7% / 交差点名38.8%）。
 *    無いときは操作だけを言う。**無理に補わない。**
 */
function phrase({ meters, isImminent, maneuver, intersection, roadName,
                  isCurvyAhead = false, followUp = null }) {
  const kind = SPOKEN_PHRASE[maneuver] ? maneuver : "straight";

  // ⚠️ 曲がりくねった道で「直進します」と言わない（上の説明を読むこと）
  let action = ((kind === "straight" || kind === "none") && isCurvyAhead)
    ? "道なりに進みます"
    : SPOKEN_PHRASE[kind];

  if (ACCEPTS_INTERSECTION_NAME.has(kind)) {
    if (roadName) action = `${roadName}へ${action}`;
    if (intersection) action = `${spokenIntersection(intersection)}を${action}`;
  }

  const base = isImminent
    ? `まもなく${action}`
    : `${spokenDistance(meters)}先、${action}`;
  return followUp ? `${base}、${followUp}` : base;
}

/**
 * 「まもなく」の直後に足す、その次の操作。
 * ⚠️ **曲がってすぐまた曲がるときに必要。** 画面には常に出しているが、
 *    走行中は画面を見られないので、声で言わないと聞き逃す（アプリのコメント）。
 */
function followUpPhrase(nextDistanceMeters, maneuverAfter) {
  if (!maneuverAfter || maneuverAfter === "none") return null;
  if (!(nextDistanceMeters > 0)) return null;
  const kind = SPOKEN_PHRASE[maneuverAfter] ? maneuverAfter : "straight";
  return `その後${spokenDistance(nextDistanceMeters)}先、${SPOKEN_PHRASE[kind]}`;
}

/**
 * 長い直線で「〇〇をあと〇キロです」。
 * ⚠️ **「この道」ではなく道路名で言う。** 同じ道を走り続けているのか分岐したのか、
 *    名前があるほうが確かめやすい（アプリの実機要望）。名前が無いときだけ「この道」。
 */
function longStretchPhrase(roadName, announcedMeters) {
  const road = roadName && roadName.length ? roadName : "この道";
  return `${road}をあと${Math.round(announcedMeters / 1000)}キロです`;
}

// MARK: 幾何（`navGeometry` と同じ式。あちらは経路全体、こちらはステップ単位）

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1]))
          - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (Math.atan2(y, x) * 180) / Math.PI;
}
function angleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
function distance(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const lat = rad((a[1] + b[1]) / 2);
  const x = dLon * Math.cos(lat);
  return Math.sqrt(x * x + dLat * dLat) * R;
}
function lengthOf(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

module.exports = {
  STANDARD, EARLY, LATE, CHOICES,
  normalized, activeDistances, imminentThreshold,
  spokenDistance, phrase, followUpPhrase, longStretchPhrase,
  SPOKEN_PHRASE, ACCEPTS_INTERSECTION_NAME,
  curvinessDegPerKm, shouldSayFollowTheRoad, FOLLOW_THE_ROAD_DEG_PER_KM,
  distance, lengthOf,
};
