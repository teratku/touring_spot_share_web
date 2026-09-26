"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { routeWithValhalla, BASE } = require("../lib/valhallaRoute");
const seg = require("../lib/segmentedRoute");

/**
 * 区間ごとに有料・高速の条件が違うルートを、Valhalla で引く。
 *
 * ⚠️ **材料は実際の Valhalla の結果。** つなぎ目の到着・出発の指示や、
 *    線の番号のずれは、手で作った結果では再現できない。
 *    Valhalla が居ないときは、つなぐ処理に関わる検査を飛ばす。
 */
async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}
const skipIfDown = async (t) => ((await up()) ? false : t.skip(`Valhalla が居ない（${BASE}）`));

const NIIZA = [139.5693, 35.7936];
const HAKONE = [139.1069, 35.2324];
const OPEN = { avoidTolls: false, avoidHighways: false };
const SURFACE = { avoidTolls: true, avoidHighways: true };
const meters = (a, b) => Math.hypot((b[0] - a[0]) * 91000, (b[1] - a[1]) * 111000);

/** 新座→箱根を高速ありで引いた線（切り替え地点を置く土台） */
let baseCache = null;
async function base() {
  if (!baseCache) baseCache = await routeWithValhalla(NIIZA, HAKONE, { displacement: "large" });
  return baseCache;
}
/** 線の上で、指定の種別の区間のまん中の点 */
function midOf(route, kind, which) {
  const spans = route.kindSpans.filter((s) => s.kind === kind);
  const sp = which === "last" ? spans[spans.length - 1] : spans[0];
  return route.points[Math.floor((sp.begin + sp.end) / 2)];
}
function indexNear(route, p) {
  return route.points.findIndex((q) => meters(q, p) < 30);
}
/** 点の前後30mで向きがどれだけ変わるか（度） */
function turnAt(points, idx) {
  const brg = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  let i = idx, j = idx, d = 0;
  while (i > 0 && d < 30) { d += meters(points[i - 1], points[i]); i--; }
  d = 0;
  while (j < points.length - 1 && d < 30) { d += meters(points[j], points[j + 1]); j++; }
  return Math.abs(((brg(points[idx], points[j]) - brg(points[i], points[idx]) + 540) % 360) - 180);
}
function assertWellFormed(route) {
  assert.ok(!route.error, route.error);
  const st = route.steps;
  for (let i = 1; i < st.length; i++) {
    assert.strictEqual(st[i].beginIndex, st[i - 1].endIndex, `指示 ${i} の番号が前とつながっていない`);
  }
  assert.ok(st.every((s) => s.beginIndex >= 0 && s.endIndex < route.points.length && s.beginIndex <= s.endIndex),
    "線の番号が範囲の外にある（アプリで指示が捨てられる）");
  const total = st.reduce((a, s) => a + s.distanceMeters, 0);
  assert.ok(Math.abs(total - route.lengthMeters) < route.lengthMeters * 0.02,
    `指示の距離の合計 ${total}m が全長 ${route.lengthMeters}m と合わない`);
  assert.strictEqual(route.durationSeconds, st.reduce((a, s) => a + s.durationSeconds, 0),
    "所要時間の合計が指示の合計と合わない");
  for (const sp of route.kindSpans) {
    assert.ok(sp.begin >= 0 && sp.end < route.points.length, "塗り分けの区間が線の外にある");
  }
}

// ─── まとまりの分け方（Valhalla 不要） ───

test("条件の同じ区間を1つのまとまりにする", () => {
  assert.deepStrictEqual(seg.splitRuns([OPEN, OPEN, SURFACE, SURFACE, OPEN]), [
    { firstLeg: 0, lastLeg: 1, ...OPEN },
    { firstLeg: 2, lastLeg: 3, ...SURFACE },
    { firstLeg: 4, lastLeg: 4, ...OPEN },
  ]);
  // 有料だけ違っても別のまとまり
  assert.strictEqual(seg.splitRuns([OPEN, { avoidTolls: true, avoidHighways: false }]).length, 2);
  assert.strictEqual(seg.splitRuns([OPEN, { avoidTolls: false, avoidHighways: true }]).length, 2);
  assert.deepStrictEqual(seg.splitRuns([]), []);
  assert.strictEqual(seg.hasMixedConditions([OPEN, OPEN]), false);
  assert.strictEqual(seg.hasMixedConditions([OPEN, SURFACE]), true);
});

