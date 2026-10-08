"use strict";
const test = require("node:test");
const assert = require("node:assert");
const R = require("../../public/route-maker-lib.js");

/**
 * Web でルートを作る画面の計算部分（public/route-maker-lib.js）。
 * ⚠️ アプリと同じ決めごと（TouringSpot.navDestination・NavWaypointBudget.fitted・ValhallaRouteService.send）
 */

const road = (i, mids) => {
  const pts = Array.from({ length: mids + 2 }, (_, k) => ({ lat: 35 + i * 0.1, lng: 139 + k * 0.01 }));
  return { name: `道${i}`, kind: "road", lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lng, approach: pts.slice(0, -1) };
};
const spot = (i) => ({ name: `S${i}`, kind: "place", lat: 36 + i * 0.1, lng: 139.5, approach: [] });
const count = (ds) => ds.reduce((n, d) => n + d.approach.length + 1, 0);

test("プランの1件を行き先にする（道は通り道の最後がゴール・古い形の通り道も読む）", () => {
  const spots = [
    { name: "B", order: 2, lat: 35.2, lng: 139.2 },
    { name: "峠", order: 1, isRoad: true, roadId: "r:x", roadSection: { entry: "北の端", goal: "南の端", meters: 3000 },
      path: [{ lat: 35.0, lng: 139.0 }, { lat: 35.05, lng: 139.0 }, { lat: 35.1, lng: 139.0 }] },
    { name: "古い道", order: 3, isRoad: true, path: [[36.0, 139.0], [36.1, 139.0]] },
    { name: "壊れた", order: 4, lat: NaN, lng: 139 },
  ];
  const ds = R.toDestinations(spots);
  assert.deepStrictEqual(ds.map((d) => d.name), ["峠", "B", "古い道"], "並び順・壊れた点の除外が違う");
  assert.deepStrictEqual([ds[0].lat, ds[0].approach.length, ds[0].roadID], [35.1, 2, "r:x"], "道のゴール・中継点が違う");
  assert.strictEqual(ds[0].section.entry, "北の端");
  assert.deepStrictEqual([ds[2].kind, ds[2].approach[0].lat], ["road", 36.0], "[緯度, 経度] の古い形を読めない");
});

test("地点が上限を超えたら道の途中の点だけをまんべんなく間引く（アプリと同じ: 39地点・入口とゴールは残す）", () => {
  const ds = [...Array.from({ length: 8 }, (_, i) => road(i, 8)), spot(0), spot(1)];
  assert.strictEqual(count(ds), 82, "材料");
  assert.strictEqual(R.MAX_DESTINATION_POINTS, 39, "アプリの NavWaypointBudget.maxDestinationPoints と違う");
  const fit = R.fitted(ds, R.MAX_DESTINATION_POINTS);
  assert.strictEqual(count(fit), 39, "上限ちょうどまで使っていない／超えている");
  fit.forEach((d, i) => {
    assert.strictEqual(d.lat, ds[i].lat, "ゴールを動かした");
    if (ds[i].approach.length) assert.strictEqual(d.approach[0], ds[i].approach[0], "入口を落とした");
  });
  const kept = fit.slice(0, 8).map((d) => d.approach.length - 1);
  assert.ok(Math.max(...kept) - Math.min(...kept) <= 1, "道によって残す点が偏っている");
  const lngs = fit[0].approach.map((p) => p.lng);
  assert.deepStrictEqual(lngs, [...lngs].sort((a, b) => a - b), "並びが崩れた");
  assert.ok(lngs[lngs.length - 1] - lngs[0] > 0.05, "途中の点が入口に寄っている");
  assert.strictEqual(R.fitted([road(0, 8), spot(0)], 39).length, 2);
  assert.deepStrictEqual(R.fitted([road(0, 8), spot(0)], 39)[0].approach.length, 9, "収まっているのに間引いた");
});

test("経路サーバへの体（立ち寄り先・道の終点の番号・経度緯度の順）", () => {
  const ds = [road(0, 1), spot(1), road(2, 0)];
  const body = R.buildBody({ lat: 35.5, lng: 139.9 }, ds, { displacement: "large", avoidTolls: true, avoidHighways: false, avoidFerries: true });
  assert.deepStrictEqual(body.from, [139.9, 35.5], "[経度, 緯度] の順でない");
  // vias: 道0の入口・中継点・ゴール(2)・S1(3)・道2の入口(4)。to は道2のゴール
  assert.strictEqual(body.vias.length, 5);
  assert.deepStrictEqual(body.stopAt, [2, 3], "立ち寄り先の番号が違う");
  assert.deepStrictEqual(body.throughStopAt, [2], "道の終点で引き返させない印が無い");
  assert.deepStrictEqual(body.to, [139.01, 35.2]);
  assert.strictEqual(body.alternates, 2);
  assert.strictEqual(body.guidance, false);
  assert.strictEqual(body.avoidTolls, true);
});

test("線を読む（5桁）", () => {
  assert.deepStrictEqual(R.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"),
    [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
});
