/**
 * 道が分かれる点で指示を分ける（`lib/valhallaRoute.js` の findRoadForks / splitStepsAtRoadForks）
 * 実行: node --test test/roadForks.test.js
 *
 * 実例は国道125号と県道3号の分かれ目（2026-10-31 の走行）。125号の続きは右へそれ、経路はまっすぐ3号へ。
 * Valhalla は指示を分けないので、アプリは24km「125号線をあと○キロです」と言い続けた。
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { findRoadForks, findTurnChoices, splitStepsAtRoadForks } = require("../lib/valhallaRoute");

const R125 = ["125", "国道125号"];
const R3 = ["さいたま栗橋線", "3", "主要地方道さいたま栗橋線"];
/** 125号の続きは右の出口（走れる・名前が続く）。実データの形 */
const MIHASHI_LIKE = [
  { driveability: "forward", from_edge_name_consistency: true, to_edge_name_consistency: false },
  { driveability: "backward", from_edge_name_consistency: true, to_edge_name_consistency: false },
  { driveability: "both", from_edge_name_consistency: false, to_edge_name_consistency: false },
];
const edge = (names, end, heading, others) => ({
  names, end_shape_index: end, begin_heading: heading, end_heading: heading,
  end_node: { intersecting_edges: others || [] },
});

test("手前の道の続きが別の出口にあり、経路が名前の違う道へ進む点を見つける", () => {
  const forks = findRoadForks([edge(R125, 10, 239, MIHASHI_LIKE), edge(R3, 30, 242)]);
  assert.deepStrictEqual(forks, [{ begin: 10, end: 10, names: R3, turn: 3 }]);
});

test("名前が変わるだけの点は分けない（手前の道の続きが無い）", () => {
  const others = [{ driveability: "both", from_edge_name_consistency: false }];
  assert.deepStrictEqual(findRoadForks([edge(R125, 10, 239, others), edge(R3, 30, 242)]), []);
});

test("手前の道の続きが入ってくる側だけなら分けない", () => {
  const others = [{ driveability: "backward", from_edge_name_consistency: true }];
  assert.deepStrictEqual(findRoadForks([edge(R125, 10, 239, others), edge(R3, 30, 242)]), []);
});

test("経路が同じ名前を持ち続けるなら分けない（重複区間の出入り）", () => {
  assert.deepStrictEqual(findRoadForks([edge(R125, 10, 239, MIHASHI_LIKE), edge(["125", "3"], 30, 242)]), []);
});

test("名前の無い道では分けない（呼び名が言えない）", () => {
  assert.deepStrictEqual(findRoadForks([edge(R125, 10, 239, MIHASHI_LIKE), edge([], 30, 242)]), []);
  assert.deepStrictEqual(findRoadForks([edge([], 10, 239, MIHASHI_LIKE), edge(R3, 30, 242)]), []);
});

test("真北をまたいでも曲がる角度を正しく出す", () => {
  const forks = findRoadForks([edge(R125, 10, 350, MIHASHI_LIKE), edge(R3, 30, 20)]);
  assert.strictEqual(forks[0].turn, 30);
});

/** 緯度を 0.001 度（約111m）ずつ進む線 */
const line = (n) => Array.from({ length: n }, (_, i) => [36 + i * 0.001, 139]);
const step = (begin, end, extra) => ({
  maneuver: "turnRight", valhallaType: 10, instruction: "右方向です。", roadName: "125", roadNames: ["125"],
  _maneuver: { street_names: ["125"] }, intersectionName: "三橋", towardNames: ["東京"], exitNames: [],
  exitNumbers: [], branchNames: [], isCurvyAhead: false, distanceMeters: 2000, durationSeconds: 200,
  beginIndex: begin, endIndex: end, roadKind: "surface", atSignal: false, signalsBefore: [], ...extra,
});

test("指示を2つに分け、距離・時間・点の番号を合計のまま保つ", () => {
  const steps = [step(0, 18)];
  assert.strictEqual(splitStepsAtRoadForks(steps, line(19), [{ begin: 6, names: R3, turn: 3 }]), 1);
  const [a, b] = steps;
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual([a.beginIndex, a.endIndex, b.beginIndex, b.endIndex], [0, 6, 6, 18]);
  assert.strictEqual(a.distanceMeters + b.distanceMeters, 2000);
  assert.strictEqual(a.durationSeconds + b.durationSeconds, 200);
  assert.ok(a.distanceMeters > 600 && a.distanceMeters < 730, String(a.distanceMeters));
  // 前の指示はそのまま
  assert.strictEqual(a.maneuver, "turnRight");
  assert.strictEqual(a.intersectionName, "三橋");
  // 後ろは新しい道の直進。前の指示の交差点名・方面を持ち越さない
  assert.strictEqual(b.maneuver, "straight");
  assert.strictEqual(b.valhallaType, 8);
  assert.strictEqual(b.roadName, "さいたま栗橋線／3／主要地方道さいたま栗橋線");
  assert.deepStrictEqual(b._maneuver.street_names, R3);
  assert.strictEqual(b.intersectionName, null);
  assert.deepStrictEqual(b.towardNames, []);
});

