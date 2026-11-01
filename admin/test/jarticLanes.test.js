/**
 * 進入路の車線数（`lib/jarticLanes.js`）
 * 実行: node --test test/jarticLanes.test.js
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { laneRowFrom, pairApproaches, endsOf, approachAt } = require("../lib/jarticLanes");

const M = 1 / 111320;
/** 東へ e m・北へ n m */
const at = (e, n) => [139 + e * M * 1.23, 36 + n * M];
const row = (code, a, b, more = {}) => ({
  "共通規制種別コード": code, "県別規制種別名称": "x",
  "規制場所の経度緯度": `${a.join(" ")};${b.join(" ")}`,
  ...more,
});

test("矢印の行と車両通行帯の行を読む", () => {
  const a = at(0, -40), b = at(0, -5);
  assert.deepStrictEqual(laneRowFrom(row("119", a, b)), { a, b, lanes: null });
  assert.deepStrictEqual(laneRowFrom(row("58", a, b)), { a, b, lanes: null });
  assert.deepStrictEqual(laneRowFrom(row("20", a, b, { "車両通行帯数": "3" })), { a, b, lanes: 3 });
});

test("読まない行", () => {
  const a = at(0, -40), b = at(0, -5);
  assert.strictEqual(laneRowFrom(row("52", a, b)), null);
  assert.strictEqual(laneRowFrom(row("20", a, b, { "車両通行帯数": "1" })), null);
  assert.strictEqual(laneRowFrom(row("20", a, b, { "車両通行帯数": "" })), null);
  assert.strictEqual(laneRowFrom(row("119", a, b, { "県別規制種別名称": "進行方向別通行区分（高速道）" })), null);
  assert.strictEqual(laneRowFrom(row("119", a, b, { "規制時間1_開始": "700", "規制時間1_終了": "900" })), null);
});

test("同じ所の行を組にする。線の向きが逆でもよい（三橋三丁目）", () => {
  const got = pairApproaches([
    { a: at(0, -40), b: at(0, -5), lanes: null },
    { a: at(3, -6), b: at(3, -41), lanes: 3 },
  ]);
  assert.deepStrictEqual(got, [{ a: at(0, -40), b: at(0, -5), lanes: 3 }]);
});

test("車線数の無い進入路と、矢印の無い通行帯は使わない", () => {
  const d = { a: at(0, -40), b: at(0, -5), lanes: null };
  assert.deepStrictEqual(pairApproaches([d]), []);
  assert.deepStrictEqual(pairApproaches([{ a: at(3, 5), b: at(3, 40), lanes: 3 }]), []);
  assert.deepStrictEqual(pairApproaches([d, { a: at(0, -140), b: at(0, -105), lanes: 3 }]), []);
});

test("近い方の通行帯を選ぶ（反対側の進入路が隣にある）", () => {
  const got = pairApproaches([
    { a: at(0, -40), b: at(0, -5), lanes: null },
    { a: at(10, -40), b: at(10, -5), lanes: 4 },
    { a: at(2, -40), b: at(2, -5), lanes: 2 },
  ]);
  assert.strictEqual(got[0].lanes, 2);
});

const ENDS = endsOf([{ a: at(0, -40), b: at(0, -5), lanes: 3 }]);

test("北へ走って曲がる地点の手前の進入路を見つける", () => {
  assert.strictEqual(approachAt(at(0, 0), 0, ENDS).lanes, 3);
  assert.strictEqual(approachAt(at(0, 30), 0, ENDS).lanes, 3);
});

test("線の向きによらず同じ結果", () => {
  const flipped = endsOf([{ a: at(0, -5), b: at(0, -40), lanes: 3 }]);
  assert.strictEqual(approachAt(at(0, 0), 0, flipped).lanes, 3);
});

test("反対向きに走るときは使わない", () => {
  assert.strictEqual(approachAt(at(0, 0), 180, ENDS), null);
  // 南へ走って線の南の端へ来た所。線はこちら向きだが、もう通り過ぎた道の話ではない向き
  assert.strictEqual(approachAt(at(0, -45), 0, ENDS), null);
});

test("交差する向きでは使わない", () => {
  assert.strictEqual(approachAt(at(0, 0), 90, ENDS), null);
});

test("遠い曲がり角では使わない", () => {
  assert.strictEqual(approachAt(at(0, 41), 0, ENDS), null);
  assert.strictEqual(approachAt(at(50, 0), 0, ENDS), null);
});

test("線の途中で曲がるときは、この先の交差点の進入路なので使わない", () => {
  assert.strictEqual(approachAt(at(0, -30), 0, ENDS), null);
});

test("データや向きが無ければ何も返さない", () => {
  assert.strictEqual(approachAt(at(0, 0), null, ENDS), null);
  assert.strictEqual(approachAt(at(0, 0), 0, []), null);
});
