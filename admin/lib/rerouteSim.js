/**
 * rerouteSim.js
 *
 * ナビ中に**経路を外れたときの引き直し**を、アプリと同じ手順でなぞる（確認ツールで試すため）。
 *
 * 【どこから来た処理か】
 * iOS の `NavigationController`（reroute / rerouteByRejoining / rerouteWholeRoute /
 * requestReroute / retryRerouteAvoidingUTurn / retryRerouteWithoutProblemLeg）と、
 * そこが使う純ロジック `NavRouteSplice` / `NavRerouteShape` /
 * `NavWaypointSkip.firstLegAhead`・`problemLegIndices` / `NavDetourTrim` を移したもの。
 * **定数は向こうの値をそのまま使う。** 変えるならアプリと同時に変えること。
 * 勝手に変えると、画面で試した結果とアプリの動きが食い違う。
 *
 * 【手順（アプリと同じ順）】
 *   ① 外れた分だけ引き直して元の続きに繋ぐ（1.5km 先の区切りへ。立ち寄り先は跨がない）
 *   ② 繋げない・大回り（直線の3倍超）なら、全体を引き直す
 *      ・通り過ぎた行き先は落とす（`firstLegAhead`）
 *      ・いきなり向きを変えさせる形なら、進行方向100m先を挟んでもう一度だけ引く
 *      ・中継点のせいで往復・有料に乗るなら、その中継点を落としてもう一度だけ引く
 *   どの引き直しも「向きつきで引けなければ向き無しで」引き直す。
 *
 *   どの依頼も、最初の動きが近すぎれば「いまの道の先」から引き直して頭を継ぐ（`NavRerouteAhead`）。
 *
 * ⚠️ **点は `[経度, 緯度]`。** Swift 側は `CLLocationCoordinate2D`（緯度が先）。
 * ⚠️ **なぞれないもの**（走ってきた経過が要る。画面では置いた1点しか分からない）:
 *    ・`dropCount`（わざと無視したおすすめ道路・立ち寄り先を諦める）… 最接近の距離と「着いた」区間が要る
 *    ・とばした立ち寄り先（`skippedLegIDs`）
 *    ・前の引き直しが返らないあいだの見送り・20秒の打ち切り
 *    ・引き直しの空回り（新しい経路に乗れないまま3回続けたら止める。`NavigationEngine.admitReroute`）
 */
"use strict";

const { distance, backtracks, project } = require("./navGeometry");
const { DISPLACEMENTS } = require("./valhallaRoute");

// MARK: 定数（⚠️ アプリの値。勝手に変えないこと）

/** 合流点は、これだけ先の区切りから探す（`NavRouteSplice.minAheadMeters`） */
const MIN_AHEAD_METERS = 1_500;
/** 戻る道が直線距離のこの倍を超えたら、繋がずに全体を引き直す（`NavRouteSplice.maxDetourRatio`） */
const MAX_DETOUR_RATIO = 3.0;
/** 向き直しを避ける誘導点を置く距離（`NavRerouteShape.nudgeMeters`） */
const NUDGE_METERS = 100;
/** 目的地が「前方にある」とみなす角度の上限（`NavRerouteShape.aheadToleranceDegrees`） */
const AHEAD_TOLERANCE_DEGREES = 90;
/** 向き直しかを見る先頭の指示の数（`NavRerouteShape.headStepCount`） */
const HEAD_STEP_COUNT = 4;
/** これより近い行き先は、通り過ぎたとみなさない（`NavWaypointSkip.passedMeters`） */
const PASSED_METERS = 150;
/** 進行方向とこれ以上ずれていれば「後方」（`NavWaypointSkip.behindToleranceDegrees`） */
const BEHIND_TOLERANCE_DEGREES = 90;
/** 中継点が有料道路の上に乗っているとみなす距離（`NavWaypointSkip.onTollRoadMeters`） */
const ON_TOLL_ROAD_METERS = 50;
/** 折り返しの先端からこの距離までの中継点だけを原因とみなす（`NavDetourTrim.maxApexDistanceMeters`） */
const MAX_APEX_DISTANCE_METERS = 1_500;
/** 往復とみなす沿線距離の下限（`NavDetourTrim.minAlongGapMeters`） */
const DETOUR_MIN_ALONG_GAP_METERS = 100;
/** 最初の動きがこれより近ければ、その先から引き直す（`NavRerouteAhead.minFirstActionMeters`） */
const AHEAD_MIN_METERS = 150;
/** 速いときは、この秒数で走る距離まで広げる（`NavRerouteAhead.reactionSeconds`） */
const AHEAD_REACTION_SECONDS = 10;
/** これより遅ければ（m/s）ずらさない（`NavRerouteAhead.stoppedSpeed`） */
const AHEAD_STOPPED_SPEED = 3;
/** ずらした出発点が道に乗らなかったとみなす距離（`NavRerouteAhead.maxSnapMeters`） */
const AHEAD_MAX_SNAP_METERS = 30;
/** ずらして増えてよい距離（`NavRerouteAhead.maxExtraMeters`） */
const AHEAD_MAX_EXTRA_METERS = 1_000;
/** 角での向きを、これだけ手前から測る（`NavRerouteAhead.bearingBackMeters`） */
const AHEAD_BEARING_BACK_METERS = 20;
/** ずらした出発点は、角をこれだけ抜けた先に乗っていること（`NavRerouteAhead.minPastMeters`） */
const AHEAD_MIN_PAST_METERS = 1;

