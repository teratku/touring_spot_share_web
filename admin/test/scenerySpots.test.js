"use strict";
const test = require("node:test");
const assert = require("node:assert");

const {
  buildIndex, countNearbySpots, sceneryBonus,
  SPOT_RADIUS_METERS, MAX_BONUS,
} = require("../lib/scenerySpots");

// 群馬あたりを基準にする
const LAT0 = 36.4;
const LNG0 = 139.2;
const M_PER_LAT = 111320;
const M_PER_LNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);

/** 基準点から東へ dxM、北へ dyM ずらした [lon, lat] */
function at(dxM, dyM) {
  return [LNG0 + dxM / M_PER_LNG, LAT0 + dyM / M_PER_LAT];
}

/** 東へ lengthM 伸びる直線の区間 */
function line(lengthM, step = 200) {
  const pts = [];
  for (let d = 0; d <= lengthM; d += step) pts.push(at(d, 0));
  return pts;
}

test("加点は0件で0、増えるほど増え、上限で頭打ちになる", () => {
  assert.strictEqual(sceneryBonus(0), 0, "スポットが無ければ加点なし");
  assert.strictEqual(sceneryBonus(-1), 0);
  assert.ok(sceneryBonus(1) > 0);
  assert.ok(sceneryBonus(5) > sceneryBonus(1), "多いほど高い");
  assert.ok(sceneryBonus(100) <= MAX_BONUS + 1e-9, "上限を超えない");
});

test("加点は減点にならない（データが疎なので0件を罰しない）", () => {
  // ここが崩れると「まだ誰も投稿していない良い道」が不当に沈む
  for (const n of [0, 1, 3, 10, 50]) {
    assert.ok(sceneryBonus(n) >= 0, `スポット${n}件で負の加点になってはいけない`);
  }
});

test("半径内のスポットだけを数える", () => {
  const inside = at(500, 0);
  const outside = at(500, SPOT_RADIUS_METERS + 2000);
  const index = buildIndex([inside, outside]);
  assert.strictEqual(countNearbySpots(line(1000), index), 1,
    "半径の外にあるスポットは数えない");
});

test("同じスポットを二重に数えない（長い区間が有利にならない）", () => {
  // 長い直線の真ん中に1件だけ置く。サンプル点は何個も近くを通る
  const spot = at(5000, 100);
  const index = buildIndex([spot]);
  const count = countNearbySpots(line(10000), index);
  assert.strictEqual(count, 1, "サンプル点の数だけ重複して数えてはいけない");
});

test("端点だけでなく区間の途中も見る", () => {
  // 20km の区間の真ん中にだけスポットを置く。
  // 始点・終点しか見ていないと 0 件になってしまう
  const middle = at(10000, 200);
  const index = buildIndex([middle]);
  assert.strictEqual(countNearbySpots(line(20000), index), 1,
    "区間の中ほどにあるスポットを拾えること");
});

test("スポットが無ければ何も壊れない", () => {
  const index = buildIndex([]);
  assert.strictEqual(countNearbySpots(line(1000), index), 0);
  assert.strictEqual(countNearbySpots(null, index), 0);
  assert.strictEqual(countNearbySpots([at(0, 0)], index), 0, "点が1つでは区間にならない");
});

test("実測に近い値で効き方が狙いどおりになる", () => {
  // 群馬の実測: 志賀草津道路11件 / 万座道路9件 / 国道254号0件
  const shiga = sceneryBonus(11);
  const manza = sceneryBonus(9);
  const r254 = sceneryBonus(0);

  assert.ok(shiga >= manza, "スポットが多い方が高い");
  assert.strictEqual(r254, 0, "スポット0件は素点のまま");

  // 曲率中位の絶景ロード（素点75）が、曲率1位で眺望なしの道（素点84）に並ぶこと。
  // ここが狙いそのもの
  assert.ok(75 + shiga >= 84, `志賀草津 75+${shiga.toFixed(1)} が 国道254号 84 に届くこと`);
  // ただし追い抜きすぎない（曲率が無意味になっては困る）
  assert.ok(75 + shiga <= 84 + 6, "絶景でも曲率を完全に無効化しない");
});