test("線の最後の向きを測る（同じ点が続いても飛ばす）", () => {
  const north = seg.endBearing([[139, 35], [139, 35.01], [139, 35.01]]);
  assert.ok(Math.abs(north - 0) < 1 || Math.abs(north - 360) < 1, `北向きが ${north}°`);
  const east = seg.endBearing([[139, 35], [139.01, 35]]);
  assert.ok(Math.abs(east - 90) < 1, `東向きが ${east}°`);
  assert.strictEqual(seg.endBearing([[139, 35]]), null);
});

// ─── 実際の Valhalla で ───

test("条件がそろっていれば、いつもの引き方と同じ道になる", async (t) => {
  if (await skipIfDown(t)) return;
  const mid = midOf(await base(), "expressway");
  const plain = await routeWithValhalla(NIIZA, HAKONE, { displacement: "large", vias: [mid] });
  const same = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
    displacement: "large", vias: [mid], legConditions: [OPEN, OPEN] });
  assert.strictEqual(same.polyline, plain.polyline, "条件がそろっているのに道が変わった");
  assert.strictEqual(same.segments, undefined, "そろっているのに区間ごとに引いている");
});

test("条件の数が合わなければ区間ごとには引かない", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
    displacement: "large", vias: [], avoidTolls: true, avoidHighways: true,
    legConditions: [OPEN, SURFACE] });
  assert.strictEqual(r.segments, undefined, "数が合わないのに区間ごとに引いた");
  assert.strictEqual(r.kindMeters.expressway, 0, "上の条件（下道のみ）が効いていない");
});

test("前半下道のみ → 後半高速あり：前半に高速・有料が入らない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 目的地側の下道で切り替える（出発直後だと前半が短すぎて確かめにならない）
  const mid = midOf(await base(), "surface", "last");
  const r = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
    displacement: "large", vias: [mid], legConditions: [SURFACE, OPEN] });
  assertWellFormed(r);
  assert.strictEqual(r.segments, 2, "区間ごとに引いていない");
  const k = indexNear(r, mid);
  assert.ok(k > 0, "材料が悪い: 切り替え地点を通っていない");
  const before = r.kindSpans.filter((s) => s.end <= k && s.kind !== "surface");
  assert.deepStrictEqual(before, [], "下道のみの区間に高速・有料が入った");
});

test("前半高速あり → 後半下道のみ：後半は次の出口のあとに高速を使わない", async (t) => {
  if (await skipIfDown(t)) return;
  const b = await base();
  const mid = midOf(b, "expressway");
  const r = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
    displacement: "large", vias: [mid], legConditions: [OPEN, SURFACE] });
  assertWellFormed(r);
  const k = indexNear(r, mid);
  assert.ok(k > 0, "材料が悪い: 切り替え地点を通っていない");
  assert.ok(r.kindSpans.some((s) => s.end <= k && s.kind === "expressway"), "材料が悪い: 前半で高速を使っていない");
  // ⚠️ 高速の上で切り替えたので、次の出口までは高速を走るしかない。
  //    **いったん下道に降りたら、もう高速に戻らない**こと
  const after = r.kindSpans.filter((s) => s.begin >= k);
  const firstSurface = after.findIndex((s) => s.kind === "surface" && s.meters > 500);
  assert.ok(firstSurface >= 0, "後半で下道に降りていない");
  const back = after.slice(firstSurface).filter((s) => s.kind === "expressway");
  assert.deepStrictEqual(back, [], "下道に降りたあと、また高速に乗った");
});

