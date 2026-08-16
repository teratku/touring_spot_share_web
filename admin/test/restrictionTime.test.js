"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseHm, normalizeHours, normalizeDays, isActiveAt, describe } =
  require("../lib/restrictionTime");

/**
 * 通行規制の「効いている時間」。
 *
 * ⚠️ 二輪の規制は時間や曜日で切られていることが多い（「土日祝の7:00〜19:00のみ」など）。
 *    ここを間違えると、**通れる時間に「通行禁止」と案内する**ことになる。
 */

test("時刻を読む", () => {
  assert.strictEqual(parseHm("07:00"), 420);
  assert.strictEqual(parseHm("7:05"), 425);
  assert.strictEqual(parseHm("23:59"), 1439);
});

test("時刻として読めないものは弾く", () => {
  for (const t of ["", "7", "24:00", "07:60", "七時", null, undefined, "0700"]) {
    assert.strictEqual(parseHm(t), null, JSON.stringify(t) + " を読めたことにしている");
  }
});

test("片方だけの時間は終日にする", () => {
  // ⚠️ 「7:00から」だけでは終わりが決まらず、終日と区別できない
  assert.strictEqual(normalizeHours({ from: "07:00" }), null);
  assert.strictEqual(normalizeHours({ to: "19:00" }), null);
  assert.strictEqual(normalizeHours({ from: "07:00", to: "07:00" }), null);
});

test("曜日は全部そろっていれば毎日として捨てる", () => {
  assert.strictEqual(normalizeDays([1, 2, 3, 4, 5, 6, 7]), null);
  assert.strictEqual(normalizeDays([]), null);
  assert.deepStrictEqual(normalizeDays([6, 7]), [6, 7]);
  assert.deepStrictEqual(normalizeDays([7, 6, 6, 0, 9]), [6, 7], "重複や範囲外を落としていない");
});

test("時間帯の中だけ効く", () => {
  const r = { activeHours: { from: "07:00", to: "19:00" } };
  assert.ok(isActiveAt(r, new Date("2026-08-16T12:00:00")));
  assert.ok(!isActiveAt(r, new Date("2026-08-16T06:59:00")));
  assert.ok(!isActiveAt(r, new Date("2026-08-16T19:00:00")), "終了時刻ちょうどは効かない");
});

test("日をまたぐ時間帯も効く", () => {
  // ⚠️ 夜間規制は実在する。from < to だけで判定すると丸ごと落とす
  const night = { activeHours: { from: "22:00", to: "05:00" } };
  assert.ok(isActiveAt(night, new Date("2026-08-16T23:30:00")));
  assert.ok(isActiveAt(night, new Date("2026-08-16T04:59:00")));
  assert.ok(!isActiveAt(night, new Date("2026-08-16T12:00:00")));
});

test("曜日で切れる", () => {
  const weekend = { activeDays: [6, 7] };            // 土日
  assert.ok(isActiveAt(weekend, new Date("2026-08-16T12:00:00")), "日曜に効いていない");
  assert.ok(!isActiveAt(weekend, new Date("2026-08-17T12:00:00")), "月曜に効いている");
});

test("祝日を含める指定が効く", () => {
  const r = { activeDays: [6, 7], includesHoliday: true };
  // 平日だが祝日
  assert.ok(isActiveAt(r, new Date("2026-08-17T12:00:00"), { isHoliday: true }));
  assert.ok(!isActiveAt(r, new Date("2026-08-17T12:00:00"), { isHoliday: false }));
});

test("指定が無ければいつでも効く", () => {
  assert.ok(isActiveAt({}, new Date("2026-08-16T03:00:00")));
});

test("説明文にまとまる", () => {
  assert.strictEqual(describe({ activeDays: [6, 7], includesHoliday: true,
                                activeHours: { from: "07:00", to: "19:00" } }),
                     "土・日 祝 07:00〜19:00");
  assert.strictEqual(describe({}), "");
});
