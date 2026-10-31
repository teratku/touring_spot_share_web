/**
 * 指定方向外進行禁止の読み取り（`lib/jarticTurnBans.js`）
 * 実行: node --test test/jarticTurnBans.test.js
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { banFromRow } = require("../lib/jarticTurnBans");

/** 新大宮バイパス 三橋三丁目 南行き（2026年08月分の実データ）: 直進と左折だけ */
const MIHASHI = {
  "共通規制種別コード": "12",
  "規制場所の経度緯度": "139.604418848261 35.8969908290491",
  "進入方向(座標)": "139.604405049158 35.8970008599133",
  "指定する方向(座標)": "139.604500882869 35.8969314908481;139.60449208473 35.8970586788371",
  "規制時間1_開始": "0", "規制時間1_終了": "2400",
  "対象車両コード1_A": "10",
  "ユニークキー": "k",
};

test("三橋三丁目: 南東へ入り、直進（南東）と左折（北東）だけ許す", () => {
  const ban = banFromRow(MIHASHI);
  assert.deepStrictEqual(ban.at, [139.604418848261, 35.8969908290491]);
  assert.strictEqual(ban.inHeading, 132);
  assert.deepStrictEqual(ban.allowed, [132, 41]);
});

test("時間が空の行は終日", () => {
  assert.ok(banFromRow({ ...MIHASHI, "規制時間1_開始": "", "規制時間1_終了": "" }));
});

test("時間・曜日つきは焼かない（朝だけの規制で一日中曲がれなくなる）", () => {
  assert.strictEqual(banFromRow({ ...MIHASHI, "規制時間1_開始": "630", "規制時間1_終了": "830" }), null);
  assert.strictEqual(banFromRow({ ...MIHASHI, "規制曜日コード1": "3" }), null);
  assert.strictEqual(banFromRow({ ...MIHASHI, "規制時間2_開始": "700" }), null);
});

test("進入方向が規制場所と同じ点の行は向きが分からないので焼かない", () => {
  assert.strictEqual(banFromRow({ ...MIHASHI, "進入方向(座標)": MIHASHI["規制場所の経度緯度"] }), null);
});

test("二輪を除く規制は焼かない", () => {
  for (const code of ["1", "10", "1000", "10000"]) {
    assert.strictEqual(banFromRow({ ...MIHASHI, "除外車両コード1_D": code }), null, code);
  }
  // 3桁目は二輪ではない（軽車両）。除外されていても二輪には掛かる
  assert.ok(banFromRow({ ...MIHASHI, "除外車両コード1_D": "100" }));
});

test("対象が車両・自動車でなければ焼かない（大型だけの規制など）", () => {
  assert.ok(banFromRow({ ...MIHASHI, "対象車両コード1_A": "1" }));
  assert.strictEqual(banFromRow({ ...MIHASHI, "対象車両コード1_A": "" }), null);
  assert.strictEqual(banFromRow({ ...MIHASHI, "対象車両コード1_A": "100000000" }), null);
});

test("ほかの規制や、座標の欠けた行は読まない", () => {
  assert.strictEqual(banFromRow({ ...MIHASHI, "共通規制種別コード": "63" }), null);
  assert.strictEqual(banFromRow({ ...MIHASHI, "進入方向(座標)": "" }), null);
  assert.strictEqual(banFromRow({ ...MIHASHI, "指定する方向(座標)": "" }), null);
});
