"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { mergeFalseExits, routeWithValhalla, BASE } = require("../lib/valhallaRoute");

/**
 * 本線の途中の偽の出口（料金所の車線の描き方で出る）を、手前の指示にまとめるところ。
 *
 * ⚠️ **数字は実際の応答から写した**（用賀→厚木・大型。東名の東京料金所の下り）:
 *    東京IC の入口 6,373m → 「出口です」84m（標識なし）→ 左寄り 26,712m → 海老名JCT
 */
const TOMEI = ["E1", "東名高速道路", "Tomei Expressway"];
function tokyoTollGate() {
  const points = Array.from({ length: 60 }, (_, i) => [139.6 - i * 0.004, 35.62 - i * 0.003]);
  const steps = [
    { maneuver: "rampRight", valhallaType: 18, distanceMeters: 6373, durationSeconds: 262,
      roadNames: [...TOMEI], towardNames: ["横浜", "静岡"], branchNames: ["E1"], exitNames: [], exitNumbers: [],
      beginIndex: 0, endIndex: 20, isCurvyAhead: false },
    { maneuver: "rampLeft", valhallaType: 21, distanceMeters: 84, durationSeconds: 4,
      roadNames: [...TOMEI], towardNames: [], branchNames: [], exitNames: [], exitNumbers: [],
      beginIndex: 20, endIndex: 22, isCurvyAhead: false },
    { maneuver: "keepLeft", valhallaType: 24, distanceMeters: 26712, durationSeconds: 1011,
      roadNames: ["東名高速道路", "Tomei Expressway"], towardNames: [], branchNames: [], exitNames: [], exitNumbers: [],
      beginIndex: 22, endIndex: 50, isCurvyAhead: false },
    { maneuver: "rampLeft", valhallaType: 21, distanceMeters: 556, durationSeconds: 30,
      roadNames: [], towardNames: ["八王子"], branchNames: ["C4"], exitNames: ["海老名JCT"], exitNumbers: ["4-2"],
      beginIndex: 50, endIndex: 55, isCurvyAhead: false },
    { maneuver: "none", valhallaType: 4, distanceMeters: 0, durationSeconds: 0,
      roadNames: [], towardNames: [], branchNames: [], exitNames: [], exitNumbers: [],
      beginIndex: 55, endIndex: 55, isCurvyAhead: false, isLegEnd: true },
  ];
  return { steps, points };
}

test("料金所の偽の出口と続く左寄りを、手前の指示にまとめる", () => {
  const { steps, points } = tokyoTollGate();
  assert.strictEqual(mergeFalseExits(steps, points), 1);
  // ⚠️ 本線の上で「東名へ左の出口に進みます」と言わせない。次の指示は海老名JCT
  assert.deepStrictEqual(steps.map((s) => s.valhallaType), [18, 21, 4]);
  assert.deepStrictEqual(steps[1].exitNames, ["海老名JCT"]);
  const entrance = steps[0];
  assert.strictEqual(entrance.distanceMeters, 6373 + 84 + 26712, "距離を足していない");
  assert.strictEqual(entrance.durationSeconds, 262 + 4 + 1011, "時間を足していない");
  assert.strictEqual(entrance.endIndex, 50, "線の終わりを延ばしていない");
  // 入口の指示の中身（向き・方面）はそのまま
  assert.strictEqual(entrance.maneuver, "rampRight");
  assert.deepStrictEqual(entrance.towardNames, ["横浜", "静岡"]);
});

test("標識のある出口はまとめない（本物の出口・JCT）", () => {
  for (const key of ["exitNames", "exitNumbers", "towardNames", "branchNames"]) {
    const { steps, points } = tokyoTollGate();
    steps[1][key] = ["川崎"];
    assert.strictEqual(mergeFalseExits(steps, points), 0, `${key} のある出口をまとめた`);
    assert.strictEqual(steps.length, 5);
  }
});

test("手前か先が別の高速ならまとめない（辰巳JCT の形）", () => {
  // 成田→東京の生の応答: 湾岸線 → 「出口」393m 首都高速9号深川線 → 左寄り 9号深川線
  const before = tokyoTollGate();
  before.steps[0].roadNames = ["B", "首都高速湾岸線", "Shuto Expressway Bayshore Route"];
  assert.strictEqual(mergeFalseExits(before.steps, before.points), 0, "手前が別の高速なのにまとめた");
  const after = tokyoTollGate();
  after.steps[2].roadNames = ["C4", "首都圏中央連絡自動車道"];
  assert.strictEqual(mergeFalseExits(after.steps, after.points), 0, "先が別の高速なのにまとめた");
  // ⚠️ 高速の名前で比べる（番号だけが重なっても同じ道とは限らない）
  const numberOnly = tokyoTollGate();
  for (const i of [0, 1, 2]) numberOnly.steps[i].roadNames = ["E1"];
  assert.strictEqual(mergeFalseExits(numberOnly.steps, numberOnly.points), 0, "番号だけでまとめた");
});