test("切り替え地点では「到着」も「出発」も言わない", async (t) => {
  if (await skipIfDown(t)) return;
  const mid = midOf(await base(), "surface", "last");
  const r = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
    displacement: "large", vias: [mid], legConditions: [SURFACE, OPEN] });
  assertWellFormed(r);
  const arrivals = r.steps.filter((s) => seg.ARRIVAL_TYPES.has(s.valhallaType));
  const departures = r.steps.filter((s) => seg.DEPARTURE_TYPES.has(s.valhallaType));
  assert.strictEqual(arrivals.length, 1, "切り替え地点に到着の指示が残っている（「目的地付近です」と言う）");
  assert.strictEqual(departures.length, 1, "切り替え地点に出発の指示が残っている（「直進します」と言う）");
  assert.strictEqual(r.steps.filter((s) => s.isLegEnd).length, 1, "切り替え地点が立ち寄り先になっている");
  assert.ok(r.steps[r.steps.length - 1].isLegEnd, "最後の指示が到着になっていない");
});

test("切り替え地点で折り返さない", async (t) => {
  if (await skipIfDown(t)) return;
  const b = await base();
  for (const [name, mid, conds] of [
    ["下道→高速", midOf(b, "surface", "last"), [SURFACE, OPEN]],
    ["高速→下道", midOf(b, "expressway"), [OPEN, SURFACE]],
  ]) {
    const r = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
      displacement: "large", vias: [mid], legConditions: conds });
    const k = indexNear(r, mid);
    assert.ok(k > 0, `材料が悪い: ${name} で切り替え地点を通っていない`);
    const turn = turnAt(r.points, k);
    assert.ok(turn < 120, `${name}: 切り替え地点で ${Math.round(turn)}° 向きを変えている（折り返し）`);
    assert.strictEqual(r.uTurns, 0, `${name}: Uターンの指示がある`);
  }
});

test("次のまとまりは、前のまとまりの最後の向きで出発させる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 向きを渡さないと、切り替え地点で逆を向く経路が返ることがある。
  //    ここでは「渡しているか」を、呼び出しを差し替えて確かめる
  const valhalla = require("../lib/valhallaRoute");
  const calls = [];
  const original = valhalla.routeWithValhalla;
  const mid = midOf(await base(), "expressway");
  // routeWithValhallaSegmented は読み込み時の関数を持っているので、モジュールを読み直す
  delete require.cache[require.resolve("../lib/segmentedRoute")];
  valhalla.routeWithValhalla = async (from, to, opts) => {
    calls.push({ from, heading: opts.heading, arriveOnNearSide: opts.arriveOnNearSide });
    return original(from, to, opts);
  };
  try {
    const fresh = require("../lib/segmentedRoute");
    await fresh.routeWithValhallaSegmented(NIIZA, HAKONE, {
      displacement: "large", vias: [mid], legConditions: [OPEN, SURFACE], arriveOnNearSide: true });
  } finally {
    valhalla.routeWithValhalla = original;
    delete require.cache[require.resolve("../lib/segmentedRoute")];
  }
  assert.strictEqual(calls.length, 2, "材料が悪い: 2回に分けて引いていない");
  assert.strictEqual(calls[0].heading, undefined, "最初のまとまりに向きを付けている");
  assert.ok(Number.isFinite(calls[1].heading), "次のまとまりに向きを渡していない");
  // ⚠️ 着く側の寄せは最後だけ（切り替え地点で寄せると回り込む）
  assert.strictEqual(calls[0].arriveOnNearSide, false, "切り替え地点に着く側を寄せている");
  assert.strictEqual(calls[1].arriveOnNearSide, true, "目的地に着く側を寄せていない");
});