// MARK: 幾何（NavGeometry.swift と同じ式）

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** a から b への方位（度・0=北・時計回り） */
function bearing(a, b) {
  const lat1 = rad(a[1]), lat2 = rad(b[1]);
  const dLon = rad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** 角度差（-180〜180） */
function angleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** origin から方位 degrees へ meters 進んだ点。⚠️ 球面で解く（緯度で経度1度の長さが変わる） */
function pointFrom(origin, degrees, meters) {
  const R = 6_371_000;
  const angular = meters / R;
  const brg = rad(degrees);
  const lat1 = rad(origin[1]), lon1 = rad(origin[0]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular)
    + Math.cos(lat1) * Math.sin(angular) * Math.cos(brg));
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return [deg(lon2), deg(lat2)];
}

// MARK: いまどこを走っていたか

/**
 * 外れる前に走っていたステップ。
 *
 * ⚠️ **アプリはここを測らない**（案内が追っていたステップをそのまま使う）。画面では
 *    外れた地点しか分からないので、経路のいちばん近いところを「外れる前にいた所」とみなす。
 * ⚠️ 行きと帰りで同じ道を通る経路では、近さだけでは向きを見分けられない。
 *    向きが分かっていれば、いちばん近い所から 50m 以内のうち進行方向に沿う側を選ぶ
 */
function stepAtPosition(route, position, heading) {
  const pts = route.points || [];
  const steps = route.steps || [];
  if (pts.length < 2 || !steps.length) return null;
  const segs = [];
  for (let k = 1; k < pts.length; k++) {
    const p = project(position, [pts[k - 1], pts[k]]);
    segs.push({ k: k - 1, lateral: p.lateralDistance, point: p.point });
  }
  const best = Math.min(...segs.map((s) => s.lateral));
  let pick = segs.find((s) => s.lateral === best);
  if (heading != null) {
    const along = segs.filter((s) => s.lateral <= best + 50
      && Math.abs(angleDelta(heading, bearing(pts[s.k], pts[s.k + 1]))) <= BEHIND_TOLERANCE_DEGREES);
    if (along.length) pick = along.reduce((a, b) => (a.lateral <= b.lateral ? a : b));
  }
  // 点 k〜k+1 を含むステップ（到着の印は長さ0なので飛ばす）
  let stepIndex = steps.findIndex((s) => !s.isLegEnd && s.beginIndex <= pick.k && pick.k < s.endIndex);
  if (stepIndex < 0) {
    stepIndex = steps.length - 1;
    while (stepIndex > 0 && steps[stepIndex].isLegEnd) stepIndex--;
  }
  return { stepIndex, pointIndex: pick.k, lateralMeters: pick.lateral, onRoute: pick.point };
}

/** そのステップが経路の何番目の区間か（`NavRoute.legIndex(forStep:)`。到着の印を数える） */
function routeLegIndexForStep(steps, stepIndex) {
  let leg = 0;
  for (let i = 0; i < stepIndex && i < steps.length; i++) if (steps[i].isLegEnd) leg++;
  return leg;
}

/**
 * 経路の区間ごとの終わり（`legs` の番号）。止まる場所（立ち寄り先）と最後の行き先
 * （アプリの `NavRouteLegMap(requested:offset:routeLegCount:)` の `ends`）。
 *
 * ⚠️ **サーバは止まる場所でしか区間を分けない。** 通るだけの点（おすすめ道路の中継点・なぞった点）は
 *    区間を作らない。2026-09-27 までアプリは「区間 i＝i 番目の行き先」と数えていて、立ち寄り先を過ぎて
 *    全体を引き直すと通過済みの立ち寄り先へ戻らせた（この画面で再現して直した）
 */
function routeLegEnds(legs) {
  return legs.map((l, i) => i).filter((i) => i === legs.length - 1 || legs[i].isUserWaypoint);
}

/** 経路の区間番号 → その区間の**行き先**（区間の終わりの立ち寄り先）の `legs` の番号（`legsIndex(forRouteLeg:)`） */
function routeLegEndIndex(routeLeg, legs) {
  const ends = routeLegEnds(legs);
  return ends[Math.min(Math.max(routeLeg, 0), ends.length - 1)] ?? 0;
}

/**
 * 経路の区間番号 → その区間で**最初に向かう**行き先の `legs` の番号（`firstLegsIndex(forRouteLeg:)`）。
 * ⚠️ 引き直しはここから始めて、通り過ぎたものを `firstLegAhead` で飛ばす
 */
function routeLegStartIndex(routeLeg, legs) {
  if (routeLeg <= 0) return 0;
  const ends = routeLegEnds(legs);
  const prev = ends[Math.min(routeLeg, ends.length) - 1];
  return Math.min(prev + 1, Math.max(legs.length - 1, 0));
}

// MARK: ① 外れた分だけ繋ぐ（NavRouteSplice）

/**
 * 繋ぎ先にできるステップ番号を探す。
 * @returns {{index: number|null, reason: "found"|"legEnd"|"short"|"outOfRange"}}
 */
