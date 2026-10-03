/**
 * appFunRoute.js
 *
 * **アプリと同じ選び方**で、おすすめ道路（楽しい道）を選ぶ（調整ツールの画面で「アプリと同じ」を選んだとき）。
 * 利用者の要望（2026-09-28）:「web でおすすめ道路などの現在のも選択できるようにしたい（web だけだとわからない）」。
 *
 * 【どこから来た処理か】
 * iOS の `FunRouteBuilder.swift`（build / buildSideVariants / buildVariants と、その下の
 * isWithinCorridor・traversal・pathLength・twoOptImprove など）と、ルート候補画面
 * （`RouteCandidatesView.loadFunRoute`）の組み合わせ方、`NavGeometry.directionAxis`、
 * `FunRoadRestrictionFilter` / `RoadRestrictionMatcher`、`NavRoutePreference.detourBudgetRatio` を移したもの。
 * **定数は向こうの値をそのまま使う。** アプリを変えたら、ここも同時に変えること。
 *
 * 【Web の従来の選び方（`funRouteSelect.js`）との違い】
 *   ・遠回りの基準  … 直線×1.6 ではなく、ふつうのルートの実際の距離（`baselineMeters`）
 *   ・進み具合      … 直線ではなく、ふつうのルートの形（`referenceAxis`＝間引いた線）で測る
 *   ・選び方        … 点数のいちばん高い道ではなく、点数の差が8以内の上位5本から**ランダム**
 *   ・曲率の下限    … 札（「絶景」など）の付いた道は 300 → 150 に緩める
 *   ・区間の出口    … 次の区間に近いところで途中で切る（最低3割は走る・500m以上縮むとき）
 *   ・本数          … 最大5本
 *   ・案            … まわり方（北・東・南・西）＋ 予算違い（たっぷり・ひかえめ）。顔ぶれが同じ案はまとめる
 *   ・規制          … 二輪通行禁止・通行止めと300m以上重なる道は候補から外す
 *
 * ⚠️ **点は `[経度, 緯度]`。** 配信データの `start` / `end` は `[緯度, 経度]`（アプリと同じ）なので入口で入れ替える。
 * ⚠️ 経路を引いたあと（Uターンを見つけた道を外して選び直す・3通りの条件で引く）はアプリと同じではない。
 *    ここが揃えるのは**どの道をどの順で通すか**まで
 */
"use strict";

const { distance, project } = require("./navGeometry");
const { decode } = require("./polyline");
const { applicable } = require("./restrictionAvoid");
const { isAutoSelectable } = require("./roadTags");

// MARK: 定数（FunRouteBuilder.swift の値。⚠️ 勝手に変えないこと）

/** 軸の真上とみなす横ズレ（m）。ここより近い区間は、まわり方を持たせない */
const SIDE_NEUTRAL_METERS = 10;
/** 1回に通す区間の上限 */
const MAX_SEGMENTS = 5;
/** 「同じくらい良い」とみなす点数の幅 */
const SAME_QUALITY_SCORE_BAND = 8;
/** ランダムに選ぶ母数の上限 */
const RANDOM_POOL_SIZE = 5;
/** 自分で選ぶときの点数の下限 */
const MIN_AUTO_SCORE = 40;
const MIN_SEGMENT_LENGTH_KM = 1.0;
/** これより曲がっていない道は選ばない（度/km） */
const MIN_CURVINESS = 300;
/** 札の付いた道に許す、緩めた曲率の下限 */
const TAGGED_MIN_CURVINESS = 150;
const CORRIDOR_RATIO = 0.30;
const CORRIDOR_CAP_METERS = 25_000;
const CORRIDOR_LENGTH_FACTOR = 3.0;
const CORRIDOR_MIN_WIDTH_METERS = 5_000;
/** 「ひかえめ」の予算 */
const MODEST_DETOUR_RATIO = 1.35;
/** 「もっと寄り道」の探す幅・予算（ルート候補画面は予算違いを2案までにしているので使われない） */
const WIDE_CORRIDOR_SCALE = 2.0;
const WIDE_DETOUR_RATIO = 3.0;
/** 「別ルート」とみなす重なりの上限 */
const MAX_VARIANT_OVERLAP = 0.5;
const MAX_BACKWARD_EXCURSION_METERS = 1_000;
/** 区間を途中で切るとき、最低これだけの割合は走る */
const MIN_CUT_FRACTION = 0.3;
/** 途中で切って縮む距離がこれ未満なら公式の端点のまま */
const MIN_CUT_SAVINGS_METERS = 500;
/** 直線を道のりに直す係数 */
const CIRCUITY_FACTOR = 1.6;
/** 区間の沿線距離を信じてよい、道からの離れ（m） */
const ON_ROAD_LATERAL_THRESHOLD_METERS = 2_000;
/** 後退1mあたりの罰 */
const BACKWARD_PENALTY_WEIGHT = 1.0;