test("短い出口と寄る指示の組だけをまとめる", () => {
  // 長さ: 400m まで
  const long = tokyoTollGate();
  long.steps[1].distanceMeters = 401;
  assert.strictEqual(mergeFalseExits(long.steps, long.points), 0, "401m の出口をまとめた");
  const edge = tokyoTollGate();
  edge.steps[1].distanceMeters = 400;
  assert.strictEqual(mergeFalseExits(edge.steps, edge.points), 1, "400m の出口をまとめていない");
  // 出口（20・21）だけ。入口（18・19）はまとめない
  for (const [type, want] of [[20, 1], [21, 1], [18, 0], [19, 0]]) {
    const x = tokyoTollGate();
    x.steps[1].valhallaType = type;
    assert.strictEqual(mergeFalseExits(x.steps, x.points), want, `種類${type}`);
  }
  // 続くのは寄る指示（22〜24）だけ。曲がる指示ならまとめない
  for (const [type, want] of [[22, 1], [23, 1], [24, 1], [10, 0], [25, 0]]) {
    const x = tokyoTollGate();
    x.steps[2].valhallaType = type;
    assert.strictEqual(mergeFalseExits(x.steps, x.points), want, `続く種類${type}`);
  }
});

test("立ち寄り先の切れ目をまたいでまとめない", () => {
  for (const i of [0, 1, 2]) {
    const x = tokyoTollGate();
    x.steps[i].isLegEnd = true;
    assert.strictEqual(mergeFalseExits(x.steps, x.points), 0, `${i}番目が区間の切れ目なのにまとめた`);
  }
});

// MARK: 実際の Valhalla で

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}
const skipIfDown = async (t) => (await up()) ? false : t.skip(`Valhalla が居ない（${BASE}）`);
const YOGA = [139.6337, 35.6261];
const ATSUGI = [139.36398, 35.44181];

test("東京料金所（下り）で出口と言わない", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(YOGA, ATSUGI, { displacement: "large" });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.falseExitsMerged, 1, "材料が悪い: 東京料金所を通っていないか、まとめていない");
  const s = r.steps;
  const bogus = s.filter((x) => [20, 21].includes(x.valhallaType) && x.distanceMeters <= 400
    && (x.roadNames || []).includes("東名高速道路"));
  assert.deepStrictEqual(bogus.map((x) => x.instruction), [], "本線の途中の出口が残っている");
  const jct = s.findIndex((x) => (x.exitNames || []).includes("海老名JCT"));
  assert.ok(jct > 0, "材料が悪い: 海老名JCT を通っていない");
  assert.strictEqual(s[jct - 1].maneuver, "rampRight", "海老名JCT の手前が東京IC の入口の指示でない");
  // ⚠️ まとめても距離の合計は変わらない（東京IC から海老名JCT まで約33km）
  assert.ok(s[jct - 1].distanceMeters > 32000, `入口の指示が ${s[jct - 1].distanceMeters}m しかない`);
  const sum = s.reduce((a, x) => a + x.distanceMeters, 0);
  assert.ok(Math.abs(sum - r.lengthMeters) < 50, `指示の合計 ${sum}m と全長 ${r.lengthMeters}m が合わない`);
});

test("本物の出口はまとめない（条件を緩めると当たる実際の出口）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **何も無い経路で「0件」を見ても検査にならない**（壊しても落ちなかった）。
  //    条件を1つ緩めるとまとめてしまう本物の出口を持つ経路で見る（主な高速32区間で実測）:
  //    - 吹田→広島: 大阪中央環状線から国道423号へ（317m・名前なし）、箕面有料道路（205m）。
  //      「同じ名前か」を見ないとまとめる
  //    - 福岡→広島: 広島岩国道路の終わりで西広島バイパスへ移る出口（127m）。前後と
  //      「2」（国道2号）が重なるので、高速の名前でなく番号で比べるとまとめる
  const SUITA = [135.5230, 34.7890], HIROSHIMA = [132.4553, 34.3853], FUKUOKA = [130.4017, 33.5904];
  for (const [from, to, road, lo, hi] of [[SUITA, HIROSHIMA, "箕面有料道路", 150, 260],
                                          [FUKUOKA, HIROSHIMA, "広島岩国道路", 90, 170]]) {
    const r = await routeWithValhalla(from, to, { displacement: "large" });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.falseExitsMerged, 0, `${road} の経路で本物の出口をまとめた`);
    const exit = r.steps.find((x) => [20, 21].includes(x.valhallaType) && (x.roadNames || []).includes(road)
      && x.distanceMeters >= lo && x.distanceMeters <= hi);
    assert.ok(exit, `${road} の短い出口が無い（まとめたか、材料が変わった）`);
  }
});