function rejoinSearch(steps, current, minAhead = MIN_AHEAD_METERS) {
  if (!(current >= 0 && current < steps.length)) return { index: null, reason: "outOfRange" };
  let ahead = 0;
  let index = current;
  while (index < steps.length - 1) {
    // ⚠️ **立ち寄り先を跨がないこと。** 跨ぐとその立ち寄り先が黙って消える
    if (steps[index].isLegEnd) return { index: null, reason: "legEnd" };
    ahead += steps[index].distanceMeters || 0;
    index++;
    if (ahead >= minAhead) return { index, reason: "found" };
  }
  return { index: null, reason: "short" };
}

/** 繋ぎ先のステップ番号。無ければ null（`NavRouteSplice.rejoinStepIndex`） */
const rejoinStepIndex = (steps, current, minAhead) => rejoinSearch(steps, current, minAhead).index;

/** 区切り（begin/end が点の番号）を、元の点 `from` 以降だけにして `shift` ずらす */
function shiftSpans(spans, from, shift) {
  return (spans || []).filter((sp) => sp.end > from)
    .map((sp) => ({ ...sp, begin: Math.max(sp.begin, from) + shift, end: sp.end + shift }));
}

/** 区切りごとの長さを、点から測り直して種類ごとに足す（繋いだ経路の凡例用） */
function metersBy(spans, points, key) {
  const out = {};
  for (const sp of spans || []) {
    let m = 0;
    for (let i = sp.begin + 1; i <= sp.end && i < points.length; i++) m += distance(points[i - 1], points[i]);
    out[sp[key]] = (out[sp[key]] || 0) + Math.round(m);
  }
  return out;
}

/**
 * 戻る道（`detour`）を、元の経路の `rejoinAt` 以降に繋ぐ（`NavRouteSplice.splice`）。
 *
 * ⚠️ **戻る道の最後の「到着」を捨てること。** 残すと合流点で「目的地に到着しました」と言う。
 * ⚠️ 楽しい道は元の経路のものをそのまま引き継ぐ
 */
function splice(detour, original, rejoinAt) {
  if (!original.steps || !original.steps[rejoinAt]) return null;
  const head = (detour.steps || []).slice();
  while (head.length && head[head.length - 1].isLegEnd) head.pop();
  if (!head.length) return null;

  const tail = original.steps.slice(rejoinAt);
  const from = tail[0].beginIndex;
  const shift = detour.points.length - from;
  const points = detour.points.concat(original.points.slice(from));
  const steps = head.concat(tail.map((s) => ({ ...s, beginIndex: s.beginIndex + shift, endIndex: s.endIndex + shift })));
  const sum = (list, k) => list.reduce((a, s) => a + (s[k] || 0), 0);

  const classSpans = (detour.classSpans || []).concat(shiftSpans(original.classSpans, from, shift));
  const kindMeters = {};
  for (const s of steps) kindMeters[s.roadKind || "surface"] = (kindMeters[s.roadKind || "surface"] || 0) + (s.distanceMeters || 0);
  return {
    points, steps,
    lengthMeters: sum(head, "distanceMeters") + sum(tail, "distanceMeters"),
    durationSeconds: sum(head, "durationSeconds") + sum(tail, "durationSeconds"),
    uTurns: steps.filter((s) => String(s.maneuver).startsWith("uturn")).length,
    classSpans, classMeters: metersBy(classSpans, points, "roadClass"), kindMeters,
    funRoads: original.funRoads, restrictionHits: original.restrictionHits,
  };
}

/** 戻る道が遠回りすぎないか（直線距離の3倍まで。`NavRouteSplice.isReasonable`） */
function isReasonable(detour, origin, rejoin, maxRatio = MAX_DETOUR_RATIO) {
  const direct = distance(origin, rejoin);
  if (!(direct > 0)) return false;
  return (detour.lengthMeters || 0) <= direct * maxRatio;
}

// MARK: 向き直し（NavRerouteShape）

const LEFT = new Set(["turnLeft", "turnSlightLeft", "turnSharpLeft"]);
const RIGHT = new Set(["turnRight", "turnSlightRight", "turnSharpRight", "twoStageRight"]);

/**
 * 引き直した経路が、いきなり向きを変えさせる形か。
 * `uturn` があるか、先頭4つの中で最初の2回の曲がりが同じ向き（右→右／左→左）
 */
function startsWithUTurn(steps) {
  const head = (steps || []).slice(0, HEAD_STEP_COUNT).map((s) => s.maneuver);
  if (head.some((m) => m === "uturnLeft" || m === "uturnRight")) return true;
  const turns = head.filter((m) => LEFT.has(m) || RIGHT.has(m));
  if (turns.length < 2) return false;
  return (LEFT.has(turns[0]) && LEFT.has(turns[1])) || (RIGHT.has(turns[0]) && RIGHT.has(turns[1]));
}

/**
 * 進行方向の先に置く誘導点。挟むべきでないときは null。
 * ⚠️ 向きが無い・目的地が背後（90度超）なら挟まない（背後なら向きを変えるのが正しい）
 */
function forwardNudge(current, heading, destination, meters = NUDGE_METERS) {
  if (heading == null) return null;
  const toDestination = bearing(current, destination);
  if (Math.abs(angleDelta(heading, toDestination)) > AHEAD_TOLERANCE_DEGREES) return null;
  return pointFrom(current, heading, meters);
}

