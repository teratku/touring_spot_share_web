"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tallyRoadPace, labelOf, LABELS } = require("../roadPace");

/**
 * 走りの速さの集計（2026-10-26 利用者の判断）。3人以上・1人1票・原付一種は外す・uid を出さない
 */
const doc = (uid, roadID, rides, roadName = "テスト峠線") => ({ uid, roadID, roadName, rides });
const ride = (kmh, extra = {}) => Object.assign({ ym: "2026-10", km: 5, kmh, p85: kmh + 8, stops: 1, stopPct: 3, cc: "large" }, extra);

test("3人未満の道は出さない", () => {
  const out = tallyRoadPace([doc("a", "r:x", [ride(50)]), doc("b", "r:x", [ride(52)])]);
  assert.strictEqual(out.length, 0);
});

test("1人が何回走っても1票（その人の中央値）", () => {
  const out = tallyRoadPace([
    doc("a", "r:x", [ride(80), ride(80), ride(80), ride(80), ride(80)]),
    doc("b", "r:x", [ride(30)]), doc("c", "r:x", [ride(32)]),
  ]);
  assert.strictEqual(out[0].users, 3);
  assert.strictEqual(out[0].rides, 7);
  assert.strictEqual(out[0].kmh, 32, "速い人の回数で平均が引っ張られた");
});

test("原付一種の回は数えない", () => {
  const out = tallyRoadPace([
    doc("a", "r:x", [ride(28, { cc: "moped50" })]),
    doc("b", "r:x", [ride(50)]), doc("c", "r:x", [ride(50)]), doc("d", "r:x", [ride(50)]),
  ]);
  assert.strictEqual(out[0].users, 3);
  assert.strictEqual(out[0].kmh, 50);
});

test("区分の決まり", () => {
  assert.strictEqual(labelOf({ kmh: 50, stopPct: 2 }), "fast");
  assert.strictEqual(labelOf({ kmh: 38, stopPct: 2 }), "smooth");
  assert.strictEqual(labelOf({ kmh: 24, stopPct: 2 }), "slow");
  assert.strictEqual(labelOf({ kmh: 50, stopPct: 30 }), "stopgo", "止まってばかりの道を快走路にした");
  assert.deepStrictEqual(Object.keys(LABELS).sort(), ["fast", "slow", "smooth", "stopgo"]);
});

test("公開する中身に uid を入れない・分布を持つ", () => {
  const out = tallyRoadPace(["a", "b", "c"].map((u, i) => doc(u, "r:x", [ride(41 + i)])));
  const json = JSON.stringify(out);
  assert.ok(!/"a"|"b"|"c"/.test(json.replace(/"r:x"/, "")), "uid が出ている");
  assert.strictEqual(out[0].hist.length, 10);
  assert.strictEqual(out[0].hist[4], 3);
  assert.strictEqual(out[0].label, "smooth");
});

test("規則: 本人だけ書けて読めて、集計は誰でも読めて誰も書けない", () => {
  const rules = fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8");
  assert.ok(/match \/road_pace\/\{id\}[\s\S]*?request\.resource\.data\.uid == request\.auth\.uid[\s\S]*?isValidRoadPace/.test(rules));
  assert.ok(rules.includes("match /road_pace_stats/{doc}          { allow read: if true; allow write: if false; }"));
});

test("アプリから届いた分と PC で計算した分は、同じ人の同じ道なら1票", () => {
  const { offlineDocs } = require("../roadPace");
  const out = tallyRoadPace([
    doc("a", "r:x", [ride(40)]),
    ...offlineDocs({ uid: "a", roads: { "r:x": { name: "テスト峠線", rides: [ride(60, { cc: "unknown", src: "shared" })] } } }),
    doc("b", "r:x", [ride(50)]), doc("c", "r:x", [ride(52)]),
  ]);
  assert.strictEqual(out[0].users, 3, "同じ人を2人と数えた");
  assert.strictEqual(out[0].rides, 4);
});
