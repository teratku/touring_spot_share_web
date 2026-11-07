"use strict";
const test = require("node:test");
const assert = require("node:assert");
const P = require("../lib/devPlanAttach");

/**
 * 調整ツールから開発者のプランに足す決めごと（`lib/devPlanAttach.js`）。
 * 利用者の要望（2026-11-07）:「未知のスポットで開発者のプランに追加できるようにしたい」
 */

const BASE = { lat: 35.4, lng: 138.7 }; // 緯度 0.001 度 ≒ 111m

test("足せるのは 3X7l… の1人だけ（InternalUsers のもう一人も不可）", () => {
  assert.ok(P.isDev("3X7lTlF7bTUOGkb5gWiiLol3a5W2"));
  assert.ok(!P.isDev("5elMKe1WEMPVP3LezAuoMwJbJE32"));
  assert.ok(!P.isDev("someoneElse"));
  assert.ok(!P.isDev(""));
});

test("OSM の候補は印（spotId なし・isCustomPin true）、投稿はスポット", () => {
  const pin = P.spotDict({ name: "白糸の滝", ...BASE }, 2).dict;
  assert.deepStrictEqual(pin, { name: "白糸の滝", lat: 35.4, lng: 138.7, isCustomPin: true, order: 2 });
  const post = P.spotDict({ name: "峠の茶屋", ...BASE, spotId: "abc", address: "静岡県", imageUrl: "https://x/y.jpg" }, 0).dict;
  assert.strictEqual(post.isCustomPin, false);
  assert.strictEqual(post.spotId, "abc");
  assert.strictEqual(post.address, "静岡県");
  assert.strictEqual(post.imageUrl, "https://x/y.jpg");
});

test("名前・緯度経度がおかしければ足さない", () => {
  assert.ok(P.spotDict({ name: " ", ...BASE }, 0).error);
  assert.ok(P.spotDict({ name: "a", lat: "x", lng: 1 }, 0).error);
  assert.ok(P.spotDict({ name: "a", lat: 91, lng: 1 }, 0).error);
});

test("100m 以内に入っていれば足さない・道は見ない", () => {
  const near = { name: "前の印", lat: BASE.lat + 0.0008, lng: BASE.lng };   // 約 89m
  const far = { name: "遠い印", lat: BASE.lat + 0.0012, lng: BASE.lng };    // 約 134m
  const road = { name: "道", lat: BASE.lat, lng: BASE.lng, isRoad: true, path: [[0, 0], [1, 1]] };
  const r1 = P.appended([near], { name: "滝", ...BASE });
  assert.strictEqual(r1.code, 409);
  assert.match(r1.error, /前の印/);
  const r2 = P.appended([far, road], { name: "滝", ...BASE });
  assert.strictEqual(r2.spots.length, 3);
  assert.strictEqual(r2.spot.order, 2);
});

test("10 件入っていれば足さない", () => {
  const full = Array.from({ length: 10 }, (_, i) => ({ name: "s" + i, lat: BASE.lat + 0.01 * (i + 1), lng: BASE.lng }));
  const r = P.appended(full, { name: "滝", ...BASE });
  assert.strictEqual(r.code, 409);
  assert.match(r.error, /10 件まで/);
  assert.strictEqual(P.appended(full.slice(0, 9), { name: "滝", ...BASE }).spots.length, 10);
});