// MARK: 近すぎる曲がりを避ける（NavRerouteAhead）

/*
 * ⚠️ **利用者の判断（2026-09-28）:「近すぎる曲がりは避ける」。** 実機で「道を外れたときに直近だと
 *    戻るのに慌ててしまう」。曲がり損ねて直進し 80m 先で引き直すと（7経路47か所で実測）、
 *    最初の動きが 100m 未満が55%・50m 未満が30%（「14m 先を左」など）。
 * 直し方: 最初の動きが近すぎたら、**いまの道をそのまま進んだ先を出発点にして引き直し**、
 *    手前の線（いまの道・近い角をまっすぐ抜ける所）を頭に継ぐ。近い角は曲がらずに通り過ぎる。
 *    実測（150m）: 27か所すべて最初の動きが150m以上・増えた距離の中央値 +294m。
 * ⚠️ **通るだけの点（向きつき）を挟む形にしないこと。** 同じ27か所で、100m 未満が11か所残り、
 *    10か所で点が別の道に吸われた（出発点をずらす方が素直に道の先から引ける）。
 * ⚠️ 道の先が無い（T字路など＝ずらした点が道に乗らない）・大回り（+1km 超）なら元の経路のまま。
 *    山道では抜け道が無く +2〜6km になった（4か所）
 */

/**
 * 「動き」に数えない指示（そのまま進む・到着・合流）。⚠️ アプリの `NavRerouteAhead.passive` と同じ。
 * ⚠️ 到着は `none` で見分ける（`isLegEnd` では見ない。Google の形は走る指示に `isLegEnd` が付く）
 */
const PASSIVE_MANEUVERS = new Set(["straight", "none", "merge"]);

/** 最初の動き（曲がる・分岐など）までの距離と、その指示の番号。無ければ null */
function firstAction(route) {
  const steps = (route && route.steps) || [];
  let meters = 0;
  for (let i = 0; i < steps.length; i++) {
    if (i > 0 && !PASSIVE_MANEUVERS.has(steps[i].maneuver)) return { meters, stepIndex: i };
    meters += steps[i].distanceMeters || 0;
  }
  return null;
}

/**
 * これより近い動きは避ける距離（m）。止まっていれば null（近い角でも落ち着いて曲がれる）。
 * ⚠️ 速さが分からない（null）ときは避ける（慌てさせない方に倒す）
 */
function aheadThreshold(speed) {
  if (speed != null && speed >= 0 && speed < AHEAD_STOPPED_SPEED) return null;
  return Math.max(AHEAD_MIN_METERS, (speed != null && speed > 0 ? speed : 0) * AHEAD_REACTION_SECONDS);
}

/**
 * 最初の動きが近すぎるなら、引き直す出発点（いまの道を近い角でまっすぐ抜けた先）。要らなければ null。
 * @returns {{origin, heading, prefix, firstMeters, threshold}}
 *   prefix: 経路の頭から近い角までの線（引き直した経路の頭に継ぐ）
 */
function aheadPlan(route, speed) {
  const threshold = aheadThreshold(speed);
  if (threshold == null) return null;
  const first = firstAction(route);
  if (!first || first.meters >= threshold) return null;
  const corner = route.steps[first.stepIndex].beginIndex;
  const prefix = route.points.slice(0, corner + 1);
  if (prefix.length < 2) return null;
  let along = 0;
  for (let k = 1; k < prefix.length; k++) along += distance(prefix[k - 1], prefix[k]);
  // 角での向き（少し手前から）
  let j = prefix.length - 2, back = 0;
  while (j > 0 && back < AHEAD_BEARING_BACK_METERS) { back += distance(prefix[j], prefix[j + 1]); j--; }
  const heading = bearing(prefix[Math.max(j, 0)], prefix[prefix.length - 1]);
  const origin = pointFrom(prefix[prefix.length - 1], heading, Math.max(threshold - along, 0));
  return { origin, heading, prefix, firstMeters: first.meters, threshold };
}

/**
 * ずらした出発点から引いた経路（`shifted`）の頭に、手前の線を継ぐ。使えなければ `{ reason }`。
 * reason: "snap"（道の先が無い）/ "notPast"（角の手前に吸われた）/ "extra"（大回り）
 */