test("経路が少し曲がるなら左右の指示にする", () => {
  const left = [step(0, 18)], right = [step(0, 18)];
  splitStepsAtRoadForks(left, line(19), [{ begin: 6, names: R3, turn: -35 }]);
  splitStepsAtRoadForks(right, line(19), [{ begin: 6, names: R3, turn: 35 }]);
  assert.strictEqual(left[1].maneuver, "turnSlightLeft");
  assert.strictEqual(right[1].maneuver, "turnSlightRight");
});

test("曲がる地点のすぐそばなら分けない", () => {
  for (const begin of [1, 17]) {
    const steps = [step(0, 18)];
    assert.strictEqual(splitStepsAtRoadForks(steps, line(19), [{ begin, names: R3, turn: 3 }]), 0);
    assert.strictEqual(steps.length, 1);
  }
});

test("高速の指示は分けない", () => {
  const steps = [step(0, 18, { roadKind: "expressway" })];
  assert.strictEqual(splitStepsAtRoadForks(steps, line(19), [{ begin: 6, names: R3, turn: 3 }]), 0);
});

test("1つの指示に分かれ目が2つあっても順に分ける", () => {
  const steps = [step(0, 18)];
  const forks = [{ begin: 6, names: R3, turn: 3 }, { begin: 12, names: ["16"], turn: 3 }];
  assert.strictEqual(splitStepsAtRoadForks(steps, line(19), forks), 2);
  assert.deepStrictEqual(steps.map((s) => [s.beginIndex, s.endIndex]), [[0, 6], [6, 12], [12, 18]]);
  assert.strictEqual(steps.reduce((m, s) => m + s.distanceMeters, 0), 2000);
});

test("分かれ目が無ければ何も変えない", () => {
  const steps = [step(0, 18)];
  assert.strictEqual(splitStepsAtRoadForks(steps, line(19), null), 0);
  assert.strictEqual(splitStepsAtRoadForks(steps, line(19), []), 0);
  assert.strictEqual(steps.length, 1);
});

/** 片側の本線 → 29m 渡る → 西の道。実データの円阿弥（北）の形 */
const road = (begin_heading, driveability = "both", extra = {}) => ({
  begin_heading, driveability, use: "road", road_class: "tertiary", ...extra,
});
const on = (end_shape_index, heading, length, others) => ({
  end_shape_index, begin_heading: heading, end_heading: heading, length,
  end_node: { intersecting_edges: others || [] },
});
const ENNAMI = [
  on(10, 134, 0.3, [road(137, "forward", { road_class: "trunk" }), road(89)]),
  on(12, 269, 0.029, [road(159), road(314, "forward", { road_class: "trunk" }),
                      road(134, "backward", { road_class: "trunk" }), road(206)]),
  on(20, 267, 0.3),
];

test("円阿弥（北）: 本線を渡った先の3本のうち、いちばん手前の道", () => {
  assert.deepStrictEqual(findTurnChoices(ENNAMI)[0], { begin: 10, end: 10, count: 3, position: 1 });
});

test("十字路は同じ側に1本だけなので言わない", () => {
  const edges = [on(10, 0, 0.3, [road(0, "forward"), road(270)]), on(20, 90, 0.3)];
  assert.deepStrictEqual(findTurnChoices(edges), []);
});

test("奥の道・真ん中の道を数える", () => {
  const three = (out, others) => [on(10, 0, 0.3, others.map((h) => road(h))), on(20, out, 0.3)];
  assert.strictEqual(findTurnChoices(three(40, [90, 130]))[0].position, 3);
  assert.strictEqual(findTurnChoices(three(90, [40, 130]))[0].position, 2);
  assert.strictEqual(findTurnChoices(three(90, [40, 130]))[0].count, 3);
});

test("左へ曲がるときは左の道だけ数える", () => {
  const edges = [on(10, 0, 0.3, [road(90), road(300), road(45)]), on(20, 260, 0.3)];
  assert.deepStrictEqual(findTurnChoices(edges)[0], { begin: 10, end: 10, count: 2, position: 1 });
});

test("入ってくる道・自転車道・店の出入り口・進めない道は数えない", () => {
  for (const other of [road(45, "backward"), road(45, "forward", { use: "cycleway" }),
                       road(45, "forward", { use: "pedestrian_crossing" }),
                       road(45, "both", { road_class: "service_other" }),
                       { begin_heading: 45, use: "road", road_class: "tertiary" }]) {
    assert.deepStrictEqual(findTurnChoices([on(10, 0, 0.3, [other]), on(20, 90, 0.3)]), [], JSON.stringify(other));
  }
});

test("直進に近い道・反対車線は曲がる道に数えない", () => {
  assert.deepStrictEqual(findTurnChoices([on(10, 0, 0.3, [road(10), road(175)]), on(20, 90, 0.3)]), []);
});

test("経路が直進なら言わない", () => {
  assert.deepStrictEqual(findTurnChoices([on(10, 0, 0.3, [road(90), road(45)]), on(20, 5, 0.3)]), []);
});

test("35mより先の点の道は同じ交差点に数えない", () => {
  const edges = [on(10, 0, 0.3), on(12, 90, 0.04, [road(40)]), on(20, 90, 0.3)];
  assert.deepStrictEqual(findTurnChoices(edges), []);
});

test("辺が足りなくても落ちない", () => {
  assert.deepStrictEqual(findTurnChoices([]), []);
  assert.deepStrictEqual(findTurnChoices(null), []);
  assert.deepStrictEqual(findTurnChoices([on(10, 0, 0.3, [road(90)])]), []);
});
