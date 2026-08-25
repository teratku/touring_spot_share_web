"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { dropUTurnRoads, blameForUTurns, BLAME_WITHIN_METERS } = require("../lib/funRouteRefine");
const { waypointsFor } = require("../lib/funRouteSelect");

/**
 * 実際に引いた経路を見て、Uターンを起こす道を外すところ。
 *
 * ⚠️ **経路を引く処理は作り物を渡す。** 本物の Valhalla を立てずに確かめる。
 *    「どの道が入っていたら何回Uターンするか」を決め打ちにして、
 *    外し方だけを見る。
 */

const FROM = [138.5684, 35.6642];
const TO = [138.8087, 35.4876];

function seg(id, score, e, n) {
  // e/n は出発地からのおおよその向き。並びが決まればよい
  return { id, name:id, score, lengthKm:5, curviness:600,
           start:[35.66 - n * 0.01, 138.58 + e * 0.01],
           end:[35.65 - n * 0.01, 138.59 + e * 0.01] };
}
const A = seg("A", 90, 1, 1);
const B = seg("B", 85, 3, 2);
const C = seg("C", 80, 5, 3);
const D = seg("D", 75, 7, 4);

/**
 * 作り物の経路。`badIds` に入っている道が経由地に含まれる数だけ Uターンする。
 * どの道が入っているかは、経由地の座標を区間の入口と突き合わせて調べる。
 */
function fakeRouter(badIds, all = [A, B, C, D]) {
  const calls = [];
  const fn = async (vias) => {
    const included = all.filter((s) =>
      vias.some((v) => Math.abs(v[0] - s.start[1]) < 1e-9 && Math.abs(v[1] - s.start[0]) < 1e-9)
        || vias.some((v) => Math.abs(v[0] - s.end[1]) < 1e-9 && Math.abs(v[1] - s.end[0]) < 1e-9));
    calls.push(included.map((s) => s.id));
    return {
      uTurns: included.filter((s) => badIds.includes(s.id)).length,
      lengthMeters: 40_000 + included.length * 10_000,
      steps: [], points: [],
    };
  };
  fn.calls = calls;
  return fn;
}

test("Uターンを起こす道を外す", async () => {
  // ⚠️ **点数の低い順ではない。** B（85点）がUターンの原因で、
  //    D（75点）は無実。点数順に外すと当たらない
  const routeFn = fakeRouter(["B"]);
  const out = await dropUTurnRoads([A, B, C, D], FROM, TO, routeFn);
  assert.strictEqual(out.route.uTurns, 0, "Uターンが残っている");
  assert.deepStrictEqual(out.dropped.map((s) => s.id), ["B"],
    `外した道が違う: ${out.dropped.map((s) => s.id).join(",")}`);
  assert.deepStrictEqual(out.segments.map((s) => s.id), ["A", "C", "D"]);
});

test("原因が複数あっても、なくなるまで外す", async () => {
  const routeFn = fakeRouter(["A", "C"]);
  const out = await dropUTurnRoads([A, B, C, D], FROM, TO, routeFn);
  assert.strictEqual(out.route.uTurns, 0, "Uターンが残っている");
  assert.deepStrictEqual(out.dropped.map((s) => s.id).sort(), ["A", "C"]);
});

test("Uターンが無ければ何も外さない（引き直しもしない）", async () => {
  const routeFn = fakeRouter([]);
  const out = await dropUTurnRoads([A, B, C, D], FROM, TO, routeFn);
  assert.deepStrictEqual(out.dropped, []);
  assert.strictEqual(out.calls, 1, `${out.calls}回も引いている（1回で済むはず）`);
  assert.deepStrictEqual(out.segments.map((s) => s.id), ["A", "B", "C", "D"]);
});

test("外しても減らないなら諦める（道を全部消さない）", async () => {
  // ⚠️ Uターンが道のせいでないことがある。そのとき外し続けると
  //    おすすめ道路が1本も無いルートになってしまう
  const stubborn = async () => ({ uTurns:1, lengthMeters:50_000, steps:[], points:[] });
  const out = await dropUTurnRoads([A, B, C, D], FROM, TO, stubborn);
  assert.ok(out.segments.length > 0, "道を全部外してしまっている");
  assert.strictEqual(out.route.uTurns, 1, "消えないUターンが消えたことになっている");
});

