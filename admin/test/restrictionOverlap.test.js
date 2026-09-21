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

// MARK: - 長い経路でも速く、答えは変えないこと

/**
 * ⚠️ **実機で報告（2026-09-21）**:「50ccの設定でルート生成をするとタイムアウトする」。
 *    新座→霧島市（1,509km）で、規制の照合だけに **67秒**かかっていた
 *    （アプリの制限は60秒）。規制1件ごとに経路の全点を総当たりしていたため。
 *    囲み箱と格子で弾くようにして **3.1秒**になった。
 *
 * ⚠️ **速くするときに答えを変えないこと**が肝。ここでは総当たりと突き合わせる。
 */
test("格子で測っても総当たりと同じ答えになる", () => {
  const { overlapRatio, distanceToLine, resample, NEAR_METERS } = require("../lib/restrictionOverlap");

  // ⚠️ **粗い線で確かめること。** 点の間隔が格子（約2km）より広い区間があると、
  //    格子に入れた「点」だけでは真ん中を取りこぼす。実際に起きうる形で見る
  const 粗い経路 = [];
  for (let i = 0; i < 2_500; i++) 粗い経路.push([139.0 + i * 0.05, 35.0]);
  const 区間m = 0.05 * 111_320 * Math.cos((35 * Math.PI) / 180);
  assert.ok(区間m > 4_000,
    `材料が悪い: 区間が ${Math.round(区間m)}m しかなく、格子の穴を突けない`);
  assert.ok(粗い経路.length > 2_000,
    "材料が悪い: 格子を使う閾値(2,000点)を超えていない");

  // 区間のちょうど真ん中を通る規制線（格子の穴に落ちやすい位置）
  const 規制 = [];
  for (let k = 0; k < 40; k++) 規制.push([139.0 + 0.025, 35.0 + k * 0.00002]);

  // 総当たりで出した正解
  const 点 = resample(規制);
  let 当たり = 0;
  for (const p of 点) if (distanceToLine(p, 粗い経路) <= NEAR_METERS) 当たり++;
  const 正解 = 当たり / 点.length;
  assert.ok(正解 > 0, "材料が悪い: 総当たりでも重なっていない");

  assert.strictEqual(overlapRatio(規制, 粗い経路), 正解,
    "格子で測ると総当たりと答えが違う（粗い区間の真ん中を取りこぼしている）");
});

test("長い経路でも規制の照合が待たされない", () => {
  const { hitsOnRoute } = require("../lib/restrictionAvoid");

  // 1,500km ぶんの細かい経路（実測は41,755点）と、離れた場所の規制200件
  const 経路 = [];
  for (let i = 0; i < 40_000; i++) 経路.push([139.0 - i * 0.0002, 35.0 - i * 0.0001]);
  const 規制 = [];
  for (let k = 0; k < 200; k++) {
    const pts = [];
    for (let j = 0; j < 30; j++) pts.push([130.0 + k * 0.01, 31.0 + j * 0.0002]);
    規制.push({ id: `far-${k}`, name: `遠い道${k}`, kind: "noMotorcycle", points: pts });
  }
  const t0 = Date.now();
  const hits = hitsOnRoute(経路, 規制);
  const 秒 = (Date.now() - t0) / 1000;
  assert.strictEqual(hits.length, 0, "離れた規制を拾っている");
  // ⚠️ **アプリの制限は60秒。** 引き直しが最大3回あるので、1回は十分速いこと
  assert.ok(秒 < 10, `規制の照合に ${秒.toFixed(1)}秒かかっている（総当たりに戻っている）`);
});

test("セルの境目をまたいでも取りこぼさない", () => {
  const { overlapRatio, distanceToLine, resample, NEAR_METERS } =
    require("../lib/restrictionOverlap");

  // ⚠️ **格子の境目に置くこと。** 真ん中に置くと、隣のセルを見ていなくても
  //    当たってしまい検査にならない（変異で素通りした）。
  //    0.02度の倍数がセルの境目（`CELL_DEG`）
  const 境目 = 139.02;
  const 経路 = [];
  for (let i = 0; i < 2_500; i++) 経路.push([境目 + 0.0000001, 35.0 + i * 0.00002]);
  assert.ok(経路.length > 2_000, "材料が悪い: 格子を使う閾値を超えていない");

  // ⚠️ **25m 前後で確かめること。** セルを小さくしすぎると 3x3 が
  //    `NEAR_METERS`(25m) を覆えなくなる。その壊れ方も捕まえたい
  const 度 = (m) => m / (111_320 * Math.cos((35 * Math.PI) / 180));
  // ⚠️ **緯度の境目も確かめること。** 経度だけだと、隣のセルを見る処理の
  //    片方の軸（dy）を潰しても素通りする（変異で確かめた）
  const 緯度境目 = 35.02;
  const 横の経路 = [];
  for (let i = 0; i < 2_500; i++) 横の経路.push([139.0 + i * 0.00002, 緯度境目 + 0.0000001]);
  {
    const 規制 = [];
    for (let k = 0; k < 40; k++) {
      規制.push([139.0 + k * 0.00002, 緯度境目 - 0.0000001 - 10 / 111_320]);
    }
    const 点 = resample(規制);
    let 当たり = 0;
    for (const p of 点) if (distanceToLine(p, 横の経路) <= NEAR_METERS) 当たり++;
    const 正解 = 当たり / 点.length;
    assert.ok(正解 > 0, "材料が悪い: 緯度の境目で総当たりでも当たらない");
    assert.strictEqual(overlapRatio(規制, 横の経路), 正解,
      "緯度の境目をまたぐ規制を取りこぼしている");
  }

  for (const 離れ of [0.02, 10, 24]) {
    const 規制 = [];
    for (let k = 0; k < 40; k++) {
      // 境目の**反対側**に置く（別のセルに入る）
      規制.push([境目 - 0.0000001 - 度(離れ), 35.0 + k * 0.00002]);
    }
    const 点 = resample(規制);
    let 当たり = 0;
    for (const p of 点) if (distanceToLine(p, 経路) <= NEAR_METERS) 当たり++;
    const 正解 = 当たり / 点.length;
    assert.ok(正解 > 0, `材料が悪い: ${離れ}m 離れても総当たりで当たらない`);
    assert.strictEqual(overlapRatio(規制, 経路), 正解,
      `${離れ}m 離れた規制を取りこぼしている（セルの境目・隣のセルを見ているか）`);
  }
});
