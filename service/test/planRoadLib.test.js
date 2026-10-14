"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const P = require("../../public/plan-road-lib.js");

/**
 * Web のプラン画面のおすすめ道路（public/plan-road-lib.js）。利用者の要望（2026-10-11）:「web でもおすすめ道路を表示したい」。
 * アプリがプランに入れた道（TouringSpot の isRoad・path・roadSection）を、点ではなく道として出す
 */
const road = { name: "道志みち", isRoad: true, lat: 35.5, lng: 139.2,
  path: [{ lat: 35.5, lng: 139.0 }, { lat: 35.5, lng: 139.1 }, { lat: 35.5, lng: 139.2 }] };
const spot = { name: "オギノパン", lat: 35.6, lng: 139.3, spotId: "x" };

test("通り道を読み（古い形の [緯度, 経度] も）、道でなければ空", () => {
  assert.deepStrictEqual(P.roadPath(road).length, 3);
  assert.deepStrictEqual(P.roadPath({ isRoad: true, path: [[36.0, 139.0], [36.1, 139.0]] }),
                         [{ lat: 36.0, lng: 139.0 }, { lat: 36.1, lng: 139.0 }], "古い形の通り道を読んでいない");
  assert.deepStrictEqual(P.roadPath(spot), []);
  assert.deepStrictEqual(P.roadPath({ isRoad: false, path: road.path }), [], "道でない印のものを道にした");
  assert.deepStrictEqual(P.roadPath({ isRoad: true, path: [{ lat: 35, lng: 139 }] }), [], "1点の通り道を道にした");
});

test("一覧の説明はアプリと同じ言い方（区間があれば入口 → ゴール、無ければ全長）", () => {
  assert.strictEqual(P.roadSubtitle({ ...road, roadSection: { entry: "北の端", goal: "南の端", meters: 3000 } }),
                     "おすすめ道路・北の端 → 南の端（3.0km）");
  // ⚠️ 2026-10-14 から区間の呼び名が無い道には向きを添える（入れ替えたのが分かるように）
  assert.match(P.roadSubtitle(road), /^おすすめ道路・全長 18\.\dkm(（.+から.+へ）)?$/, P.roadSubtitle(road));
  assert.strictEqual(P.roadSubtitle(spot), null, "スポットを道と書いた");
});

test("地図の線は道の通り道に沿い、Google マップには入口とゴールを渡す", () => {
  const pts = P.routePoints([spot, road]);
  assert.strictEqual(pts.length, 4, "道をゴールの1点にした（道を走らない直線になる）");
  assert.deepStrictEqual(pts[1], road.path[0]);
  assert.deepStrictEqual(P.mapsStops([spot, road]), [{ lat: 35.6, lng: 139.3 }, road.path[0], road.path[2]],
                         "道の入口とゴールを経由地にしていない");
  assert.strictEqual(P.mapsStops([road]).length, 2, "道1本だけで経路にならない");
  const km = P.pathMeters(P.routePoints([road])) / 1000;
  assert.ok(km > 18 && km < 18.3, `道の長さ ${km}`);
});

test("プラン画面は部品を読み込み、行・地図・距離・Googleマップで道を使う", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "touring-plan.html"), "utf8");
  assert.match(html, /<script src="\/plan-road-lib\.js\?v=\d+"><\/script>/);
  assert.match(html, /v-if="roadSubtitle\(spot\)">🛣️ \{\{ roadSubtitle\(spot\) \}\}/, "一覧で道をカスタムピンと出している");
  assert.match(html, /const road = PlanRoads\.roadPath\(spot\);/, "地図に道の通り道を描いていない");
  assert.match(html, /const linePoints = PlanRoads\.routePoints\(plan\.spots\);/, "地図の線を道に沿わせていない");
  assert.match(html, /const stops = PlanRoads\.mapsStops\(plan\.spots \|\| \[\]\);\n      if \(stops\.length === 0\) return;/,
               "Google マップに道の入口を渡していない");
  assert.match(html, /const km = PlanRoads\.pathMeters\(PlanRoads\.routePoints\(plan\.spots\)\) \/ 1000;/, "距離に道の長さを使っていない");
});