test("同じだけ減るなら、点数の低い方を外す", async () => {
  // A(90) と D(75) のどちらを外してもUターンが1つ減るとき、D を外す
  const routeFn = async (vias) => {
    const has = (s) => vias.some((v) =>
      Math.abs(v[0] - s.start[1]) < 1e-9 && Math.abs(v[1] - s.start[0]) < 1e-9);
    return { uTurns: (has(A) ? 1 : 0) + (has(D) ? 1 : 0),
             lengthMeters:50_000, steps:[], points:[] };
  };
  const out = await dropUTurnRoads([A, D], FROM, TO, routeFn);
  assert.strictEqual(out.dropped[0].id, "D",
    `${out.dropped[0].id} を先に外している（点数の低い D のはず）`);
});

// MARK: 外したぶんの選び直し

test("外したぶんを、別の道で埋め直す", async () => {
  // ⚠️ **埋め直さないと本数が減りっぱなしになる。**
  //    実機で「ひかえめが1本だけ」になった
  const routeFn = fakeRouter(["B"], [A, B, C, D]);
  const out = await dropUTurnRoads([A, B], FROM, TO, routeFn,
    { pool: [A, B, C, D], pickOptions: { count: 2, budgetRatio: 3.0 } });
  assert.strictEqual(out.route.uTurns, 0, "Uターンが残っている");
  assert.ok(out.segments.length > 1,
    `${out.segments.length}本しか残っていない（埋め直していない）`);
  assert.ok(!out.segments.some((s) => s.id === "B"), "外した道が戻ってきている");
});

test("埋め直してUターンが増えるなら、埋めない", async () => {
  // B が原因。埋め直しで C が入るが、C も原因なら埋め直しを捨てる
  const routeFn = fakeRouter(["B", "C"], [A, B, C, D]);
  const out = await dropUTurnRoads([A, B], FROM, TO, routeFn,
    { pool: [A, B, C], pickOptions: { count: 2, budgetRatio: 3.0 } });
  assert.strictEqual(out.route.uTurns, 0, "Uターンが増えた案を採っている");
});

test("案ごとの選び方を守って埋め直す", async () => {
  // ⚠️ **どの案も同じ条件で選び直すと、案が同じ顔ぶれに揃って1通りに潰れる。**
  //    「別ルート」は上位を外し続けること
  const routeFn = fakeRouter(["B"], [A, B, C, D]);
  const out = await dropUTurnRoads([B, C], FROM, TO, routeFn,
    { pool: [A, B, C, D],
      pickOptions: { count: 3, budgetRatio: 3.0, excludeIds: ["A"] } });
  assert.ok(!out.segments.some((s) => s.id === "A"),
    "除外するはずの A が埋め直しで入っている");
});

test("埋め直す材料が無ければ、そのまま返す", async () => {
  const routeFn = fakeRouter(["B"], [A, B]);
  const out = await dropUTurnRoads([A, B], FROM, TO, routeFn);   // pool を渡さない
  assert.strictEqual(out.route.uTurns, 0);
  assert.strictEqual(out.refilled, false);
  assert.deepStrictEqual(out.segments.map((s) => s.id), ["A"]);
});

// MARK: 1回引いた結果から原因を突き止める

/**
 * ⚠️ **Uターンは経由地のところで起きる。** 実測11件すべて、いちばん近い経由地は
 *    その道の**出口**だった（0m×4・17m×3・125m×1・965m×2、次は15.7km）。
 *    これを使えば、1本ずつ抜いて試さずに原因が分かる。
 *
 *    実測（10区間・28案）:
 *      1本ずつ抜くだけ  呼び出し75回（1案2.7回）8.4秒
 *      突き止めてから   呼び出し48回（1案1.7回）5.8秒
 */
function routeWithUTurnAt(point, roads, origin, destination) {
  const wps = waypointsFor(roads, origin, destination);
  // 経由地をそのまま線の点として使う（位置合わせを単純にするため）
  const points = [origin, ...wps, destination];
  const idx = points.findIndex((p) => p[0] === point[0] && p[1] === point[1]);
  return {
    uTurns: 1, lengthMeters: 50_000, points,
    steps: [{ maneuver:"uturnRight", beginIndex: idx < 0 ? 0 : idx }],
  };
}

test("Uターンの場所から、原因の道が分かる", () => {
  const roads = [A, B, C];
  const wps = waypointsFor(roads, FROM, TO);
  // B の出口（経由地の3番目＝添字3）でUターンした、という経路を作る
  const route = routeWithUTurnAt(wps[3], roads, FROM, TO);
  const blamed = blameForUTurns(route, roads, FROM, TO);
  assert.deepStrictEqual(blamed.map((s) => s.id), ["B"],
    `原因を取り違えている: ${blamed.map((s) => s.id).join(",")}`);
});