// NavRoutePreference.swift
/** これ未満のつまみは「楽しい道なし」 */
const MIN_FUN_WEIGHT = 0.01;
/** つまみを入れたときの最小の寄り道（+10%） */
const MIN_DETOUR_RATIO = 1.1;
/** つまみ全開の寄り道 */
const MAX_DETOUR_RATIO = 3.0;

// RoadRestrictionMatcher（RoadRestriction.swift）
const MATCH_TOLERANCE_METERS = 40;
const MIN_OVERLAP_METERS = 300;

// NavGeometry.directionAxis
const AXIS_MAX_POINTS = 400;
const AXIS_MIN_SPACING_METERS = 250;

/** まわり方（`FunRouteBuilder.Side`。⚠️ 並びは Side.allCases と同じ） */
const SIDES = { north: 0, east: 90, south: 180, west: 270 };
const SIDE_ORDER = ["north", "east", "south", "west"];

// MARK: 幾何

const rad = (d) => (d * Math.PI) / 180;

/** a から b への方位（度・0=北・時計回り）。`NavGeometry.bearing` */
function bearing(a, b) {
  const lat1 = rad(a[1]), lat2 = rad(b[1]);
  const dLon = rad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * 経路の形を、進み具合を測る基準に間引く（`NavGeometry.directionAxis`）。
 * ⚠️ 実ルートの点をそのまま使うと区間選びの射影回数がその点数ぶん増える
 */
function directionAxis(polyline, maxPoints = AXIS_MAX_POINTS, minSpacingMeters = AXIS_MIN_SPACING_METERS) {
  if (!(polyline.length > maxPoints)) return polyline;
  let total = 0;
  for (let i = 1; i < polyline.length; i++) total += distance(polyline[i - 1], polyline[i]);
  const spacing = Math.max(minSpacingMeters, total / maxPoints);
  const out = [polyline[0]];
  let accumulated = 0;
  for (let i = 1; i < polyline.length - 1; i++) {
    accumulated += distance(polyline[i - 1], polyline[i]);
    if (accumulated >= spacing) {
      out.push(polyline[i]);
      accumulated = 0;
    }
  }
  out.push(polyline[polyline.length - 1]);
  return out;
}

/** 配信データの `[緯度, 経度]` → `[経度, 緯度]` */
function coordinate(pair) {
  return Array.isArray(pair) && pair.length === 2 ? [pair[1], pair[0]] : null;
}

function midpoint(seg) {
  const s = coordinate(seg.start), e = coordinate(seg.end);
  if (!s || !e) return null;
  return [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2];
}

// ⚠️ 同じ計算を何万回も繰り返さないための控え（アプリと同じ理由。区間選びは traversal を何万回も呼ぶ）
const decoded = new Map();
const lengths = new Map();
const axisCache = new WeakMap();

/** 区間のポリライン（復号は1度だけ） */
function polylineOf(seg) {
  if (!seg.polyline) return [];
  let hit = decoded.get(seg.polyline);
  if (!hit) {
    if (decoded.size > 5_000) decoded.clear();
    hit = decode(seg.polyline);
    decoded.set(seg.polyline, hit);
  }
  return hit;
}

function polylineLength(seg, points) {
  let hit = lengths.get(seg.polyline);
  if (hit === undefined) {
    hit = 0;
    for (let i = 1; i < points.length; i++) hit += distance(points[i - 1], points[i]);
    if (lengths.size > 5_000) lengths.clear();
    lengths.set(seg.polyline, hit);
  }
  return hit;
}

function axisEntry(axis) {
  let e = axisCache.get(axis);
  if (!e) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of axis) {
      minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
      minLon = Math.min(minLon, p[0]); maxLon = Math.max(maxLon, p[0]);
    }
    e = { bounds: { minLat, maxLat, minLon, maxLon }, along: new Map() };
    axisCache.set(axis, e);
  }
  return e;
}