function joinAhead(plan, shifted, original) {
  const start = shifted.points[0];
  if (distance(plan.origin, start) > AHEAD_MAX_SNAP_METERS) return { reason: "snap" };
  const prefix = plan.prefix;
  // ⚠️ **角を抜けた先に乗っていること。** 角の手前（いま走っている道）に吸われると、同じ近い角で
  //    曲がる経路が返り、継ぎ目で後戻りする線になる（距離だけ見ると遠くなったように見える）
  const corner = prefix[prefix.length - 1];
  const past = distance(corner, start) * Math.cos(rad(angleDelta(plan.heading, bearing(corner, start))));
  if (!(past >= AHEAD_MIN_PAST_METERS)) return { reason: "notPast" };
  const shift = prefix.length;
  let added = distance(prefix[prefix.length - 1], start);
  for (let k = 1; k < prefix.length; k++) added += distance(prefix[k - 1], prefix[k]);
  added = Math.round(added);
  if ((shifted.lengthMeters || 0) + added - (original.lengthMeters || 0) > AHEAD_MAX_EXTRA_METERS) {
    return { reason: "extra" };
  }
  // 継いだ線の所要時間は、元の経路の同じ所の速さで見積もる
  const first = firstAction(original);
  const head = original.steps.slice(0, first ? first.stepIndex : 0);
  const headMeters = head.reduce((a, s) => a + (s.distanceMeters || 0), 0);
  const headSeconds = head.reduce((a, s) => a + (s.durationSeconds || 0), 0);
  const addedSeconds = headMeters > 0 ? Math.round(added * headSeconds / headMeters) : 0;

  const steps = shifted.steps.map((s, i) => (i === 0
    ? { ...s, beginIndex: 0, endIndex: s.endIndex + shift,
        distanceMeters: (s.distanceMeters || 0) + added, durationSeconds: (s.durationSeconds || 0) + addedSeconds }
    : { ...s, beginIndex: s.beginIndex + shift, endIndex: s.endIndex + shift }));
  const points = prefix.concat(shifted.points);
  // 頭の区切りは元の経路から（角と継ぎ目の間まで伸ばす）
  const last = prefix.length - 1;
  const spansWithHead = (headFrom, tail) => {
    const headSpans = (headFrom || []).filter((sp) => sp.begin < last)
      .map((sp) => ({ ...sp, end: Math.min(sp.end, last) }));
    if (headSpans.length) headSpans[headSpans.length - 1].end = last + 1;
    return headSpans.concat(shiftSpans(tail, 0, shift));
  };
  const classSpans = spansWithHead(original.classSpans, shifted.classSpans);
  const kindMeters = {};
  for (const s of steps) kindMeters[s.roadKind || "surface"] = (kindMeters[s.roadKind || "surface"] || 0) + (s.distanceMeters || 0);
  // ⚠️ **知っている項目だけで組み直すこと（`splice` と同じ）。** 丸ごと写すと、点の番号を持つ項目
  //    （無駄な輪の区切りなど）が継いだ分ずれたまま残る
  const joined = {
    points, steps,
    lengthMeters: (shifted.lengthMeters || 0) + added,
    durationSeconds: (shifted.durationSeconds || 0) + addedSeconds,
    uTurns: steps.filter((s) => String(s.maneuver).startsWith("uturn")).length,
    classSpans, classMeters: metersBy(classSpans, points, "roadClass"), kindMeters,
    ...(shifted.kindSpans ? { kindSpans: spansWithHead(original.kindSpans, shifted.kindSpans) } : {}),
    funRoads: shifted.funRoads, restrictionHits: shifted.restrictionHits,
    // ⚠️ 頭に継いだ長さ。向き直しの確かめ（`startsWithUTurn`）を飛ばす印
    aheadMeters: added,
  };
  return { route: joined };
}

/**
 * 繋いだ経路の最初の動きが、**繋いだ先（元の経路）の曲がり**で、しかも近すぎるか。
 * そうなら繋がずに全体を引き直す（戻る道に曲がりが無いので、ずらして引くこともできない）。
 * ⚠️ 実測: 47か所中2か所（元の経路が回り込んで外れた地点のそばを通る形。38m・47m 先を左）
 */
function rejoinTurnsTooSoon(detour, spliced, speed) {
  const threshold = aheadThreshold(speed);
  if (threshold == null || firstAction(detour)) return false;
  const first = firstAction(spliced);
  return !!first && first.meters < threshold;
}

// MARK: どの行き先から引き直すか（NavWaypointSkip）

/**
 * 通り過ぎた行き先を飛ばして、まだ向かっている区間の番号（`NavWaypointSkip.firstLegAhead`）。
 * ⚠️ 向きが取れないときは落とさない（止まっているときに落とすと、間違えたときに取り返せない）
 */
function firstLegAhead(legs, start, current, heading) {
  let index = Math.max(0, Math.min(start, Math.max(legs.length - 1, 0)));
  if (heading == null) return index;
  while (index < legs.length - 1) {
    // 次の行き先のほうが近いなら、今の行き先はもう通り過ぎている
    const toCurrent = distance(current, legs[index].destination);
    const toNext = distance(current, legs[index + 1].destination);
    if (!(toCurrent > toNext && toCurrent > PASSED_METERS)) break;
    // ⚠️ **前方にあるならまだ向かっている途中。** ここが往復の分かれ目
    const toTarget = bearing(current, legs[index].destination);
    if (!(Math.abs(angleDelta(heading, toTarget)) > BEHIND_TOLERANCE_DEGREES)) break;
    index++;
  }
  return index;
}

/** 有料・高速を避ける区間の中継点のうち、有料・高速の上に乗っているもの（`tollCausingLegIndex`） */
function tollCausingLegIndex(legs, route) {
  const lines = (route.steps || [])
    .filter((s) => s.roadKind === "toll" || s.roadKind === "expressway")
    .map((s) => route.points.slice(s.beginIndex, s.endIndex + 1));
  if (!lines.length) return null;
  let bestIndex = null;
  let bestDistance = ON_TOLL_ROAD_METERS;
  legs.forEach((leg, index) => {
    if (leg.isUserWaypoint || !(leg.avoidTolls || leg.avoidHighways)) return;
    for (const line of lines) {
      const p = project(leg.destination, line);
      if (p && p.lateralDistance <= bestDistance) {
        bestDistance = p.lateralDistance;
        bestIndex = index;
      }
    }
  });
  return bestIndex;
}

