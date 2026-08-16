"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 規制の編集画面に、候補が持ってきた内容が初期値として出るか。
 *
 * 【なぜ確かめるか】
 * OSM から拾った規制は曜日と時間帯を持っている（旧東海道は月〜金の07:30〜09:00）。
 * ⚠️ 初期値に出ないと、**画面では終日に見えたまま登録され、通れる時間まで
 *    「通行禁止」として配信される**。エラーにはならないので気付けない。
 *
 * 画面側の関数をHTMLから取り出して動かす（`parseLatLng.test.js` と同じやり方）。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");

/** rRenderEditor の「初期値を決めるところ」だけを取り出す */
function prefill(saved, candidate) {
  const src = html.match(/function rRenderEditor\(c\) \{[\s\S]*?\n\}/);
  assert.ok(src, "rRenderEditor を取り出せない");
  const head = src[0].slice(0, src[0].indexOf("box.innerHTML"))
    .replace(/^function rRenderEditor\(c\) \{/, "")
    .replace(/const box = \$\("rEditor"\);/, "")
    .replace(/const saved = R\.saved\.get\(c\.id\) \|\| \{\};/, "");
  return new Function("saved", "c", head + "; return { days, hours, holiday, kind, months };")
    (saved, candidate);
}

/** 旧東海道（滋賀）。OSM の "no @ (Mo-Fr 07:30-09:00; Sa,Su,PH off)" 由来 */
const osmCandidate = {
  id: "osm-shiga-1", kind: "noMotorcycle",
  activeDays: [1, 2, 3, 4, 5], includesHoliday: false,
  activeHours: { from: "07:30", to: "09:00" },
};

test("まだ登録していない候補では、拾ってきた曜日と時間が初期値になる", () => {
  const got = prefill({}, osmCandidate);
  assert.deepStrictEqual(got.days, [1, 2, 3, 4, 5], "曜日が出ていない");
  assert.deepStrictEqual(got.hours, { from: "07:30", to: "09:00" }, "時間が出ていない");
  assert.strictEqual(got.kind, "noMotorcycle");
});

test("登録済みの内容が候補より優先される", () => {
  // ⚠️ 人が地図を見て直した内容を、候補の値で上書きしてはいけない
  const saved = { kind: "closed", activeDays: [6, 7], includesHoliday: true,
                  activeHours: { from: "10:00", to: "16:00" }, activeMonths: [7, 8] };
  const got = prefill(saved, osmCandidate);
  assert.deepStrictEqual(got.days, [6, 7], "候補の曜日で上書きしている");
  assert.deepStrictEqual(got.hours, { from: "10:00", to: "16:00" }, "候補の時間で上書きしている");
  assert.strictEqual(got.holiday, true, "祝日の指定が消えている");
  assert.strictEqual(got.kind, "closed", "種別が候補で上書きされている");
  assert.deepStrictEqual(got.months, [7, 8]);
});

test("時間を持たない候補では空のまま", () => {
  // 二普協の候補や、終日の規制（ホワイトロード）はここに来る
  const got = prefill({}, { id: "x" });
  assert.deepStrictEqual(got.days, [], "曜日に何か入っている");
  assert.deepStrictEqual(got.hours, {}, "時間に何か入っている");
  assert.strictEqual(got.holiday, false);
  assert.strictEqual(got.kind, "noMotorcycle", "既定が二輪通行禁止になっていない");
});

test("登録済みで祝日を外した指定を、候補の値で戻さない", () => {
  // ⚠️ `??` ではなく `||` で書くと、false（祝日を外した）が「未指定」と扱われ、
  //    候補の値に戻ってしまう。空配列も同じ理由で `||` では扱えない
  const got = prefill({ includesHoliday: false, activeDays: [] },
                      { ...osmCandidate, includesHoliday: true });
  assert.strictEqual(got.holiday, false, "外した祝日が候補の値で戻っている");
  assert.deepStrictEqual(got.days, [], "空にした曜日が候補の値で戻っている");
});

test("一覧に「いつ効くか」が出る", () => {
  // ⚠️ 一覧で終日と時間限定を見分けられないと、夜間だけの規制を
  //    終日のつもりで登録してしまう
  const src = html.match(/function rScheduleLabel\(c\) \{[\s\S]*?\n\}/);
  assert.ok(src, "rScheduleLabel を取り出せない");
  const label = new Function("R", `${src[0]}; return rScheduleLabel;`)({ saved: new Map() });

  assert.strictEqual(label(osmCandidate), "月・火・水・木・金 07:30〜09:00");
  assert.strictEqual(label({ id: "b", activeDays: [7], includesHoliday: true,
                             activeHours: { from: "00:00", to: "06:00" } }),
                     "日 祝 00:00〜06:00");
  // 日をまたぐ夜間（南田中町旭町線）
  assert.strictEqual(label({ id: "c", activeHours: { from: "21:00", to: "05:00" } }),
                     "21:00〜05:00");
  // 終日は空。何も書かないことで「時間の縛りが無い」と分かる
  assert.strictEqual(label({ id: "d" }), "", "終日なのに何か出ている");
});
