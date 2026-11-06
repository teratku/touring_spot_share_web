"use strict";
const test = require("node:test");
const assert = require("node:assert");
const U = require("../lib/unknownSpots");
const { encode } = require("../lib/polyline");

/**
 * 未知のスポットの判定（`lib/unknownSpots.js`・定義はアプリの repo の docs/unknown-spots-definition.md）。
 * 利用者の判断（2026-11-06）: B を本命・A も一緒・通り過ぎたは未知のまま。まずは調整ツールで開発者だけが確かめる
 */

// 富士山の近く。緯度 0.001 度 ≒ 111m
const BASE = { lat: 35.4, lng: 138.7 };
const spot = (o) => ({ lat: BASE.lat, lng: BASE.lng, name: "白糸の滝", kind: "waterfall", osm: "n1", r: 0, road: true, ...o });
const post = (dLat, o = {}) => ({ spotId: "p" + dLat, lat: BASE.lat + dLat, lng: BASE.lng, userID: "u1", ...o });

test("投稿から 300m 以内なら投稿済み・外なら未知", () => {
  const near = U.judge(spot(), U.postGrid([post(0.0025)]), null);  // 約 278m
  assert.strictEqual(near.flags & U.FLAG.posted, U.FLAG.posted);
  assert.strictEqual(near.postedBy.spotId, "p0.0025");
  const far = U.judge(spot(), U.postGrid([post(0.0030)]), null);    // 約 334m
  assert.strictEqual(far.flags, 0);
});

test("広い地物（湖）は形の大きさを足して比べる", () => {
  const lake = spot({ kind: "lake", name: "本栖湖", r: 1500 });
  // 中心から 1.6km の湖岸の投稿は、もう投稿済み
  const j = U.judge(lake, U.postGrid([post(0.0144)]), null);
  assert.strictEqual(j.flags & U.FLAG.posted, U.FLAG.posted);
});

test("バイクで行けない（道から遠い・立入禁止）は外す", () => {
  const pg = U.postGrid([]);
  assert.strictEqual(U.judge(spot({ road: false }), pg, null).flags, U.FLAG.noRoad);
  assert.strictEqual(U.judge(spot({ x: { access: "private" } }), pg, null).flags, U.FLAG.closed);
});

test("値打ちの手がかり: 種類（展望所・滝・峠・岬）・wiki・文化財・おすすめ道路 1km", () => {
  const pg = U.postGrid([]);
  assert.strictEqual(U.judge(spot({ kind: "onsen", name: "○○温泉" }), pg, null).flags, U.FLAG.noValue);
  assert.strictEqual(U.judge(spot({ kind: "onsen", x: { wikidata: "Q1" } }), pg, null).flags, 0);
  assert.strictEqual(U.judge(spot({ kind: "historic", x: { heritage: "2" } }), pg, null).flags, 0);
  // おすすめ道路が 0.8km 先を通る（⚠️ polyline は [経度, 緯度]）
  const line = encode([[BASE.lng - 0.01, BASE.lat + 0.0072], [BASE.lng + 0.01, BASE.lat + 0.0072]]);
  const roads = U.funRoadGrid([{ id: "静岡県:1", polyline: line }]);
  const j = U.judge(spot({ kind: "onsen" }), pg, roads);
  assert.strictEqual(j.flags, 0);
  assert.strictEqual(j.funRoad, true);
  // 1.5km 先なら手がかりにならない
  const farLine = encode([[BASE.lng - 0.01, BASE.lat + 0.0135], [BASE.lng + 0.01, BASE.lat + 0.0135]]);
  assert.strictEqual(U.judge(spot({ kind: "onsen" }), pg, U.funRoadGrid([{ id: "x", polyline: farLine }])).flags, U.FLAG.noValue);
});

test("種類ごとの数", () => {
  const r = U.classify([spot(), spot({ osm: "n2", road: false }), spot({ osm: "n3", kind: "onsen" })], [post(0.0001)], null);
  assert.deepStrictEqual(r.counts.waterfall, { all: 2, unknown: 0, posted: 2, noRoad: 1, noValue: 0, closed: 0 });
  assert.strictEqual(r.spots.length, 3);
  assert.strictEqual(r.spots[0][7], "p0.0001", "近くの投稿の id を付ける（画面で確かめる）");
});

test("A: 自分の投稿から 300m 以内に無い、ほかの人の投稿", () => {
  const posts = [post(0, { userID: "me" }), post(0.002, { userID: "other" }), post(0.01, { userID: "other" })];
  const r = U.othersUnknown(posts, "me");
  assert.strictEqual(r.mine, 1);
  assert.strictEqual(r.others, 2);
  assert.deepStrictEqual(r.unknown.map((p) => p.spotId), ["p0.01"], "自分の投稿のそば（222m）の投稿は知っている");
});
