/**
 * 一方通行の読み取り（`lib/jarticOneways.js`）
 * 実行: node --test test/jarticOneways.test.js
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { onewayFromRow, linesOf } = require("../lib/jarticOneways");

const ROW = {
  "共通規制種別コード": "11",
  "県別規制種別名称": "一方通行",
  "規制場所の経度緯度": "139.60 35.90;139.61 35.91;139.62 35.92",
  "規制時間1_開始": "0", "規制時間1_終了": "2400",
  "対象車両コード1_A": "1",
  "除外車両コード1_D": "100000000000100",
  "ユニークキー": "k",
};

test("点の順のまま線にする（進む向きなので並べ替えない）", () => {
  assert.deepStrictEqual(onewayFromRow(ROW), {
    lines: [[[139.60, 35.90], [139.61, 35.91], [139.62, 35.92]]], key: "k",
  });
});

test("/ で区切られた線は別々に読み、1点だけの線は捨てる", () => {
  assert.deepStrictEqual(linesOf("1 2;3 4/5 6/7 8;9 10"), [[[1, 2], [3, 4]], [[7, 8], [9, 10]]]);
});

test("軽車両などを除く行は二輪に掛かるので焼く", () => {
  assert.ok(onewayFromRow({ ...ROW, "除外車両コード1_D": "100" }));
});

test("二輪を除く行は焼かない", () => {
  assert.strictEqual(onewayFromRow({ ...ROW, "除外車両コード1_D": "100000000000101" }), null);
  assert.strictEqual(onewayFromRow({ ...ROW, "除外車両コード1_D": "1" }), null);
});

test("時間・曜日・除外時間のある行は焼かない", () => {
  assert.strictEqual(onewayFromRow({ ...ROW, "規制時間1_開始": "700", "規制時間1_終了": "900" }), null);
  assert.strictEqual(onewayFromRow({ ...ROW, "規制曜日コード1": "99" }), null);
  assert.strictEqual(onewayFromRow({ ...ROW, "除外時間1_開始": "700" }), null);
});

test("高速とほかの種別は読まない", () => {
  assert.strictEqual(onewayFromRow({ ...ROW, "県別規制種別名称": "一方通行（高速道）" }), null);
  assert.strictEqual(onewayFromRow({ ...ROW, "共通規制種別コード": "12" }), null);
});

test("一部が規制の外の行は焼かない", () => {
  assert.strictEqual(onewayFromRow({ ...ROW, "除外区間及び区域の経度緯度": "139.6 35.9" }), null);
});