test("通り抜けの指定も、まとまりごとに番号を振り直す", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **元の番号のまま渡すと、別の立ち寄り先が通り抜けになる**
  //    （おすすめ道路の終点を通り抜けにしたいのに、手前の立ち寄り先が対象になる）
  const valhalla = require("../lib/valhallaRoute");
  const calls = [];
  const original = valhalla.routeWithValhalla;
  const base0 = await base();
  const mid = midOf(base0, "expressway");
  delete require.cache[require.resolve("../lib/segmentedRoute")];
  valhalla.routeWithValhalla = async (from, to, opts) => {
    calls.push({ vias: opts.vias, stopAt: opts.stopAt, throughStopAt: opts.throughStopAt });
    return original(from, to, opts);
  };
  try {
    const fresh = require("../lib/segmentedRoute");
    // 経由地は [切り替え地点, 立ち寄り先A, 道の終点]。後ろのまとまりに2点入る
    const at = (f) => base0.points[Math.floor(base0.points.length * f)];
    await fresh.routeWithValhallaSegmented(NIIZA, HAKONE, {
      displacement: "large", vias: [mid, at(0.8), at(0.9)], stopAt: [1, 2], throughStopAt: [2],
      legConditions: [OPEN, SURFACE, SURFACE, SURFACE] });
  } finally {
    valhalla.routeWithValhalla = original;
    delete require.cache[require.resolve("../lib/segmentedRoute")];
  }
  assert.strictEqual(calls.length, 2, `材料が悪い: 2回に分けていない（${calls.length}回）`);
  assert.deepStrictEqual(calls[0].throughStopAt, [], "最初のまとまりに通り抜けが漏れている");
  // 後ろのまとまりの経由地は [立ち寄り先A, 道の終点] なので、番号は 0 と 1
  assert.deepStrictEqual(calls[1].stopAt, [0, 1], `立ち寄り先の番号がずれている: ${calls[1].stopAt}`);
  assert.deepStrictEqual(calls[1].throughStopAt, [1],
    `通り抜けの番号がずれている: ${calls[1].throughStopAt}`);
});

test("立ち寄り先で切り替えるときは、到着と出発を残す", async (t) => {
  if (await skipIfDown(t)) return;
  const mid = midOf(await base(), "surface", "last");
  const r = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
    displacement: "large", vias: [mid], stopAt: [0], legConditions: [SURFACE, OPEN] });
  assertWellFormed(r);
  assert.strictEqual(r.steps.filter((s) => s.isLegEnd).length, 2, "立ち寄り先に着いても知らせられない");
  assert.strictEqual(r.steps.filter((s) => seg.ARRIVAL_TYPES.has(s.valhallaType)).length, 2);
});

test("つないでも所要時間と距離が減らない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **全体の合計と指示の合計を比べるだけでは足りない。** つなぐときに出発の指示の
  //    時間を落としても、両方が同じだけ減るので合ってしまう（実際に素通りした）。
  //    つなぐ前の、まとまりごとの合計と比べる
  const mid = midOf(await base(), "expressway");
  const p1 = await routeWithValhalla(NIIZA, mid, { displacement: "large" });
  const p2 = await routeWithValhalla(mid, HAKONE, {
    displacement: "large", avoidTolls: true, avoidHighways: true, heading: seg.endBearing(p1.points) });
  assert.ok(!p1.error && !p2.error, "材料が悪い: まとまりが引けない");
  const merged = seg.mergeRuns([p1, p2], [false]);
  assertWellFormed(merged);
  // 消すのは到着の指示（0秒・0m）だけなので、合計は変わらない
  assert.strictEqual(merged.durationSeconds, p1.durationSeconds + p2.durationSeconds,
    "つないだら所要時間が減った（出発の指示の時間を落としている）");
  assert.strictEqual(merged.steps.reduce((a, s) => a + s.distanceMeters, 0),
    p1.steps.reduce((a, s) => a + s.distanceMeters, 0) + p2.steps.reduce((a, s) => a + s.distanceMeters, 0),
    "つないだら指示の距離が減った");
  assert.strictEqual(merged.steps.length, p1.steps.length + p2.steps.length - 2,
    "消した指示の数が違う（到着1つ・出発1つのはず）");
});