test("経由地から遠いUターンは、決めつけない", () => {
  // ⚠️ 当てずっぽうで外すと、無実の道が落ちる。遠いものは呼び出し側に任せる
  const roads = [A, B, C];
  const route = {
    uTurns: 1, lengthMeters: 50_000,
    points: [[139.9, 35.0]],           // どの経由地からも遠い
    steps: [{ maneuver:"uturnRight", beginIndex: 0 }],
  };
  assert.deepStrictEqual(blameForUTurns(route, roads, FROM, TO), [],
    "遠いUターンの原因を決めつけている");
});

test("Uターンが無ければ原因も無い", () => {
  const route = { uTurns:0, lengthMeters:50_000, points:[], steps:[] };
  assert.deepStrictEqual(blameForUTurns(route, [A, B], FROM, TO), []);
});

test("原因が複数なら、まとめて挙げる", () => {
  const roads = [A, B, C];
  const wps = waypointsFor(roads, FROM, TO);
  const points = [FROM, ...wps, TO];
  const route = {
    uTurns: 2, lengthMeters: 50_000, points,
    // ⚠️ points は [出発地, A入口, A出口, B入口, B出口, C入口, C出口, 目的地]
    steps: [{ maneuver:"uturnRight", beginIndex: 1 },    // A の入口
            { maneuver:"uturnLeft",  beginIndex: 6 }],   // C の出口
  };
  const blamed = blameForUTurns(route, roads, FROM, TO).map((s) => s.id).sort();
  assert.deepStrictEqual(blamed, ["A", "C"]);
});

test("突き止められれば、引き直しは1回で済む", async () => {
  // ⚠️ ここが効かないと「本数＋1」回引くことになる
  const roads = [A, B, C, D];
  const wps = waypointsFor(roads, FROM, TO);
  const points = [FROM, ...wps, TO];
  let n = 0;
  const routeFn = async (vias) => {
    n++;
    const hasB = vias.some((v) =>
      Math.abs(v[0] - B.start[1]) < 1e-9 && Math.abs(v[1] - B.start[0]) < 1e-9);
    if (!hasB) return { uTurns:0, lengthMeters:40_000, points:[], steps:[] };
    return { uTurns:1, lengthMeters:50_000, points,
             steps:[{ maneuver:"uturnRight", beginIndex: 4 }] };   // B の出口
  };
  const out = await dropUTurnRoads(roads, FROM, TO, routeFn);
  assert.strictEqual(out.route.uTurns, 0, "Uターンが残っている");
  assert.deepStrictEqual(out.dropped.map((s) => s.id), ["B"]);
  assert.strictEqual(out.calls, 2,
    `${out.calls}回引いている（突き止めが効けば2回で済む）`);
});

test("Uターン以外の指示は原因にしない", () => {
  // ⚠️ 曲がる指示は経路中にいくらでもある。それを原因にすると、
  //    Uターンしていない道まで外れる
  const roads = [A, B, C];
  const wps = waypointsFor(roads, FROM, TO);
  const points = [FROM, ...wps, TO];
  const route = {
    uTurns: 1, lengthMeters: 50_000, points,
    steps: [{ maneuver:"turnRight",  beginIndex: 1 },    // A の入口だが右折
            { maneuver:"turnLeft",   beginIndex: 3 },    // B の入口だが左折
            { maneuver:"uturnRight", beginIndex: 6 }],   // C の出口でUターン
  };
  const blamed = blameForUTurns(route, roads, FROM, TO).map((s) => s.id);
  assert.deepStrictEqual(blamed, ["C"],
    `Uターン以外まで原因にしている: ${blamed.join(",")}`);
});

test("突き止めて外してもUターンが減らないなら、その結果を採らない", async () => {
  // ⚠️ 突き止めが外れることがある。減っていないのに採ると、
  //    **無実の道を外したうえにUターンも残る**
  const roads = [A, B];
  const wps = waypointsFor(roads, FROM, TO);
  const points = [FROM, ...wps, TO];
  let n = 0;
  const routeFn = async () => {
    n++;
    // 何を外してもUターンは1回のまま（原因は道ではない）
    return { uTurns:1, lengthMeters:50_000, points,
             steps:[{ maneuver:"uturnRight", beginIndex: 2 }] };  // A の出口
  };
  const out = await dropUTurnRoads(roads, FROM, TO, routeFn);
  assert.deepStrictEqual(out.dropped, [],
    `減らないのに ${out.dropped.map((s) => s.id).join(",")} を外している`);
  assert.deepStrictEqual(out.segments.map((s) => s.id), ["A", "B"]);
});
