"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const S = require("../../public/place-search-lib.js");

/**
 * Web で場所を入力して探す（利用者の要望 2026-10-15:「目的地を決める」と同じように入力して位置を決めたい・履歴も共通化）。
 * アプリの CoordinateParser・DestinationHistoryStore・TouringSpot.toDict と同じ決めごと
 */
const near = (a, b) => Math.abs(a - b) < 1e-6;

test("座標の書き方をアプリと同じに読む（十進・東西南北・度分秒・全角・読点）", () => {
  const c = (t) => S.parseCoordinate(t);
  assert.deepStrictEqual(c("35.68,139.76"), { lat: 35.68, lng: 139.76 });
  assert.deepStrictEqual(c(" 35.68 139.76 "), { lat: 35.68, lng: 139.76 });
  assert.deepStrictEqual(c("N35.68 E139.76"), { lat: 35.68, lng: 139.76 });
  assert.deepStrictEqual(c("S33.8 E151.2"), { lat: -33.8, lng: 151.2 }, "南を負にしていない");
  assert.deepStrictEqual(c("３５．６８、１３９．７６"), { lat: 35.68, lng: 139.76 }, "全角・読点を読めない");
  const dms = c("35°40'54\"N 139°46'1\"E");
  assert.ok(dms && near(dms.lat, 35 + 40 / 60 + 54 / 3600) && near(dms.lng, 139 + 46 / 60 + 1 / 3600), "度分秒を読めない");
  assert.strictEqual(c("35°40'54\"N 139°46'1\"E 36°0'0\"N"), null, "度分秒が3つあるのに場所にした（アプリは2つだけ読む）");
  assert.strictEqual(c("0,0"), null, "0,0 を場所にした");
  assert.strictEqual(c("91,139"), null, "範囲の外を場所にした");
  assert.strictEqual(c("箱根"), null);
  assert.strictEqual(c("35.68"), null, "数が1つで場所にした");
  assert.strictEqual(c("35.68,139.76,10"), null, "数が3つで場所にした");
  const cand = S.coordinateCandidate({ lat: 35.68, lng: 139.76 });
  assert.strictEqual(cand.name, "35.68000, 139.76000");
  assert.strictEqual(cand.id, "coord:35.68,139.76");
});

test("打ちながら探すのは2文字から・住所の頭の「日本、」と郵便番号を落とす", () => {
  assert.strictEqual(S.searchable("箱"), false, "1文字で打つたびに探している（アプリと違う）");
  assert.strictEqual(S.searchable(" 箱根 "), true);
  assert.strictEqual(S.cleanAddress("日本、〒250-0631 神奈川県足柄下郡箱根町"), "神奈川県足柄下郡箱根町");
});

test("履歴は同じ場所を先頭へ動かすだけで重ねず、20件まで（DestinationHistoryStore と同じ）", () => {
  const p = (id, name) => ({ id, name, address: "神奈川県", lat: 35.2, lng: 139.0 });
  let list = S.recordedHistory([], p("a", "大観山"), 1);
  list = S.recordedHistory(list, p("b", "芦ノ湖"), 2);
  list = S.recordedHistory(list, p("a", "大観山"), 3);
  assert.deepStrictEqual(list.map((h) => h.id), ["a", "b"], "同じ場所を重ねた／先頭に来ない");
  assert.strictEqual(list[0].savedAt, 3);
  for (let i = 0; i < 30; i++) list = S.recordedHistory(list, p("x" + i, "場所" + i), 10 + i);
  assert.strictEqual(list.length, S.HISTORY_LIMIT);
  assert.strictEqual(list[0].id, "x29");
  assert.deepStrictEqual(S.recordedHistory([], { id: "n", name: "  ", lat: 35, lng: 139 }, 1), [], "名前の無いものを積んだ");
  assert.deepStrictEqual(S.recordedHistory([], { id: "n", name: "x", lat: NaN, lng: 139 }, 1), [], "座標の無いものを積んだ");
  assert.deepStrictEqual(S.removedHistory(list, "x29").length, S.HISTORY_LIMIT - 1);
  assert.deepStrictEqual(S.readHistory("{壊れた"), []);
  assert.deepStrictEqual(S.readHistory(JSON.stringify([{ id: "a", name: "A", lat: 1, lng: 2 }, { id: "b" }])).map((h) => h.id), ["a"]);
});

