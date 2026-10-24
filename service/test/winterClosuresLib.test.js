"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const W = require("../../public/winter-closures-lib.js");

/**
 * Web の冬季閉鎖（winter-closures.html）。アプリの WinterClosureListTests と同じ例で、同じ答えになるか。
 * ⚠️ 利用者の要望（2026-10-25）:「webにも表示できるようにしたい」
 */

const winter = (name, from, to, extra = {}) => Object.assign({
  id: name + (from || ""), kind: "winterClosure", name, prefecture: "長野県",
  activePeriod: from ? { from, to } : null, activeMonths: null, checkedAt: "2026-10-24",
}, extra);
const day = (y, m, d) => new Date(y, m - 1, d, 12);

test("閉鎖中・まもなく・通れるの順に並べ日数を出す（アプリと同じ）", () => {
  const list = W.entries([
    winter("志賀草津道路", "12-20", "04-22"),
    winter("ビーナスライン", "11-16", "04-24"),
    winter("乗鞍岳線", "11-01", "06-30"),
    { id: "x", kind: "noMotorcycle", name: "二輪禁止の道" },
  ], day(2026, 11, 3));
  assert.deepStrictEqual(list.map((e) => e.name), ["乗鞍岳線", "ビーナスライン", "志賀草津道路"]);
  assert.deepStrictEqual(list.map((e) => e.status), ["closed", "soon", "open"]);
  assert.strictEqual(list[0].reopens, "7/1");
  assert.strictEqual(list[0].days, 240);
  assert.strictEqual(list[1].days, 13);
  assert.strictEqual(list[1].schedule, "11/16〜4/24");
  assert.strictEqual(list[2].days, 47);
  assert.strictEqual(W.statusText(list[0]), "7/1 開通予定（あと240日）");
  assert.strictEqual(W.statusText(list[1]), "あと13日で閉鎖");
});

test("閉鎖の最終日は閉鎖中・翌日の開通日は通れる", () => {
  const r = winter("ビーナスライン", "11-16", "04-24");
  const last = W.entries([r], day(2027, 4, 24))[0];
  assert.strictEqual(last.status, "closed");
  assert.strictEqual(last.reopens, "4/25");
  assert.strictEqual(last.days, 1);
  const reopen = W.entries([r], day(2027, 4, 25))[0];
  assert.strictEqual(reopen.status, "open");
  assert.strictEqual(reopen.days, 205);
});

test("同じ道の区間は1行・月だけの登録は日数を出さない", () => {
  const list = W.entries([
    winter("乗鞍岳線", "11-01", "06-30"), winter("乗鞍岳線", "11-01", "06-30"),
    winter("月だけの道", null, null, { activeMonths: [12, 1, 2, 3] }),
  ], day(2026, 12, 10));
  assert.strictEqual(list.filter((e) => e.name === "乗鞍岳線").length, 1);
  const monthsOnly = list.find((e) => e.name === "月だけの道");
  assert.strictEqual(monthsOnly.status, "closed");
  assert.strictEqual(monthsOnly.days, null);
  assert.strictEqual(monthsOnly.schedule, "12・1・2・3月");
});

test("全国で見るときは県が違えば同じ名前でも別の行", () => {
  const list = W.entries([
    winter("八幡平アスピーテライン", "11-04", "04-14", { prefecture: "秋田県" }),
    winter("八幡平アスピーテライン", "11-04", "04-14", { prefecture: "岩手県" }),
  ], day(2026, 10, 25));
  assert.strictEqual(list.length, 2);
});

test("期間の決まりは調整ツール（restrictionTime.js）と同じ", () => {
  const T = require("../../admin/lib/restrictionTime.js");
  for (const p of [{ from: "11/15", to: "4-24" }, { from: "07-01", to: "10-31" }, { from: "04-24", to: "04-10" }, { from: "02-30", to: "03-01" }]) {
    assert.deepStrictEqual(W.normalizePeriod(p), T.normalizePeriod(p), JSON.stringify(p));
    assert.deepStrictEqual(W.monthsOfPeriod(p), T.monthsOfPeriod(p), JSON.stringify(p));
    assert.strictEqual(W.describePeriod(p), T.describePeriod(p), JSON.stringify(p));
  }
});

test("県名とローマ字は調整ツールと同じ", () => {
  assert.deepStrictEqual(W.ROMAJI, require("../../admin/lib/prefectureRomaji.js").ROMAJI);
});

test("いる場所の県", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../public/conquest/prefecture-data.js"), "utf8");
  const PREFECTURES = new Function(src + "; return PREFECTURES;")();
  assert.strictEqual(W.prefectureAt(36.65, 138.18, PREFECTURES), "長野県");
  assert.strictEqual(W.prefectureAt(43.06, 141.35, PREFECTURES), "北海道");
  assert.strictEqual(W.prefectureAt(10, 10, PREFECTURES), null);
});