test("経由地をずらした記録は、まとまりごとに足し合わせる", () => {
  // ⚠️ `...last` のままだと最後のまとまりの分しか残らず、アプリが前のまとまりの
  //    マーカーを元の位置（線から離れた所）に描く
  const part = (fixes, merged) => ({
    points: [[139.0, 35.0], [139.001, 35.0]],
    steps: [{ maneuver: "straight", valhallaType: 1, distanceMeters: 91, durationSeconds: 9, beginIndex: 0, endIndex: 1 },
            { maneuver: "none", valhallaType: 4, distanceMeters: 0, durationSeconds: 0, beginIndex: 1, endIndex: 1, isLegEnd: true }],
    viaLoops: { found: fixes.length, left: 0, fixes, redraws: 1 },
    falseExitsMerged: merged,
  });
  const a = { via: 9, how: "trim", from: [140.39445, 38.23997], meters: 560, at: [140.400436, 38.241783] };
  const b = { via: 0, how: "move", from: [140.4861, 38.6014], meters: 213, at: [140.488158, 38.600361] };
  const merged = seg.mergeRuns([part([a], 1), part([b], 0)], [true]);
  assert.deepStrictEqual(merged.viaLoops.fixes, [a, b], "前のまとまりのずらした記録が消えた");
  assert.strictEqual(merged.viaLoops.found, 2);
  assert.strictEqual(merged.viaLoops.redraws, 2);
  assert.strictEqual(merged.falseExitsMerged, 1, "前のまとまりでまとめた偽の出口の数が消えた");
});

test("避けられなかった有料は、有料を避けるまとまりの分だけ数える", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 数えすぎると、アプリが「避けられなかった」と判断して有料を禁止して引き直す
  const mid = midOf(await base(), "expressway");
  const r = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
    displacement: "large", vias: [mid], legConditions: [OPEN, SURFACE] });
  assertWellFormed(r);
  const k = indexNear(r, mid);
  // ⚠️ 日本の高速は有料なので、「避けられなかった有料」には高速の区間も入る
  const tollBefore = r.kindSpans.filter((s) => s.end <= k && s.kind !== "surface").reduce((a, s) => a + s.meters, 0);
  assert.ok(tollBefore > 1000, `材料が悪い: 有料を使ってよい前半に有料が無い（${tollBefore}m）`);
  assert.ok(r.tollUnavoidableMeters < tollBefore,
    `有料を使ってよい区間の有料 ${tollBefore}m まで「避けられなかった」に数えている（${r.tollUnavoidableMeters}m）`);
  // 条件を知らないとき（つなぐだけの呼び方）は、全部を足す
  const merged = seg.mergeRuns([r, r], [true]);
  assert.strictEqual(merged.tollUnavoidableMeters, r.tollUnavoidableMeters * 2);
});

test("有料の禁止は、有料を避けるまとまりにだけ効かせる", async (t) => {
  if (await skipIfDown(t)) return;
  const valhalla = require("../lib/valhallaRoute");
  const calls = [];
  const original = valhalla.routeWithValhalla;
  const mid = midOf(await base(), "expressway");
  delete require.cache[require.resolve("../lib/segmentedRoute")];
  valhalla.routeWithValhalla = async (from, to, opts) => {
    calls.push({ avoidTolls: opts.avoidTolls, excludeTolls: opts.excludeTolls });
    return original(from, to, opts);
  };
  try {
    const fresh = require("../lib/segmentedRoute");
    await fresh.routeWithValhallaSegmented(NIIZA, HAKONE, {
      displacement: "large", vias: [mid], legConditions: [OPEN, SURFACE], excludeTolls: true });
  } finally {
    valhalla.routeWithValhalla = original;
    delete require.cache[require.resolve("../lib/segmentedRoute")];
  }
  assert.deepStrictEqual(calls, [
    { avoidTolls: false, excludeTolls: false },
    { avoidTolls: true, excludeTolls: true },
  ], "有料の禁止が、有料を使ってよい区間にも効いている");
});