/** 基準軸の上の沿線位置（同じ点・同じ軸なら1度だけ） */
function alongOnAxis(point, axis) {
  if (!(axis.length >= 2)) return 0;
  const cache = axisEntry(axis).along;
  const key = `${point[0]},${point[1]}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    const proj = project(point, axis);
    hit = proj ? proj.along : 0;
    cache.set(key, hit);
  }
  return hit;
}

/** 点が軸の外接矩形から `meters` 以内か（射影の前の足切り） */
function isNearAxisBounds(point, axis, meters) {
  if (!(axis.length >= 2)) return true;
  const b = axisEntry(axis).bounds;
  const latMargin = meters / 111_320;
  const lonScale = Math.max(Math.cos(rad(point[1])), 0.01);
  const lonMargin = meters / (111_320 * lonScale);
  return point[1] >= b.minLat - latMargin && point[1] <= b.maxLat + latMargin
    && point[0] >= b.minLon - lonMargin && point[0] <= b.maxLon + lonMargin;
}

// MARK: 候補

/** 直線（または基準軸）から極端に外れていないか。曲率の下限もここで見る */
function isWithinCorridor(seg, origin, destination, directDistance, referenceAxis, corridorScale = 1) {
  if (!(seg.lengthKm >= MIN_SEGMENT_LENGTH_KM)) return false;
  // ⚠️ **札の付いた道は緩める。** 海沿いの快走路のように、曲がっていないが走って気持ちのよい道がある
  const hasTag = Array.isArray(seg.tags) && seg.tags.length > 0;
  if (!((seg.curviness || 0) >= (hasTag ? TAGGED_MIN_CURVINESS : MIN_CURVINESS))) return false;
  const mid = midpoint(seg);
  if (!mid) return false;
  const axis = referenceAxis || [origin, destination];
  const scale = Math.max(1, corridorScale);
  const allowed = Math.min(
    Math.min(directDistance * CORRIDOR_RATIO, CORRIDOR_CAP_METERS),
    Math.max(CORRIDOR_MIN_WIDTH_METERS, CORRIDOR_LENGTH_FACTOR * seg.lengthKm * 1000),
  ) * scale;
  if (!isNearAxisBounds(mid, axis, allowed)) return false;
  const proj = project(mid, axis);
  return !!proj && proj.lateralDistance <= allowed;
}

/** 区間が軸のどちら向きに膨らんでいるか（度）。軸の真上なら null */
function sideBearing(seg, origin, destination, referenceAxis) {
  const mid = midpoint(seg);
  if (!mid) return null;
  const proj = project(mid, referenceAxis || [origin, destination]);
  if (!proj || proj.lateralDistance < SIDE_NEUTRAL_METERS) return null;
  return bearing(proj.point, mid);
}

/** その膨らみが指定した方角の側か（半平面） */
const matchesSide = (side, b) => Math.abs(angleDelta(SIDES[side], b)) < 90;

/** 区間を、基準軸の上の進み具合で並べる */
function orderedByProgress(segments, origin, destination, referenceAxis) {
  const line = referenceAxis || [origin, destination];
  return segments
    .map((seg) => { const mid = midpoint(seg); return mid ? [seg, alongOnAxis(mid, line)] : null; })
    .filter(Boolean)
    .sort((a, b) => a[1] - b[1])
    .map((x) => x[0]);
}

function nextTarget(index, segments, destination) {
  const next = segments[index + 1];
  const mid = next && midpoint(next);
  return mid || destination;
}

/**
 * 区間をどちら向きに走るかを決めて、入口・出口を返す（`FunRouteBuilder.traversal`）。
 * 入口までの近さ＋出口から次の目標まで＋後退の罰で選び、次の目標に近いところで途中で切ることがある
 */
function traversal(seg, origin, target, tripOrigin, tripDestination, referenceAxis) {
  const start = coordinate(seg.start), end = coordinate(seg.end);
  if (!start || !end) return null;
  const points = polylineOf(seg);
  const hasPolyline = points.length >= 2;
  const totalLength = hasPolyline ? polylineLength(seg, points) : seg.lengthKm * 1000;

  let approachToStart, approachToEnd;
  const onRoad = hasPolyline ? project(origin, points) : null;
  if (onRoad && onRoad.lateralDistance <= ON_ROAD_LATERAL_THRESHOLD_METERS) {
    approachToStart = onRoad.along;
    approachToEnd = totalLength - onRoad.along;
  } else {
    approachToStart = distance(origin, start);
    approachToEnd = distance(origin, end);
  }

  const routeAxis = referenceAxis || [tripOrigin, tripDestination];
  const cursorAlong = alongOnAxis(origin, routeAxis);
  const startAlong = alongOnAxis(start, routeAxis);
  const endAlong = alongOnAxis(end, routeAxis);
  const viaStartBackward = Math.max(0, cursorAlong - startAlong) + Math.max(0, startAlong - endAlong);
  const viaEndBackward = Math.max(0, cursorAlong - endAlong) + Math.max(0, endAlong - startAlong);
  const viaStart = approachToStart + distance(end, target) + viaStartBackward * BACKWARD_PENALTY_WEIGHT;
  const viaEnd = approachToEnd + distance(start, target) + viaEndBackward * BACKWARD_PENALTY_WEIGHT;

  const entersAtStart = viaStart <= viaEnd;
  const entry = entersAtStart ? start : end;
  const officialExit = entersAtStart ? end : start;
  const officialExitCost = distance(officialExit, target);
  let exit = officialExit;
  let traversedMeters = seg.lengthKm * 1000;

  if (hasPolyline) {
    const cut = project(target, points);
    if (cut) {
      const cutAlongFromEntry = entersAtStart ? cut.along : totalLength - cut.along;
      const farEnough = cutAlongFromEntry >= totalLength * MIN_CUT_FRACTION && cutAlongFromEntry < totalLength;
      const savesEnough = officialExitCost - cut.lateralDistance >= MIN_CUT_SAVINGS_METERS;
      if (farEnough && savesEnough) {
        exit = cut.point;
        traversedMeters = cutAlongFromEntry;
      }
    }
  }
  return { entry, exit, traversedMeters };
}

/** 出発地 → 各区間（入口→出口）→ 目的地 のおおよその距離（区間の間は直線×1.6） */
function pathLength(segments, origin, destination, referenceAxis) {
  let total = 0;
  let cursor = origin;
  segments.forEach((seg, i) => {
    const t = traversal(seg, cursor, nextTarget(i, segments, destination), origin, destination, referenceAxis);
    if (!t) return;
    total += distance(cursor, t.entry) * CIRCUITY_FACTOR;
    total += t.traversedMeters;
    cursor = t.exit;
  });
  return total + distance(cursor, destination) * CIRCUITY_FACTOR;
}

/** 並べた区間を経由地（入口・出口の組）にする。⚠️ 直前の区間の出口を引き回す */
function waypointsFor(ordered, origin, destination, referenceAxis) {
  const out = [];
  let cursor = origin;
  ordered.forEach((seg, i) => {
    const t = traversal(seg, cursor, nextTarget(i, ordered, destination), origin, destination, referenceAxis);
    if (!t) return;
    out.push(t.entry, t.exit);
    cursor = t.exit;
  });
  return out;
}

/** 2-opt で並びを改善する（1m 未満の改善は揺れとして無視） */
function twoOptImprove(segments, origin, destination, referenceAxis) {
  if (segments.length < 3) return segments;
  let best = segments;
  let bestLength = pathLength(best, origin, destination, referenceAxis);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const len = pathLength(candidate, origin, destination, referenceAxis);
        if (len < bestLength - 1) {
          best = candidate;
          bestLength = len;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** 経由地にしたとき、軸の上でいちばん大きく後退する幅（m） */
function worstBackwardExcursion(segments, origin, destination, referenceAxis) {
  const wps = waypointsFor(segments, origin, destination, referenceAxis);
  if (!wps.length) return 0;
  const axis = referenceAxis || [origin, destination];
  const track = [origin, ...wps, destination];
  const alongs = track.map((p) => { const pr = project(p, axis); return pr ? pr.along : null; });
  if (alongs.some((a) => a === null)) return 0;
  let worst = 0;
  for (let i = 1; i < alongs.length; i++) worst = Math.min(worst, alongs[i] - alongs[i - 1]);
  return -worst;
}

/** つまみ（0〜1）→ 寄り道の倍率（`NavRoutePreference.detourBudgetRatio`）。入れていなければ 1.0 */
function detourBudgetRatio(funWeight) {
  if (!(funWeight >= MIN_FUN_WEIGHT)) return 1.0;
  const t = Math.max(0, Math.min(1, funWeight));
  return MIN_DETOUR_RATIO + (MAX_DETOUR_RATIO - MIN_DETOUR_RATIO) * t;
}

/** 同じくらい良い道からランダムに1本（アプリの既定） */
const randomChoice = (pool) => (pool.length ? pool[Math.floor(Math.random() * pool.length)] : null);
/** 点数のいちばん高い道（毎回同じになる。見比べるとき用） */
const topChoice = (pool) => pool[0] || null;

const lineupOf = (segments) => segments.map((s) => s.id).sort().join("|");
const sameSegments = (a, b) => a.segments.length === b.segments.length
  && a.segments.every((s, i) => s.id === b.segments[i].id);

/**
 * 楽しい区間を選んで経由地にする（`FunRouteBuilder.build`）。1本も選べなければ null
 *
 * @param o.funWeight つまみ（0〜1）。予算は `budgetRatio` を渡さなければこれから
 * @param o.baselineMeters ふつうのルートの距離。無ければ直線×1.6
 * @param o.referenceAxis 進み具合を測る形（`directionAxis` で間引いたもの）。無ければ直線
 * @param o.choose 同じくらい良い道から1本選ぶ関数（既定はランダム）
 */
function build(o) {
  const { origin, destination, segments } = o;
  if (!(o.funWeight >= MIN_FUN_WEIGHT)) return null;
  const directDistance = distance(origin, destination);
  if (!(directDistance > 0)) return null;
  const axis = o.referenceAxis || null;
  const baseline = o.baselineMeters ?? directDistance * CIRCUITY_FACTOR;
  const budget = baseline * (o.budgetRatio ?? detourBudgetRatio(o.funWeight));
  const excluding = o.excluding || new Set();
  const corridorScale = o.corridorScale ?? 1;
  const choose = o.choose || randomChoice;

  // ⚠️ 林道ぎみ・砂利道（roadTags.js の AUTO_EXCLUDED_TAGS）は自動では選ばない。アプリの FunRouteBuilder と同じ
  const inCorridor = segments.filter((s) => s.score >= MIN_AUTO_SCORE && isAutoSelectable(s) && !excluding.has(s.id)
    && isWithinCorridor(s, origin, destination, directDistance, axis, corridorScale));
  if (!inCorridor.length) return null;
  let candidates = inCorridor;
  if (o.side) {
    // ⚠️ コリドーを通したあとに掛ける。軸の真上の区間はどちらにも入れない
    candidates = inCorridor.filter((s) => {
      const b = sideBearing(s, origin, destination, axis);
      return b !== null && matchesSide(o.side, b);
    });
    if (!candidates.length) return null;
  }

  // ⚠️ 道の良さ（点数）で選び、距離は予算に収まるかだけに使う
  const byScore = candidates.slice().sort((a, b) => b.score - a.score);
  const chosen = [];
  const limit = Math.max(1, Math.min(o.maxSegmentCount ?? MAX_SEGMENTS, MAX_SEGMENTS));
  while (chosen.length < limit) {
    // ⚠️ いちばん良い1本に決め打ちしない。同じくらい良い道を数本集めて、その中から選ぶ
    const pool = [];
    let bestScore = null;
    for (const candidate of byScore) {
      if (chosen.some((s) => s.id === candidate.id)) continue;
      if (bestScore !== null && bestScore - candidate.score > SAME_QUALITY_SCORE_BAND) break;
      const trial = orderedByProgress(chosen.concat([candidate]), origin, destination, axis);
      const length = pathLength(trial, origin, destination, axis);
      if (!(length <= budget)) continue;
      if (bestScore === null) bestScore = candidate.score;
      pool.push(candidate);
      if (pool.length >= RANDOM_POOL_SIZE) break;
    }
    const picked = choose(pool);
    if (!picked || !pool.some((s) => s.id === picked.id)) break;
    chosen.push(picked);
  }
  if (!chosen.length) return null;

  const recipe = { budgetRatio: o.budgetRatio ?? null, corridorScale: Math.max(1, corridorScale), side: o.side || null };
  // ⚠️ 並べ替えても大きく後退するなら「Uターンでしか組み込めない」とみなし、点数の低い区間から諦める
  let remaining = chosen.slice();
  const uTurnOnly = [];
  while (remaining.length) {
    const ordered = twoOptImprove(orderedByProgress(remaining, origin, destination, axis), origin, destination, axis);
    const waypoints = waypointsFor(ordered, origin, destination, axis);
    if (!waypoints.length) return null;
    if (worstBackwardExcursion(ordered, origin, destination, axis) <= MAX_BACKWARD_EXCURSION_METERS) {
      return {
        waypoints, segments: ordered,
        detourRatio: pathLength(ordered, origin, destination, axis) / baseline,
        baselineMeters: baseline,
        kind: o.kind || "generous", recipe, sides: o.side ? [o.side] : [], uTurnOnly,
      };
    }
    const weakest = remaining.reduce((a, b) => (a.score <= b.score ? a : b));
    uTurnOnly.push(weakest);
    remaining = remaining.filter((s) => s.id !== weakest.id);
  }
  return null;
}

/** まわり方（北・東・南・西）ごとに作る。顔ぶれが同じ方角はまとめる（`buildSideVariants`） */
function buildSideVariants(o) {
  const results = [];
  const byLineup = new Map();
  for (const side of SIDE_ORDER) {
    const pick = build({ ...o, side, kind: "generous" });
    if (!pick) continue;
    const lineup = lineupOf(pick.segments);
    if (byLineup.has(lineup)) { results[byLineup.get(lineup)].sides.push(side); continue; }
    byLineup.set(lineup, results.length);
    results.push(pick);
  }
  return results;
}

/** 予算違い（たっぷり・ひかえめ・別ルート・もっと寄り道）を作る（`buildVariants`） */
function buildVariants(o) {
  const maxVariants = o.maxVariants ?? 3;
  const generous = build({ ...o, kind: "generous" });
  if (!generous) return [];
  const variants = [generous];
  if (maxVariants < 2) return variants;
  // ⚠️ 全部の案で同じ予算・同じ幅を使う
  const effectiveBudget = o.budgetRatio ?? detourBudgetRatio(o.funWeight);
  const effectiveCorridor = Math.max(1, o.corridorScale ?? 1);
  const modest = build({ ...o, budgetRatio: Math.min(MODEST_DETOUR_RATIO, effectiveBudget),
                         corridorScale: effectiveCorridor, kind: "modest" });
  if (modest && !sameSegments(modest, generous)) variants.push(modest);
  if (maxVariants < 3) return variants;

  const top = new Set(generous.segments.slice().sort((a, b) => b.score - a.score).slice(0, 2).map((s) => s.id));
  const alternate = build({ ...o, budgetRatio: effectiveBudget, excluding: top,
                            corridorScale: effectiveCorridor, kind: "alternate" });
  if (alternate && !variants.some((v) => sameSegments(v, alternate))
      && variants.every((v) => overlapRatio(v.segments, alternate.segments) < MAX_VARIANT_OVERLAP)) {
    variants.push(alternate);
  }
  if (variants.length < maxVariants) {
    const wide = build({ ...o, budgetRatio: Math.max(WIDE_DETOUR_RATIO, effectiveBudget),
                         corridorScale: Math.max(WIDE_CORRIDOR_SCALE, effectiveCorridor), kind: "wide" });
    if (wide && !variants.some((v) => sameSegments(v, wide))
        && wide.segments.some((c) => !variants.some((v) => v.segments.some((s) => s.id === c.id)))) {
      variants.push(wide);
    }
  }
  return variants;
}

function overlapRatio(a, b) {
  const A = new Set(a.map((s) => s.id)), B = new Set(b.map((s) => s.id));
  const union = new Set([...A, ...B]);
  if (!union.size) return 0;
  let both = 0;
  for (const id of A) if (B.has(id)) both++;
  return both / union.size;
}

// MARK: 規制と重なる道を外す（FunRoadRestrictionFilter / RoadRestrictionMatcher）

function distanceToSegment(p, a, b) {
  const scale = Math.cos(rad(p[1]));
  const px = (p[0] - a[0]) * scale * 111_320, py = (p[1] - a[1]) * 111_320;
  const ex = (b[0] - a[0]) * scale * 111_320, ey = (b[1] - a[1]) * 111_320;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return Math.sqrt(px * px + py * py);
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / len2));
  return Math.hypot(px - t * ex, py - t * ey);
}

function roughDistance(a, b) {
  const dLat = (a[1] - b[1]) * 111_320;
  const dLng = (a[0] - b[0]) * 111_320 * Math.cos(rad(a[1]));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** 区間のうち、規制の線に沿って走っている長さ（いちばん長いひと続き） */
function overlapMeters(route, target) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of target) {
    minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
    minLng = Math.min(minLng, p[0]); maxLng = Math.max(maxLng, p[0]);
  }
  const inBox = (p) => {
    const dLat = MATCH_TOLERANCE_METERS / 111_320;
    const dLng = MATCH_TOLERANCE_METERS / (111_320 * Math.cos(rad(p[1])));
    return p[1] >= minLat - dLat && p[1] <= maxLat + dLat && p[0] >= minLng - dLng && p[0] <= maxLng + dLng;
  };
  const near = (p) => {
    let best = Infinity;
    for (let i = 1; i < target.length; i++) {
      best = Math.min(best, distanceToSegment(p, target[i - 1], target[i]));
      if (best < 1) break;
    }
    return best <= MATCH_TOLERANCE_METERS;
  };
  let best = 0, run = 0, running = false;
  for (let i = 0; i < route.length; i++) {
    if (inBox(route[i]) && near(route[i])) {
      // ⚠️ アプリと同じく、入った1辺（直前の点から）も数える
      if (i > 0) run += roughDistance(route[i - 1], route[i]);
      running = true;
    } else {
      if (running) best = Math.max(best, run);
      running = false;
      run = 0;
    }
  }
  if (running) best = Math.max(best, run);
  return best;
}

/**
 * 候補から外す区間か（二輪通行禁止・通行止めと300m以上重なる）。
 * ⚠️ 走る日時が分からないときは時間を見ずに避ける（避けすぎ側。アプリと同じ）
 */
function isBlockedByRestrictions(points, restrictions, displacement, at) {
  if (!(points.length >= 2)) return false;
  const target = applicable(restrictions, { displacement, at });
  return target.some((r) => overlapMeters(points, r.points) >= MIN_OVERLAP_METERS);
}

// MARK: ルート候補画面の組み合わせ（RouteCandidatesView.loadFunRoute）

/**
 * ルート候補画面と同じ組み合わせで案を作る: まわり方（北・東・南・西）を先に、
 * 予算違いは2案まで（たっぷり・ひかえめ）。顔ぶれが同じ案は出さない。
 *
 * @param o.referencePolyline ふつうのルートの線（`[経度, 緯度]` の並び）。間引いて基準軸にする
 * @param o.restrictions 規制（`data/road-restrictions` の形）。渡さなければ外さない
 */
function appFunVariants(o) {
  const all = o.segments || [];
  const usable = (o.restrictions && o.restrictions.length)
    ? all.filter((s) => !isBlockedByRestrictions(polylineOf(s), o.restrictions, o.displacement, o.at))
    : all;
  const referenceAxis = Array.isArray(o.referencePolyline) && o.referencePolyline.length >= 2
    ? directionAxis(o.referencePolyline) : null;
  const common = { origin: o.origin, destination: o.destination, segments: usable, funWeight: o.funWeight,
                   baselineMeters: o.baselineMeters, referenceAxis, choose: o.choose,
                   maxSegmentCount: o.maxSegmentCount ?? MAX_SEGMENTS };
  const sideVariants = buildSideVariants(common);
  const budgetVariants = buildVariants({ ...common, maxVariants: 2 });
  const seen = new Set(sideVariants.map((v) => lineupOf(v.segments)));
  const variants = sideVariants.slice();
  for (const v of budgetVariants) {
    const lineup = lineupOf(v.segments);
    if (seen.has(lineup)) continue;
    seen.add(lineup);
    variants.push(v);
  }
  // ⚠️ `common` も返す。往復を見つけた道を外して選び直すとき、同じ条件（基準・軸・つまみ）で作り直すため
  return { variants, usableCount: usable.length, blockedCount: all.length - usable.length, referenceAxis, common };
}

module.exports = {
  appFunVariants, build, buildSideVariants, buildVariants, detourBudgetRatio, directionAxis,
  isWithinCorridor, sideBearing, orderedByProgress, traversal, pathLength, waypointsFor, twoOptImprove,
  worstBackwardExcursion, isBlockedByRestrictions, overlapMeters, randomChoice, topChoice, polylineOf,
  MAX_SEGMENTS, SAME_QUALITY_SCORE_BAND, RANDOM_POOL_SIZE, MIN_AUTO_SCORE, MIN_CURVINESS, TAGGED_MIN_CURVINESS,
  MODEST_DETOUR_RATIO, MIN_DETOUR_RATIO, MAX_DETOUR_RATIO, MIN_FUN_WEIGHT, CIRCUITY_FACTOR,
  MIN_CUT_FRACTION, MIN_CUT_SAVINGS_METERS, MATCH_TOLERANCE_METERS, MIN_OVERLAP_METERS, SIDE_ORDER,
};