test("探した場所をプランのカスタムピンとして、ゴール・途中・出発地・置き換えに入れる", () => {
  const spot = S.placeSpot({ name: "大観山", address: "神奈川県", lat: 35.2, lng: 139.0, id: "ChIJx" });
  assert.deepStrictEqual(spot, { name: "大観山", lat: 35.2, lng: 139.0, isCustomPin: true, order: 0, address: "神奈川県" });
  assert.ok(!("spotId" in spot), "投稿のスポットの ID に場所の ID を入れた（詳細を開こうとする）");
  assert.ok(!("address" in S.placeSpot(S.coordinateCandidate({ lat: 35.3, lng: 139.9 }))), "「座標で指定」を住所としてプランに入れた");
  const a = { name: "A" }, b = { name: "B" }, c = { name: "C" };
  assert.deepStrictEqual(S.placedSpots([a, b, c], spot, "goal").map((s) => s.name), ["A", "B", "C", "大観山"]);
  assert.deepStrictEqual(S.placedSpots([a, b, c], spot, "waypoint").map((s) => s.name), ["A", "B", "大観山", "C"], "途中がゴールの手前でない");
  assert.deepStrictEqual(S.placedSpots([a, b, c], spot, "start").map((s) => s.name), ["大観山", "A", "B", "C"],
                         "出発地を最初に入れていない（前の出発地は最初の立ち寄り先に残す）");
  assert.deepStrictEqual(S.placedSpots([a, b, c], spot, "replace", b).map((s) => s.name), ["A", "大観山", "C"]);
  assert.deepStrictEqual(S.placedSpots([a, b], spot, "replace", c).map((s) => s.name), ["A", "B"], "無い行を置き換えた");
  assert.deepStrictEqual(S.placedSpots([], spot, "waypoint").map((s) => s.name), ["大観山"]);
  assert.strictEqual(S.placedIndex(3, "goal"), 3);
  assert.strictEqual(S.placedIndex(3, "waypoint"), 2);
  assert.strictEqual(S.placedIndex(3, "start"), 0);
  assert.strictEqual(S.canAdd(S.SPOTS_PER_PLAN - 1, "goal"), true);
  assert.strictEqual(S.canAdd(S.SPOTS_PER_PLAN, "goal"), false, "プランの上限を超えて入れた");
  assert.strictEqual(S.canAdd(S.SPOTS_PER_PLAN, "replace"), true, "置き換えまで上限で止めた");
});

test("ルート作成の画面が場所の検索を使い、プランに保存する", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "route-maker.html"), "utf8");
  assert.match(html, /<script src="\/place-search-lib\.js\?v=\d+"><\/script>/, "部品を読み込んでいない");
  assert.match(html, /PS\.parseCoordinate\(text\)/, "座標を通信せずに読んでいない");
  assert.match(html, /getPlacePredictions\(/, "場所の候補を探していない");
  assert.match(html, /geocode\(\{ address: text/, "候補が無いときに住所として探していない");
  assert.match(html, /PS\.recordedHistory\(readPlaceHistory\(\), place\)/, "選んだ場所を履歴に積んでいない");
  assert.match(html, /await savePlanOrder\(PS\.placedSpots\(/, "選んだ場所をプランに保存していない");
  assert.match(html, /PS\.canAdd\(/, "プランの上限を見ていない");
  assert.match(html, /el\("startFirst"\)\.checked = true/, "出発地を選んだのに「最初の場所から」にしていない");
});
