"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseTarget, appliesToRider, describe: desc, NO_MAX } = require("../lib/restrictionTarget");

const range = (s) => { const t = parseTarget(s); return t ? [t.minCc, t.maxCc] : null; };

test("実際に出てくる表記を正しく読む（476件から抜粋）", () => {
  // 二輪すべて
  assert.deepStrictEqual(range("自動二輪車及び原動機付自転車"), [0, NO_MAX]);
  assert.deepStrictEqual(range("二輪の自動車及び原動機付自転車"), [0, NO_MAX]);
  assert.deepStrictEqual(range("原付・自動二輪"), [0, NO_MAX]);
  assert.deepStrictEqual(range("自動二輪車・一般原動機付自転車"), [0, NO_MAX]);
  // 原付だけ
  assert.deepStrictEqual(range("原動機付自転車"), [0, 50]);
  assert.deepStrictEqual(range("一般原付"), [0, 50]);
  assert.deepStrictEqual(range("一般原動機付自転車"), [0, 50]);
  assert.deepStrictEqual(range("原動機付自転車、軽車両"), [0, 50]);
  assert.deepStrictEqual(range("一般原付、軽車両、特定原付"), [0, 50]);
  // 排気量の範囲
  assert.deepStrictEqual(range("自動二輪（250cc超）"), [251, NO_MAX]);
  assert.deepStrictEqual(range("原付・自動二輪（125cc以下）"), [0, 125]);
  assert.deepStrictEqual(range("二輪(126cc以上を除く)"), [0, 125]);
  assert.deepStrictEqual(range("二輪（126cc以上を除く）"), [0, 125]);
  assert.deepStrictEqual(range("2輪(126cc以上を除く)"), [0, 125]);
  assert.deepStrictEqual(range("125cc以上400cc以下"), [125, 400]);
  assert.deepStrictEqual(range("二輪"), [0, NO_MAX]);
  assert.deepStrictEqual(range("二輪、自動車（二輪を除く）"), [0, NO_MAX]);
});

test("二輪が対象でない規制は null", () => {
  assert.strictEqual(parseTarget("特定中貨、大貨、大特"), null);
  assert.strictEqual(parseTarget("大型貨物自動車"), null);
  assert.strictEqual(parseTarget(""), null);
  assert.strictEqual(parseTarget(null), null);
});

test("誰に当たるかを取り違えない（ここが肝）", () => {
  // 250cc超の規制は、大型だけに当たる
  const over250 = parseTarget("自動二輪（250cc超）");
  assert.strictEqual(appliesToRider(over250, "large"), true);
  assert.strictEqual(appliesToRider(over250, "medium250"), false, "250ccに出してはいけない");
  assert.strictEqual(appliesToRider(over250, "small125"), false);
  assert.strictEqual(appliesToRider(over250, "moped50"), false);

  // 原付だけの規制は、原付一種にだけ当たる
  const moped = parseTarget("一般原付");
  assert.strictEqual(appliesToRider(moped, "moped50"), true);
  assert.strictEqual(appliesToRider(moped, "small125"), false, "125ccに出してはいけない");
  assert.strictEqual(appliesToRider(moped, "large"), false);

  // 125cc以下の規制
  const under125 = parseTarget("原付・自動二輪（125cc以下）");
  assert.strictEqual(appliesToRider(under125, "moped50"), true);
  assert.strictEqual(appliesToRider(under125, "small125"), true);
  assert.strictEqual(appliesToRider(under125, "medium250"), false);
  assert.strictEqual(appliesToRider(under125, "large"), false);

  // 二輪すべて
  const all = parseTarget("自動二輪車及び原動機付自転車");
  for (const r of ["moped50", "small125", "medium250", "large"]) {
    assert.strictEqual(appliesToRider(all, r), true, r);
  }

  // 範囲の途中
  const mid = parseTarget("125cc以上400cc以下");
  assert.strictEqual(appliesToRider(mid, "moped50"), false);
  assert.strictEqual(appliesToRider(mid, "small125"), true, "125ccは範囲に入る");
  assert.strictEqual(appliesToRider(mid, "medium250"), true);
  assert.strictEqual(appliesToRider(mid, "large"), true, "251〜400 が範囲に入る");
});

test("表示用の文言", () => {
  assert.strictEqual(desc(parseTarget("自動二輪車及び原動機付自転車")), "二輪すべて");
  assert.strictEqual(desc(parseTarget("一般原付")), "50cc以下");
  assert.strictEqual(desc(parseTarget("自動二輪（250cc超）")), "251cc以上");
  assert.strictEqual(desc(parseTarget("125cc以上400cc以下")), "125〜400cc");
  assert.strictEqual(desc(null), "二輪は対象外");
});

test("未知の対象には誰にも警告しない（黙って全員に出さない）", () => {
  assert.strictEqual(appliesToRider(null, "large"), false);
  assert.strictEqual(appliesToRider(parseTarget("よく分からない表記"), "large"), false);
});
