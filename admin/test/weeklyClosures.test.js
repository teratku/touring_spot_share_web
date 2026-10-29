"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { weeklyClosures, postText, xLength, hourFromNote } = require("../lib/weeklyClosures");

/** X の毎週の「来週閉まる道」（2026-10-28 利用者の要望） */
const r = (name, from, to, extra = {}) => Object.assign({ kind: "winterClosure", name, prefecture: "群馬県",
  activePeriod: { from, to }, note: "" }, extra);

test("来週の7日に閉まる道だけ・日付の順", () => {
  const out = weeklyClosures([
    r("志賀草津道路", "11-11", "04-20", { note: "2026〜27年は 11/11 13時〜4/21 10時（群馬県）" }),
    r("金精道路", "12-25", "04-22"),
    r("水上片品線", "11-05", "05-20", { note: "11/5 14時〜5/21 10時" }),
  ], new Date(2026, 10, 5), 7);
  assert.deepStrictEqual(out.closing.map((x) => x.name), ["水上片品線", "志賀草津道路"]);
  assert.strictEqual(out.closing[1].dateLabel, "11/11(水)");
  assert.strictEqual(out.closing[1].hour, "13時");
  assert.strictEqual(out.range.label, "11/5(木)〜11/11(水)");
});

test("今冬の発表が無い道は「例年」・時刻は出さない", () => {
  const out = weeklyClosures([r("蔵王エコーライン", "11-05", "04-23", { prefecture: "宮城県", note: "例年 11/5 17時から。2026〜27年は未発表" }),
                              r("蔵王エコーライン", "11-05", "04-23", { prefecture: "山形県", note: "2026〜27年は未発表" })],
                             new Date(2026, 10, 1), 7);
  assert.strictEqual(out.closing.length, 1, "県境の道を2行にした");
  assert.strictEqual(out.closing[0].usual, true);
  assert.strictEqual(out.closing[0].hour, "");
  assert.strictEqual(out.closing[0].prefecture, "宮城県・山形県");
  assert.ok(postText(out).includes("蔵王エコーライン*"));
  assert.ok(postText(out).includes("*今季は未発表"));
});

test("春は開通（閉鎖の最終日の翌日）を出す", () => {
  const out = weeklyClosures([r("志賀草津道路", "11-11", "04-20", { note: "4/21 10時" })], new Date(2027, 3, 18), 7);
  assert.strictEqual(out.closing.length, 0);
  assert.deepStrictEqual(out.reopening.map((x) => [x.dateLabel, x.hour]), [["4/21(水)", "10時"]]);
  assert.ok(postText(out).includes("【今週開く道】"));
  assert.ok(postText(out).includes("4/21(水) 10時 志賀草津道路 開通"));
});

test("何も無い週は投稿文が空・冬季閉鎖以外は数えない", () => {
  const out = weeklyClosures([r("峠", "12-01", "03-31"), { kind: "noMotorcycle", name: "x", activePeriod: { from: "06-01", to: "06-30" } }],
                             new Date(2026, 5, 1), 7);
  assert.strictEqual(postText(out), "");
});

test("時刻はその日の分だけ拾う", () => {
  assert.strictEqual(hourFromNote("11/11 13時〜4/21 10時", new Date(2026, 10, 11)), "13時");
  assert.strictEqual(hourFromNote("11/25 11時30分〜", new Date(2026, 10, 25)), "11時30分");
  assert.strictEqual(hourFromNote("11/11 13時", new Date(2026, 10, 12)), "");
});

test("X の上限（280）に収まるまで行を減らして「ほか n本」", () => {
  const many = Array.from({ length: 12 }, (_, i) => r(`とても長い名前の山岳道路その${i + 1}号線`, "11-05", "04-20", { note: "未発表" }));
  const text = postText(weeklyClosures(many, new Date(2026, 10, 1), 7), { url: "https://biketeilen.web.app/winter-closures.html" });
  assert.ok(xLength(text) <= 280, `長すぎる ${xLength(text)}`);
  assert.match(text, /ほか \d+本は画像と一覧で/);
  assert.ok(text.endsWith("https://biketeilen.web.app/winter-closures.html"));
});

test("X の長さ: 日本語は2・半角は1・URL は23", () => {
  assert.strictEqual(xLength("あa"), 3);
  assert.strictEqual(xLength("見る https://example.com/very/long/path"), 4 + 1 + 23);
});
