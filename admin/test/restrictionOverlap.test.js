"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { findOverlaps, overlapRatio, MIN_RATIO } = require("../lib/restrictionOverlap");
const { decode } = require("../lib/polyline");

/**
 * 通行規制とおすすめ道路が重なっていないかの判定。
 *
 * ⚠️ 生成もアプリも規制を見ていない。二輪通行禁止の道がおすすめとして配信され、
 *    ルート生成が自分でそれを選ぶことがあり得る（走れない道へ案内することになる）。
 *
 * ⚠️ **判定が壊れていても「0件」としか見えない。** 実データで0件だったときに
 *    「重なりが無い」のか「見つけられていない」のか区別できないので、
 *    ここで**当たる材料**を必ず通すこと。
 */
const recFile = path.join(__dirname, "..", "data", "road-recommend", "tochigi.json");
const hasData = fs.existsSync(recFile);
const roads = hasData
  ? JSON.parse(fs.readFileSync(recFile, "utf8")).segments.slice(0, 30)
      .map((s) => ({ id: s.id, name: s.name, points: decode(s.polyline) }))
  : [];

const restriction = (points) => [{ id: "R", name: "試験規制", kind: "noMotorcycle", points }];

test("道の一部に掛かる規制を見つける", (t) => {
  if (!hasData) return t.skip("配信データが未生成");
  const target = roads[0];
  const pts = target.points;
  const part = pts.slice(Math.floor(pts.length * 0.35), Math.floor(pts.length * 0.65));

  const found = findOverlaps(restriction(part), roads);

  assert.ok(found.has(target.id), `見逃している（重なり率 ${overlapRatio(part, pts).toFixed(2)}）`);
});

test("道全体に掛かる規制も見つける", (t) => {
  if (!hasData) return t.skip("配信データが未生成");
  const target = roads[0];
  const found = findOverlaps(restriction(target.points), roads);
  assert.ok(found.has(target.id));
});

test("交差するだけの道は重なりとみなさない", (t) => {
  if (!hasData) return t.skip("配信データが未生成");
  // ⚠️ ここが緩いと、交差点を通る道が軒並み「規制されている」ことになる
  const target = roads[0];
  const at = target.points[10];
  const crossing = [[at[0] - 0.02, at[1]], at, [at[0] + 0.02, at[1]]];

  const found = findOverlaps(restriction(crossing), roads);

  assert.ok(!found.has(target.id),
            `交差するだけで拾っている（重なり率 ${overlapRatio(crossing, target.points).toFixed(2)}）`);
});

test("遠く離れた規制は拾わない", (t) => {
  if (!hasData) return t.skip("配信データが未生成");
  const far = [[127.7, 26.2], [127.71, 26.21]];   // 沖縄
  assert.strictEqual(findOverlaps(restriction(far), roads).size, 0);
});

test("重なりの割合を返す", (t) => {
  if (!hasData) return t.skip("配信データが未生成");
  const target = roads[0];
  const found = findOverlaps(restriction(target.points), roads);
  const list = found.get(target.id);
  assert.ok(list && list.length === 1);
  assert.ok(list[0].ratio >= MIN_RATIO, "割合が下限を下回っている: " + list[0].ratio);
  assert.strictEqual(list[0].kind, "noMotorcycle", "規制の種類が落ちている");
});

test("形の無い規制・道は飛ばす", (t) => {
  if (!hasData) return t.skip("配信データが未生成");
  assert.strictEqual(findOverlaps(restriction([]), roads).size, 0);
  assert.strictEqual(findOverlaps(restriction(roads[0].points), [{ id: "x", points: [] }]).size, 0);
});
