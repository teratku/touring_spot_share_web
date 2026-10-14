"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const P = require("../../public/plan-road-lib.js");

/**
 * Web のプランでもおすすめ道路の入口と出口を入れ替えて保存する（利用者の要望 2026-10-14:
 * 「入れ替えるとそれをプランにも保存する」「プランでもアプリのようにできるようにする」）。
 * 保存の形はアプリの TouringSpot.reversedRoad と同じ
 */
const road = {
  name: "ぶどうまつたけライン", isRoad: true, order: 1, roadId: "山形県:45", lat: 37.92, lng: 140.13,
  path: [{ lat: 38.07, lng: 140.18 }, { lat: 38.0, lng: 140.15 }, { lat: 37.92, lng: 140.13 }],
  roadSection: { entry: "北の端", goal: "南の端", meters: 27900 },
};

test("通り道ごと裏返し、出口の座標・区間の呼び名・入れ替えた印をアプリと同じ形にする", () => {
  const f = P.reversedPlanSpot(road);
  assert.deepStrictEqual(f.path, road.path.slice().reverse(), "通り道を裏返していない");
  assert.deepStrictEqual({ lat: f.lat, lng: f.lng }, { lat: 38.07, lng: 140.18 }, "出口（lat/lng）が新しい出口になっていない");
  assert.deepStrictEqual(f.roadSection, { entry: "南の端", goal: "北の端", meters: 27900 }, "区間の呼び名を入れ替えていない");
  assert.strictEqual(f.directionByUser, true, "入れ替えた印が無い（アプリのルート生成が向きを戻そうとする）");
  assert.strictEqual(f.roadId, road.roadId, "道の ID を落とした");
  assert.deepStrictEqual(road.path[0], { lat: 38.07, lng: 140.18 }, "元のスポットを書き換えた");
  const back = P.reversedPlanSpot(f);
  assert.deepStrictEqual(back.path, road.path, "2回入れ替えても元に戻らない");
  // 古い形（[緯度, 経度]）はその形のまま
  const old = Object.assign({}, road, { path: [[38.07, 140.18], [37.92, 140.13]], roadSection: undefined });
  assert.deepStrictEqual(P.reversedPlanSpot(old).path, [[37.92, 140.13], [38.07, 140.18]]);
  const spot = { name: "猪苗代", lat: 37.5, lng: 140.1 };
  assert.strictEqual(P.reversedPlanSpot(spot), spot, "スポットを変えた");
});

test("区間の呼び名が無い道は向きを添える（入れ替えたのが分かる）", () => {
  const plain = Object.assign({}, road, { roadSection: undefined });
  assert.match(P.roadSubtitle(plain), /（北から南へ）$/);
  assert.match(P.roadSubtitle(P.reversedPlanSpot(plain)), /（南から北へ）$/, "入れ替えても向きの表示が変わらない");
  assert.match(P.roadSubtitle(road), /北の端 → 南の端/);
});

test("プラン画面に入れ替えのボタンがあり、保存する", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "touring-plan.html"), "utf8");
  assert.ok(/<button v-if="roadSubtitle\(spot\)" class="flip-road-btn"/.test(html), "道の行に入れ替えのボタンが無い");
  assert.ok(/const flipped = PlanRoads\.reversedPlanSpot\(spot\);/.test(html), "アプリと同じ形で裏返していない");
  assert.ok(/\.update\(\{\n\s+spots: newSpots,\n\s+updatedAt: firebase\.firestore\.FieldValue\.serverTimestamp\(\)\n\s+\}\);\n\s+plan\.spots = newSpots;\n\s+await nextTick\(\);\n\s+const el = document\.getElementById\('map-' \+ plan\.id\);\n\s+if \(el\) initPlanMap\(plan\);\n\s+computeRouteInfo\(plan\);\n\s+\} catch \(e\) \{\n\s+console\.error\('入れ替えエラー:'/.test(html),
    "入れ替えを保存して地図を描き直していない");
  assert.ok(/plan-road-lib\.js\?v=2/.test(html), "ブラウザに古い plan-road-lib.js が残る");
});