test("3つのまとまりでも番号と合計がずれない", async (t) => {
  if (await skipIfDown(t)) return;
  const b = await base();
  const m1 = b.points[Math.floor(b.points.length * 0.3)];
  const m2 = b.points[Math.floor(b.points.length * 0.7)];
  const r = await seg.routeWithValhallaSegmented(NIIZA, HAKONE, {
    displacement: "large", vias: [m1, m2], legConditions: [SURFACE, OPEN, SURFACE] });
  assertWellFormed(r);
  assert.strictEqual(r.segments, 3);
  const km = r.kindMeters;
  assert.strictEqual(km.expressway + km.toll + km.surface,
    r.kindSpans.reduce((a, s) => a + s.meters, 0), "種別ごとの距離が区間の合計と合わない");
});

test("避けきれなかったスマートIC（ETC専用）は、まとまりごとに足し合わせる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ `...last` のままだと前のまとまりで通るスマートICを黙って落とす（ETCが無いと出入りできない）
  const r = await base();
  const merged = seg.mergeRuns([{ ...r, etcOnlyIcs: ["前のスマートIC"], etcOnlyTries: 2 },
                                { ...r, etcOnlyIcs: ["後のスマートIC", "前のスマートIC"], etcOnlyTries: 1 }], [true]);
  assert.deepStrictEqual(merged.etcOnlyIcs, ["前のスマートIC", "後のスマートIC"]);
  assert.strictEqual(merged.etcOnlyTries, 3);
  // 車載器ありで引いたもの（項目が無い）は、足しても項目を作らない
  assert.ok(!("etcOnlyIcs" in seg.mergeRuns([r, r], [true])), "頼まれていないのに ETC の項目を返した");
});

// MARK: 経由地があるときの行き方違い（利用者の要望 2026-09-26: おすすめ道路でも複数出てほしい）

/** 手で作る結果（つなぐ処理が読む項目だけ） */
function fakePart(points, { seconds = 600, uTurns = 0, alternates = [], arrive = true } = {}) {
  const last = points.length - 1;
  const steps = [
    { maneuver: "depart", valhallaType: 1, beginIndex: 0, endIndex: last, distanceMeters: 1000, durationSeconds: seconds, roadKind: "surface" },
    ...(arrive ? [{ maneuver: "arrive", valhallaType: 4, beginIndex: last, endIndex: last, distanceMeters: 0, durationSeconds: 0, roadKind: "surface", isLegEnd: true }] : []),
  ];
  return { points, steps, kindSpans: [], wastefulLoopSpans: [], classSpans: null, lengthMeters: 1000,
           durationSeconds: seconds, uTurns, alternates };
}

/** 呼ばれ方を記録する経路の関数 */
function recorder(answers) {
  const calls = [];
  const route = async (from, to, opts) => {
    calls.push({ from, to, opts });
    return answers[calls.length - 1];
  };
  return { calls, route };
}

const A = [139.0, 35.0], V1 = [139.1, 35.1], V2 = [139.2, 35.2], B = [139.3, 35.3];

