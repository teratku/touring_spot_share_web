"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { alternatesNoMoreFerry, FERRY_MANEUVER } = require("../lib/valhallaRoute");

/**
 * 「フェリーを避ける」とき、**本命より船に長く乗る代替を返さない**処理の確認（Valhalla 不要）。
 *
 * ⚠️ 実機で報告（2026-09-23・新座→霧島市・50cc）: 本命は船0kmなのに、代替が
 *    宇野－高松と四国→九州の船 88.7km を通っていた。船は近道なので、アプリが
 *    「いちばん速くて短い」として先頭に出してしまった。
 */

/** 船の距離（km）を並べた経路。Valhalla の trip と同じ形（maneuver.type=28 が船） */
const 経路 = (...船km) => ({
  trip: { legs: [{ maneuvers: [
    { type: 1, length: 5 },
    ...船km.map((length) => ({ type: FERRY_MANEUVER, length })),
  ] }] },
});

test("本命が船に乗らないなら、船に乗る代替は外す", () => {
  const out = alternatesNoMoreFerry(経路().trip, [経路(20.8, 67.9), 経路(), 経路(0.3)]);
  assert.strictEqual(out.length, 1, "船に乗る代替が残っている");
  assert.deepStrictEqual(out[0], 経路());
});

test("本命も船に乗るなら（避けられない航路）、同じ長さまでの代替は残す", () => {
  // 北海道へは船なしで行けない。本命より短い・同じ船の代替は外さない
  const out = alternatesNoMoreFerry(経路(39).trip, [経路(39), 経路(20), 経路(235)]);
  assert.deepStrictEqual(out.map((a) => a.trip.legs[0].maneuvers.length - 1), [1, 1],
    "避けられない船と同じか短い代替まで外している／長い船の代替を残している");
});

test("中身の無い代替は捨てる", () => {
  assert.deepStrictEqual(alternatesNoMoreFerry(経路().trip, [null, {}, 経路()]), [経路()]);
  assert.deepStrictEqual(alternatesNoMoreFerry(経路().trip, undefined), []);
});
