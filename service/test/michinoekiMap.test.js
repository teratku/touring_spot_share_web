"use strict";
const test = require("node:test");
const assert = require("node:assert");
const M = require("../../public/michinoeki-map.js");

/**
 * Web の道の駅マップ。アプリの MichiNoEkiMapDataTests と同じ例。
 * ⚠️ 利用者の要望（2026-10-30）:「道の駅マップ」→「webも同じようにしたい」
 */
const eki = (id, admin, lat = "36.0", lng = "139.0") => ({ id, name: "駅" + (id || ""), lat, lng, admin, comment: null, images: [] });
const d1 = Date.parse("2023-11-14T22:13:20Z");
const d2 = d1 + 86400000;

test("訪問記録の ID で訪問済みになり、日付は古い順", () => {
  const items = M.items([eki("1", "北海道"), eki("2", "北海道")], [{ id: "2", name: "", visitDates: [d2, d1] }]);
  assert.deepStrictEqual(items.map(M.isVisited), [false, true]);
  assert.deepStrictEqual(items[1].visitDates, [d1, d2]);
});

test("座標が読めない・(0,0)・ID が無い・同じ ID の2行目は出さない", () => {
  const items = M.items([eki("1", "青森県", null), eki("2", "青森県", "0", "0"), eki(null, "青森県"), eki("3", "青森県", "abc"),
                         eki("4", "青森県"), eki("4", "青森県")], []);
  assert.deepStrictEqual(items.map((i) => i.id), ["4"]);
});

test("同じ ID の空の行が先にあっても、あとのちゃんとした行を出す（本番の 1147 佐賀関）", () => {
  const items = M.items([{ id: "1147", name: null, lat: null, lng: null, admin: null, images: [] },
                         { id: "1147", name: "道の駅佐賀関", lat: "33.2472111", lng: "131.8284304", admin: "大分県", images: [] }], []);
  assert.deepStrictEqual(items.map((i) => i.name), ["道の駅佐賀関"]);
});

test("日付が空の記録は訪問済みにしない", () => {
  assert.strictEqual(M.isVisited(M.items([eki("1", "岩手県")], [{ id: "1", name: "", visitDates: [] }])[0]), false);
});

test("都道府県は一覧の順・県名の無いものは数えない・全部行けば達成", () => {
  const items = M.items([eki("1", "北海道"), eki("2", "青森県"), eki("3", "北海道"), eki("4", null), eki("5", "青森県")],
                        [{ id: "2", visitDates: [d1] }, { id: "5", visitDates: [d1] }, { id: "3", visitDates: [d1] }]);
  const prefs = M.prefectures(items);
  assert.deepStrictEqual(prefs.map((p) => [p.name, p.visited, p.total, p.complete]),
                         [["北海道", 1, 2, false], ["青森県", 2, 2, true]]);
});

test("絞り込み", () => {
  const items = M.items([eki("1", "秋田県"), eki("2", "秋田県")], [{ id: "1", visitDates: [d1] }]);
  assert.deepStrictEqual(items.filter((i) => M.shows("visited", i)).map((i) => i.id), ["1"]);
  assert.deepStrictEqual(items.filter((i) => M.shows("unvisited", i)).map((i) => i.id), ["2"]);
  assert.strictEqual(items.filter((i) => M.shows("all", i)).length, 2);
});

test("バックアップの文字列（アプリの encodeBackup と同じ ISO8601）を読む・読めないものは null", () => {
  // アプリの MichiNoEkiWebSyncTests.testBackupRoundTripISO8601 と同じ日時
  const v = M.parseBackup('[{"id":"292","name":"道の駅季の里天栄","visitDates":["2023-11-14T22:13:20Z","bad"]}]');
  assert.deepStrictEqual(v, [{ id: "292", name: "道の駅季の里天栄", visitDates: [d1] }]);
  assert.strictEqual(M.parseBackup("not json"), null);
  assert.strictEqual(M.parseBackup(undefined), null);
});

test("新しい訪問から", () => {
  const items = M.items([eki("1", "秋田県"), eki("2", "秋田県")], [{ id: "1", visitDates: [d1, d2] }, { id: "2", visitDates: [d1 + 1000] }]);
  assert.deepStrictEqual(M.recent(items, 2).map((r) => [r.id, r.date]), [["1", d2], ["2", d1 + 1000]]);
});