test("経由地があれば、最初の経由地までを代替つきで引き、残りを1回引いてつなぐ", async () => {
  const main = fakePart([A, V1, V2, B], { seconds: 1200 });
  const alt1 = fakePart([A, [139.05, 35.02], V1], { seconds: 700 });
  const alt2 = fakePart([A, [139.02, 35.07], V1], { seconds: 750 });
  const head = fakePart([A, V1], { seconds: 600, alternates: [alt1, alt2] });
  const tail = fakePart([V1, V2, B], { seconds: 600 });
  const { calls, route } = recorder([head, tail]);
  const opts = { vias: [V1, V2], viaHeadings: [250, null], stopAt: [1], throughStopAt: [1], alternates: 2, arriveOnNearSide: true };
  const out = await seg.withHeadAlternates(main, A, B, opts, route);
  assert.strictEqual(calls.length, 2);
  // 最初の経由地まで: 経由地なし・本命と同じ向きで着く・代替を頼む・着く側の寄せはしない
  assert.deepStrictEqual([calls[0].from, calls[0].to], [A, V1]);
  assert.deepStrictEqual(calls[0].opts.vias, []);
  assert.strictEqual(calls[0].opts.toHeading, 250, "入口へ本命と同じ向きで着かせていない");
  assert.strictEqual(calls[0].opts.alternates, 2);
  assert.strictEqual(calls[0].opts.arriveOnNearSide, false, "経由地で着く側に寄せている");
  // 最初の経由地から先: 残りの経由地・番号を振り直す・着いた向きで出発・代替は頼まない
  assert.deepStrictEqual([calls[1].from, calls[1].to], [V1, B]);
  assert.deepStrictEqual(calls[1].opts.vias, [V2]);
  assert.deepStrictEqual(calls[1].opts.stopAt, [0], "立ち寄り先の番号を振り直していない");
  assert.deepStrictEqual(calls[1].opts.throughStopAt, [0], "通り抜けの番号を振り直していない");
  assert.strictEqual(calls[1].opts.heading, 250, "最初の経由地で折り返させる向きで出発している");
  assert.strictEqual(calls[1].opts.alternates, 0);
  assert.strictEqual(calls[1].opts.arriveOnNearSide, true, "最後の目的地の寄せを落とした");
  // 本命はそのまま、代替は2本。線は「入口まで」＋「入口から先」
  assert.strictEqual(out.steps, main.steps, "本命を差し替えた");
  assert.strictEqual(out.alternates.length, 2);
  assert.deepStrictEqual(out.alternates[0].points, [A, [139.05, 35.02], V1, V2, B]);
  assert.deepStrictEqual(out.alternates[1].points, [A, [139.02, 35.07], V1, V2, B]);
  // ⚠️ 最初の経由地は通るだけ（止まらない）なので、そこでの到着・出発は言わない
  assert.ok(!out.alternates[0].steps.slice(0, -1).some((s) => s.maneuver === "arrive"), "通るだけの経由地で到着と言う");
  assert.strictEqual(out.alternates[0].durationSeconds, 1300);
});

test("最初の経由地が立ち寄り先なら、そこでの到着を残す", async () => {
  const main = fakePart([A, V1, B], { seconds: 1200 });
  const head = fakePart([A, V1], { seconds: 600, alternates: [fakePart([A, [139.05, 35.02], V1], { seconds: 700 })] });
  const tail = fakePart([V1, B], { seconds: 600 });
  const { route } = recorder([head, tail]);
  const out = await seg.withHeadAlternates(main, A, B, { vias: [V1], stopAt: [0], alternates: 2 }, route);
  const arrivals = out.alternates[0].steps.filter((s) => s.maneuver === "arrive");
  assert.strictEqual(arrivals.length, 2, "立ち寄り先での到着を消した");
});

test("つないだ先が本命と食い違うときは、代替を足さない（入口から別の道に吸い付いた）", async () => {
  const main = fakePart([A, V1, B], { seconds: 1200 });
  const head = fakePart([A, V1], { seconds: 600, alternates: [fakePart([A, [139.05, 35.02], V1], { seconds: 700 })] });
  // 実測・高崎神流秩父線: 入口から先が林道に吸い付き、本命より大幅に長い
  const slowTail = fakePart([V1, B], { seconds: 1200 });
  const out = await seg.withHeadAlternates(main, A, B, { vias: [V1], alternates: 2 }, recorder([head, slowTail]).route);
  assert.strictEqual(out.alternates, main.alternates, "食い違うのに代替を足した");
  // 2割＋2分までは許す
  const okTail = fakePart([V1, B], { seconds: 1200 * 1.2 + 120 - 600 });
  const ok = await seg.withHeadAlternates(main, A, B, { vias: [V1], alternates: 2 }, recorder([head, okTail]).route);
  assert.strictEqual(ok.alternates.length, 1, "許す範囲なのに足さなかった");
});