/** 往復1か所につき、折り返しの先端にいちばん近い経由地（1.5km 以内）（`NavDetourTrim.offendingWaypointIndices`） */
function offendingWaypointIndices(points, waypoints) {
  if (!waypoints.length) return [];
  const found = new Set();
  for (const bt of backtracks(points, { minAlongGap: DETOUR_MIN_ALONG_GAP_METERS })) {
    let bestIndex = null;
    let bestDistance = MAX_APEX_DISTANCE_METERS;
    waypoints.forEach((p, i) => {
      const d = distance(p, bt.apex);
      if (d <= bestDistance) { bestDistance = d; bestIndex = i; }
    });
    if (bestIndex != null) found.add(bestIndex);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * 落とすべき中継点の番号（`NavWaypointSkip.problemLegIndices`）。
 * ⚠️ 立ち寄り先と最後の行き先は落とさない
 */
function problemLegIndices(legs, route) {
  const indices = new Set();
  const toll = tollCausingLegIndex(legs, route);
  if (toll != null) indices.add(toll);
  const pass = legs.map((leg, i) => ({ leg, i })).filter((x) => !x.leg.isUserWaypoint);
  if (pass.length) {
    for (const j of offendingWaypointIndices(route.points || [], pass.map((x) => x.leg.destination))) {
      indices.add(pass[j].i);
    }
  }
  return [...indices].filter((i) => i < legs.length - 1 && !legs[i].isUserWaypoint).sort((a, b) => a - b);
}

// MARK: 依頼の組み立て（ValhallaRouteService）

/**
 * 区間の並びから、有料・高速の条件と止まる場所を作る（`ValhallaRouteService.legPlan`）。
 * ⚠️ 条件が区間ごとに違うときだけ `legConditions` を渡す
 */
function legPlan(legs, mustAvoidExpressway) {
  const resolved = legs.map((l) => ({ avoidTolls: !!l.avoidTolls,
                                      avoidHighways: !!l.avoidHighways || !!mustAvoidExpressway }));
  const body = legs.slice(0, -1);
  const stopAt = body.map((l, i) => (l.isUserWaypoint ? i : -1)).filter((i) => i >= 0);
  const throughStopAt = body.map((l, i) => (l.isUserWaypoint && l.isRoadCourse ? i : -1)).filter((i) => i >= 0);
  const mixed = resolved.some((r) => r.avoidTolls !== resolved[0].avoidTolls
                                  || r.avoidHighways !== resolved[0].avoidHighways);
  return {
    avoidTolls: resolved.some((r) => r.avoidTolls),
    avoidHighways: resolved.some((r) => r.avoidHighways),
    stopAt, throughStopAt, legConditions: mixed ? resolved : null,
  };
}

/**
 * 引き直しの依頼（アプリが `/v1/route` に送る中身と同じ形）。
 *
 * ⚠️ **楽しい道の区間があれば `variant: "fun"`**（高速を外す）。渡し忘れると下道のみの経路に有料が入る。
 * ⚠️ 目的地は渡らずに着ける側へ（`arriveOnNearSide: true`）。別の道は頼まない（先頭の1本だけ使う）
 * ⚠️ 向きは 0 以上のときだけ（-1 は「不明」。渡すと真北向きの嘘の縛りになる）
 * @param bike `{ displacement, etc, avoidFerries, at, isHoliday }`。`at` が無ければ今（アプリは常に今）
 */
function rerouteBody(origin, legs, heading, bike = {}) {
  const spec = DISPLACEMENTS[bike.displacement];
  const plan = legPlan(legs, spec ? !spec.canUseExpressway : false);
  const body = {
    from: origin,
    to: legs[legs.length - 1].destination,
    vias: legs.slice(0, -1).map((l) => l.destination),
    displacement: bike.displacement,
    avoidTolls: plan.avoidTolls,
    avoidHighways: plan.avoidHighways,
    excludeTolls: false,
    avoidFerries: bike.avoidFerries !== false,
    alternates: 0,
    arriveOnNearSide: true,
    at: bike.at || new Date().toISOString(),
    isHoliday: !!bike.isHoliday,
  };
  if (bike.etc === false) body.etc = false;
  if (plan.stopAt.length) body.stopAt = plan.stopAt;
  if (plan.throughStopAt.length) body.throughStopAt = plan.throughStopAt;
  if (heading != null && heading >= 0) body.heading = heading;
  if (legs.some((l) => l.isRoadCourse)) body.variant = "fun";
  if (plan.legConditions) body.legConditions = plan.legConditions;
  return body;
}

// MARK: 通しでなぞる（NavigationController）

const usable = (r) => !!(r && !r.error && Array.isArray(r.points) && r.points.length >= 2
  && Array.isArray(r.steps) && r.steps.length);

/**
 * 外れた地点と向きから、アプリと同じ手順で引き直す。
 *
 * @param route    いま案内している経路（`points` と `steps`）
 * @param legs     行き先の並び `{destination, isUserWaypoint, isRoadCourse, avoidTolls, avoidHighways}`。
 *                 最後が最終目的地
 * @param position 外れた地点 `[経度, 緯度]`
 * @param heading  進行方向（度）。止まっていて取れないなら null
 * @param speed    速さ（m/s）。分からなければ null（近すぎる曲がりは避ける）
 * @param fetchRoute `(body) => Promise<経路>`。`rerouteBody` の形を受け取って1本引く
 * @returns `{ strategy, route, trace, ... }`
 *   strategy: "rejoin"（繋いだ）/ "whole"（全体）/ "nudged"（誘導点を挟んだ）/ "trimmed"（中継点を落とした）/
 *             "failed"（引けない＝元の経路のまま）/ "none"（行き先が無い）
 *   trace: 判断の記録（画面が日本語にする。⚠️ ここで文を作らない）
 */
async function simulateReroute({ route, legs, position, heading = null, speed = null, bike = {}, fetchRoute }) {
  const trace = [];
  const discarded = [];
  const indexed = legs.map((l, index) => ({ ...l, index }));
  const safe = async (body) => {
    try { return await fetchRoute(body); } catch (e) { return { error: e.message }; }
  };
  /**
   * 最初の動きが近すぎるなら、いまの道の先から引き直して頭を継ぐ（`NavRerouteAhead`）。
   * ⚠️ ずらした依頼は**向きつきの1回だけ**（向き無しにすると道の先に乗らない）。駄目なら元の経路
   */
  const avoidNearTurn = async (purpose, reqLegs, got) => {
    const plan = aheadPlan(got, speed);
    if (!plan) return got;
    const shifted = await safe(rerouteBody(plan.origin, reqLegs, plan.heading, bike));
    const joined = usable(shifted) ? joinAhead(plan, shifted, got) : { reason: "failed" };
    trace.push({ kind: "ahead", purpose, firstMeters: Math.round(plan.firstMeters), threshold: Math.round(plan.threshold),
                 ok: !!joined.route, reason: joined.reason || null,
                 firstAfter: joined.route ? Math.round(firstAction(joined.route)?.meters ?? joined.route.lengthMeters) : null,
                 extraMeters: joined.route ? Math.round(joined.route.lengthMeters - got.lengthMeters) : null });
    if (!joined.route) return got;
    discarded.push({ kind: "near", points: got.points });
    return joined.route;
  };
  /** `requestReroute`: 向きつきで引けなければ向き無しで引き直す */
  const ask = async (purpose, reqLegs, reqHeading) => {
    const got = await askOnce(purpose, reqLegs, reqHeading);
    return usable(got) ? avoidNearTurn(purpose, reqLegs, got) : got;
  };
  const askOnce = async (purpose, reqLegs, reqHeading) => {
    const got = await safe(rerouteBody(position, reqLegs, reqHeading, bike));
    trace.push({ kind: "request", purpose, legs: reqLegs.map((l) => (l.index ?? null)),
                 heading: reqHeading, ok: usable(got), lengthMeters: usable(got) ? got.lengthMeters : null,
                 error: usable(got) ? null : (got && got.error) || "empty" });
    if (usable(got) || reqHeading == null) return got;
    const again = await safe(rerouteBody(position, reqLegs, null, bike));
    trace.push({ kind: "request", purpose, legs: reqLegs.map((l) => (l.index ?? null)),
                 heading: null, retryWithoutHeading: true, ok: usable(again),
                 lengthMeters: usable(again) ? again.lengthMeters : null,
                 error: usable(again) ? null : (again && again.error) || "empty" });
    return again;
  };

  const at = stepAtPosition(route, position, heading);
  if (!at) return { strategy: "failed", trace: [{ kind: "noRoute" }] };
  const routeLeg = routeLegIndexForStep(route.steps, at.stepIndex);
  const destination = routeLegEndIndex(routeLeg, legs);
  const start = routeLegStartIndex(routeLeg, legs);
  // いま向かっている行き先（アプリの `legsIndexAhead`）: 区間の最初の行き先から、通り過ぎたものを飛ばす
  const ahead = firstLegAhead(indexed, start, position, heading);
  trace.push({ kind: "position", stepIndex: at.stepIndex, lateralMeters: Math.round(at.lateralMeters),
               routeLeg, destination, start });
  const base = { position, heading, stepIndex: at.stepIndex, onRoute: at.onRoute, destination };

  // ① 外れた分だけ引き直して、元の続きに繋ぐ
  const found = rejoinSearch(route.steps, at.stepIndex);
  if (found.index == null) {
    trace.push({ kind: "rejoinSkipped", reason: found.reason });
  } else {
    const rejoinAt = found.index;
    const rejoinPoint = route.points[route.steps[rejoinAt].beginIndex];
    // 有料・高速の条件は、いま向かっている行き先の区間のもの
    const sample = indexed[ahead] || indexed[0];
    // 合流点までの1区間だけ。⚠️ 到着案内を出させない（止まる場所にしない）
    const bridge = { destination: rejoinPoint, isUserWaypoint: false, index: null,
                     avoidTolls: sample.avoidTolls, avoidHighways: sample.avoidHighways,
                     isRoadCourse: sample.isRoadCourse };
    const detour = await ask("rejoin", [bridge], heading);
    const ok = usable(detour);
    const reasonable = ok && isReasonable(detour, position, rejoinPoint);
    const joined = reasonable ? splice(detour, route, rejoinAt) : null;
    // ⚠️ 繋いだ先の曲がりが近すぎるなら繋がない（全体を引き直し、そちらで近い角を避ける）
    const tooSoon = !!joined && rejoinTurnsTooSoon(detour, joined, speed);
    const spliced = tooSoon ? null : joined;
    trace.push({ kind: "rejoin", rejoinAt, ok, reasonable, tooSoon, spliced: !!spliced,
                 detourMeters: ok ? detour.lengthMeters : null,
                 directMeters: Math.round(distance(position, rejoinPoint)) });
    if (spliced) {
      return { ...base, strategy: "rejoin", route: spliced, rejoinPoint,
               remaining: indexed.slice(ahead).map((l) => l.index), trace, discarded };
    }
    if (ok) discarded.push({ kind: "detour", points: detour.points });
  }

  // ② 全体を引き直す。⚠️ 通り過ぎた行き先は残さない（残すと「戻れ」と案内される）
  trace.push({ kind: "firstLegAhead", from: start, to: ahead });
  const remaining = indexed.slice(ahead);
  if (!remaining.length) return { ...base, strategy: "none", trace, discarded };

  const first = await ask("whole", remaining, heading);
  if (!usable(first)) {
    // 取れなくても案内は続ける（元の経路に戻れば復帰する）
    return { ...base, strategy: "failed", trace, discarded };
  }
  const done = (strategy, r, legsUsed, extra = {}) => ({
    ...base, strategy, route: r, remaining: legsUsed.map((l) => l.index), trace, discarded, ...extra });

  // ⚠️ いきなり向きを変えさせる形なら、進行方向100m先を挟んでもう一度だけ引く。
  //    ⚠️ 近すぎる曲がりを避けて先から引いた経路は挟まない（最初の動きは十分先。戻る形はそのための回り込み）
  if (startsWithUTurn(first.steps) && !first.aheadMeters) {
    const nudge = forwardNudge(position, heading, remaining[0].destination);
    trace.push({ kind: "uTurn", nudge: !!nudge,
                 reason: nudge ? null : (heading == null ? "noHeading" : "destinationBehind") });
    if (nudge) {
      const guide = { destination: nudge, isUserWaypoint: false, index: null,
                      avoidTolls: remaining[0].avoidTolls, avoidHighways: remaining[0].avoidHighways };
      // ⚠️ 挟んだ引き直しは向きを渡さない（アプリと同じ）
      const nudged = await ask("nudge", [guide, ...remaining], null);
      const fixed = usable(nudged) && !startsWithUTurn(nudged.steps);
      trace.push({ kind: "nudgeResult", ok: usable(nudged), fixed });
      if (fixed) {
        discarded.push({ kind: "uTurn", points: first.points });
        return done("nudged", nudged, remaining, { nudge });
      }
      if (usable(nudged)) discarded.push({ kind: "nudge", points: nudged.points });
      // 直らなかった・取れなかった → 挟まない経路をそのまま使う
      return done("whole", first, remaining, { nudge });
    }
  }

  // ⚠️ 中継点が側道に吸われて往復・有料に乗るなら、その中継点を落としてもう一度だけ引く
  const bad = problemLegIndices(remaining, first);
  if (bad.length) {
    const dropped = bad.map((i) => remaining[i].index);
    const trimmed = remaining.filter((_, i) => !bad.includes(i));
    trace.push({ kind: "problemLegs", dropped });
    if (!trimmed.length) return done("whole", first, remaining);
    const cleaned = await ask("trim", trimmed, heading);
    const good = usable(cleaned) && problemLegIndices(trimmed, cleaned).length === 0;
    trace.push({ kind: "trimResult", ok: usable(cleaned), good });
    if (good) {
      discarded.push({ kind: "problem", points: first.points });
      return done("trimmed", cleaned, trimmed, { dropped });
    }
    return done("whole", first, remaining);
  }
  return done("whole", first, remaining);
}

module.exports = {
  simulateReroute, rerouteBody, legPlan,
  stepAtPosition, routeLegIndexForStep, routeLegEnds, routeLegEndIndex, routeLegStartIndex,
  rejoinSearch, rejoinStepIndex, splice, isReasonable,
  startsWithUTurn, forwardNudge, firstLegAhead,
  firstAction, aheadThreshold, aheadPlan, joinAhead, rejoinTurnsTooSoon,
  tollCausingLegIndex, offendingWaypointIndices, problemLegIndices,
  bearing, angleDelta, pointFrom,
  MIN_AHEAD_METERS, MAX_DETOUR_RATIO, NUDGE_METERS, AHEAD_TOLERANCE_DEGREES, HEAD_STEP_COUNT,
  PASSED_METERS, BEHIND_TOLERANCE_DEGREES, ON_TOLL_ROAD_METERS,
  MAX_APEX_DISTANCE_METERS, DETOUR_MIN_ALONG_GAP_METERS,
  AHEAD_MIN_METERS, AHEAD_REACTION_SECONDS, AHEAD_STOPPED_SPEED, AHEAD_MAX_SNAP_METERS,
  AHEAD_MAX_EXTRA_METERS, AHEAD_BEARING_BACK_METERS, AHEAD_MIN_PAST_METERS, PASSIVE_MANEUVERS,
};
