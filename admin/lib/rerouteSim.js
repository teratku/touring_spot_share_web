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
 * ⚠️ **点は `[経度, 緯度]`。** Swift 側は `CLLocationCoordinate2D`（緯度が先）。
 * ⚠️ **なぞれないもの**（走ってきた経過が要る。画面では置いた1点しか分からない）:
 *    ・`dropCount`（わざと無視したおすすめ道路・立ち寄り先を諦める）… 最接近の距離と「着いた」区間が要る
 *    ・とばした立ち寄り先（`skippedLegIDs`）
 *    ・前の引き直しが返らないあいだの見送り・20秒の打ち切り
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
 * 経路の区間番号 → `legs` の番号（**アプリの数え方**。ナビを始めた直後の `NavRouteLegMap`）。
 *
 * ⚠️ アプリは「候補画面で全区間を組んだ経路なので、区間 i は `legs[i]`」としている。
 *    サーバは**止まる場所でしか区間を分けない**ので、通るだけの点（おすすめ道路の中継点・
 *    なぞった点）が立ち寄り先より前にあると、ここは `stopLegsIndex` とずれる。
 *    **ずれを見せるために、アプリと同じ数え方のまま残してある**
 */
function appLegsIndex(routeLeg, legs) {
  return Math.min(Math.max(routeLeg, 0), Math.max(legs.length - 1, 0));
}

/**
 * 経路の区間番号 → その区間で最初に向かう `legs` の番号（止まる場所で数えた対応）。
 *
 * 区間 k は、k 番目の立ち寄り先の次から始まる。最後の行き先は立ち寄り先でなくても区間の終わり
 */
function stopLegsIndex(routeLeg, legs) {
  if (routeLeg <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < legs.length - 1; i++) {
    if (!legs[i].isUserWaypoint) continue;
    seen++;
    if (seen === routeLeg) return i + 1;
  }
  return Math.max(legs.length - 1, 0);
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
 * @param fetchRoute `(body) => Promise<経路>`。`rerouteBody` の形を受け取って1本引く
 * @returns `{ strategy, route, trace, ... }`
 *   strategy: "rejoin"（繋いだ）/ "whole"（全体）/ "nudged"（誘導点を挟んだ）/ "trimmed"（中継点を落とした）/
 *             "failed"（引けない＝元の経路のまま）/ "none"（行き先が無い）
 *   trace: 判断の記録（画面が日本語にする。⚠️ ここで文を作らない）
 */
async function simulateReroute({ route, legs, position, heading = null, bike = {}, fetchRoute }) {
  const trace = [];
  const discarded = [];
  const indexed = legs.map((l, index) => ({ ...l, index }));
  const safe = async (body) => {
    try { return await fetchRoute(body); } catch (e) { return { error: e.message }; }
  };
  /** `requestReroute`: 向きつきで引けなければ向き無しで引き直す */
  const ask = async (purpose, reqLegs, reqHeading) => {
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
  const appIndex = appLegsIndex(routeLeg, legs);
  const byStops = stopLegsIndex(routeLeg, legs);
  trace.push({ kind: "position", stepIndex: at.stepIndex, lateralMeters: Math.round(at.lateralMeters),
               routeLeg, legsIndex: appIndex, stopLegsIndex: byStops });
  const base = { position, heading, stepIndex: at.stepIndex, onRoute: at.onRoute,
                 legsIndex: appIndex, stopLegsIndex: byStops };

  // ① 外れた分だけ引き直して、元の続きに繋ぐ
  const found = rejoinSearch(route.steps, at.stepIndex);
  if (found.index == null) {
    trace.push({ kind: "rejoinSkipped", reason: found.reason });
  } else {
    const rejoinAt = found.index;
    const rejoinPoint = route.points[route.steps[rejoinAt].beginIndex];
    const sample = indexed[appIndex] || indexed[0];
    // 合流点までの1区間だけ。⚠️ 到着案内を出させない（止まる場所にしない）
    const bridge = { destination: rejoinPoint, isUserWaypoint: false, index: null,
                     avoidTolls: sample.avoidTolls, avoidHighways: sample.avoidHighways,
                     isRoadCourse: sample.isRoadCourse };
    const detour = await ask("rejoin", [bridge], heading);
    const ok = usable(detour);
    const reasonable = ok && isReasonable(detour, position, rejoinPoint);
    const spliced = reasonable ? splice(detour, route, rejoinAt) : null;
    trace.push({ kind: "rejoin", rejoinAt, ok, reasonable, spliced: !!spliced,
                 detourMeters: ok ? detour.lengthMeters : null,
                 directMeters: Math.round(distance(position, rejoinPoint)) });
    if (spliced) {
      return { ...base, strategy: "rejoin", route: spliced, rejoinPoint,
               remaining: indexed.slice(appIndex).map((l) => l.index), trace, discarded };
    }
    if (ok) discarded.push({ kind: "detour", points: detour.points });
  }

  // ② 全体を引き直す。⚠️ 通り過ぎた行き先は残さない（残すと「戻れ」と案内される）
  const current = firstLegAhead(indexed, appIndex, position, heading);
  trace.push({ kind: "firstLegAhead", from: appIndex, to: current });
  const remaining = indexed.slice(current);
  if (!remaining.length) return { ...base, strategy: "none", trace, discarded };

  const first = await ask("whole", remaining, heading);
  if (!usable(first)) {
    // 取れなくても案内は続ける（元の経路に戻れば復帰する）
    return { ...base, strategy: "failed", trace, discarded };
  }
  const done = (strategy, r, legsUsed, extra = {}) => ({
    ...base, strategy, route: r, remaining: legsUsed.map((l) => l.index), trace, discarded, ...extra });

  // ⚠️ いきなり向きを変えさせる形なら、進行方向100m先を挟んでもう一度だけ引く
  if (startsWithUTurn(first.steps)) {
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
  stepAtPosition, routeLegIndexForStep, appLegsIndex, stopLegsIndex,
  rejoinSearch, rejoinStepIndex, splice, isReasonable,
  startsWithUTurn, forwardNudge, firstLegAhead,
  tollCausingLegIndex, offendingWaypointIndices, problemLegIndices,
  bearing, angleDelta, pointFrom,
  MIN_AHEAD_METERS, MAX_DETOUR_RATIO, NUDGE_METERS, AHEAD_TOLERANCE_DEGREES, HEAD_STEP_COUNT,
  PASSED_METERS, BEHIND_TOLERANCE_DEGREES, ON_TOLL_ROAD_METERS,
  MAX_APEX_DISTANCE_METERS, DETOUR_MIN_ALONG_GAP_METERS,
};