test("本命より多くUターンする代替は落とす", async () => {
  const main = fakePart([A, V1, B], { seconds: 1200, uTurns: 0 });
  const tangled = fakePart([A, [139.05, 35.02], V1], { seconds: 700 });
  tangled.steps.splice(1, 0, { maneuver: "uturnLeft", valhallaType: 13, beginIndex: 1, endIndex: 1, distanceMeters: 0, durationSeconds: 0, roadKind: "surface" });
  tangled.steps[0].endIndex = 1;
  tangled.steps[1].endIndex = tangled.points.length - 1;
  const clean = fakePart([A, [139.02, 35.07], V1], { seconds: 750 });
  const head = fakePart([A, V1], { seconds: 600, alternates: [tangled, clean] });
  const tail = fakePart([V1, B], { seconds: 600 });
  const out = await seg.withHeadAlternates(main, A, B, { vias: [V1], alternates: 2 }, recorder([head, tail]).route);
  assert.strictEqual(out.alternates.length, 1, "Uターンする代替を残した");
  assert.deepStrictEqual(out.alternates[0].points[1], [139.02, 35.07]);
  // 全部落ちたら本命だけ
  const onlyTangled = fakePart([A, V1], { seconds: 600, alternates: [tangled] });
  const none = await seg.withHeadAlternates(main, A, B, { vias: [V1], alternates: 2 }, recorder([onlyTangled, tail]).route);
  assert.strictEqual(none.alternates, main.alternates);
});

test("経由地が無い・代替を頼まれていない・もう代替があるときは引かない", async () => {
  const main = fakePart([A, V1, B], { seconds: 1200 });
  for (const [label, m, opts] of [
    ["経由地なし", main, { vias: [], alternates: 2 }],
    ["代替を頼まれていない", main, { vias: [V1], alternates: 0 }],
    ["もう代替がある", { ...main, alternates: [fakePart([A, B])] }, { vias: [V1], alternates: 2 }],
  ]) {
    const { calls, route } = recorder([]);
    const out = await seg.withHeadAlternates(m, A, B, opts, route);
    assert.strictEqual(calls.length, 0, `${label}なのに引いた`);
    assert.strictEqual(out, m);
  }
});

test("おすすめ道路を行き先にしても、行き方違いが返る（Valhalla）", async (t) => {
  if (await skipIfDown(t)) return;
  // 新座 → 塩原矢板線（入口・中継点が経由地）。実測: 経由地があると代替0本だった
  //    （配信データの「栃木県:1」の始まり・まん中・終わり。入口の向きは道に沿った -72°）
  const entry = [139.9126, 36.8432], mid = [139.8256, 36.9258], end = [139.8314, 36.9625];
  const route = await seg.routeWithValhallaSegmented(NIIZA, end, {
    displacement: "large", vias: [entry, mid], viaHeadings: [-72, null], alternates: 2 });
  assert.ok(!route.error, route.error);
  assert.ok(route.alternates.length >= 1, "経由地があると行き方違いが出ない");
  for (const alt of route.alternates) {
    assertWellFormed(alt);
    assert.ok(alt.points.some((p) => meters(p, mid) < 100), "代替がおすすめ道路を通っていない");
    assert.notDeepStrictEqual(alt.points, route.points, "本命と同じ線");
  }
});

test("着く向きを指定できる（最初の経由地へ本命と同じ向きで着かせるため）", async (t) => {
  if (await skipIfDown(t)) return;
  // 塩原矢板線の入口（両向きに走れる道）。道に沿った向きは -72°
  const entry = [139.9126, 36.8432];
  const along = await routeWithValhalla(NIIZA, entry, { displacement: "large", toHeading: -72 });
  const against = await routeWithValhalla(NIIZA, entry, { displacement: "large", toHeading: 108 });
  assert.ok(!along.error && !against.error, along.error || against.error);
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  // ⚠️ 入口は交差点の角にあり、道に沿った向き（-72°）は南から入っても満たす（実測 357°で着く）。
  //    だから「逆向きを頼めば別の向きで着く」ことで、向きが効いていると見る
  assert.ok(diff(seg.endBearing(against.points), 108) < 60, `頼んだ向きで着いていない: ${seg.endBearing(against.points)}`);
  assert.ok(diff(seg.endBearing(along.points), seg.endBearing(against.points)) > 60, "向きを頼んでも着き方が変わらない");
});
