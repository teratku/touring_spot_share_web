"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * Web のスポットの日付（利用者の報告 2026-10-12:「web のスポットの日付が N/A になってしまっている」）。
 * 端末のキャッシュ（touring_locations_cache・JSON）から読み直すと Firestore の日時が {seconds, nanoseconds} になり、
 * toDate を持たないので「N/A」になっていた
 */
const grab = (file, name) => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", file), "utf8");
  const m = html.match(new RegExp(`\\n(\\s*)${name}\\(timestamp\\) \\{[\\s\\S]*?\\n\\1\\}`));
  assert.ok(m, `${file} から ${name} を取り出せない`);
  return new Function(`return function ${m[0].trim()};`)();
};
const when = new Date("2026-10-01T03:04:00Z");

for (const [file, name] of [["user.html", "formatTimestamp"], ["user.html", "formatRouteDate"], ["detail.html", "formatTimestamp"]]) {
  test(`${file} の ${name} はキャッシュの形・Firestore の形の両方を読む`, () => {
    const f = grab(file, name);
    const fromFirestore = f({ toDate: () => when });
    assert.notStrictEqual(fromFirestore, "N/A");
    assert.strictEqual(f({ seconds: when.getTime() / 1000, nanoseconds: 0 }), fromFirestore, "キャッシュから読んだ日時を N/A にした");
    assert.strictEqual(f({ _seconds: when.getTime() / 1000, _nanoseconds: 0 }), fromFirestore);
    assert.strictEqual(f(when.toISOString()), fromFirestore, "文字列の日時を読めない");
    assert.strictEqual(f(null), "N/A");
    assert.strictEqual(f("こわれた"), "N/A", "読めない値で Invalid Date と出した");
  });
}
