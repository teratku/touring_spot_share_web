"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { decode6, MANEUVER, VARIANTS } = require("../lib/valhallaRoute");
const { decode } = require("../lib/polyline");

/**
 * Valhalla の応答をこのツールの形に直すところ。
 *
 * ⚠️ ネットワークは叩かない（Valhalla が居なくても落ちないこと）。
 *    実際に繋ぐ確認は test/valhallaLive.test.js にある。
 */

// MARK: ポリラインの精度

/**
 * ⚠️ **Valhalla は小数6桁、このツールと Google は5桁。**
 *    そのまま `lib/polyline.js` の decode に通すと**座標が10倍ずれる**。
 *    日本のどこを指しても海の上か、緯度の範囲外になる。
 */
//: 実際に Valhalla が返した線の1点目（東京駅前）。手で作らず、応答から取った
const TOKYO_ONE_POINT = "sox`cAwqrqiG";
const TOKYO_LAT = 35.681034;
const TOKYO_LNG = 139.765548;

test("6桁のポリラインを解ける", () => {
  const points = decode6(TOKYO_ONE_POINT);
  assert.strictEqual(points.length, 1, "1点のはず");
  const [lng, lat] = points[0];
  assert.ok(Math.abs(lat - TOKYO_LAT) < 1e-6, `緯度がずれている: ${lat}`);
  assert.ok(Math.abs(lng - TOKYO_LNG) < 1e-6, `経度がずれている: ${lng}`);
});

test("続きの点も正しく積み上がる", () => {
  // ⚠️ 1点だけだと、差分の積み上げ（前の点からの相対値）を間違えていても通ってしまう
  const two = decode6("sox`cAwqrqiG~@I");
  assert.strictEqual(two.length, 2, "2点のはず");
  const [lng1, lat1] = two[0];
  const [lng2, lat2] = two[1];
  assert.ok(Math.abs(lat1 - TOKYO_LAT) < 1e-6);
  // 2点目は1点目のすぐ近く（実際の道の刻み）
  const meters = Math.hypot((lat2 - lat1) * 110574, (lng2 - lng1) * 90527);
  assert.ok(meters > 1 && meters < 200,
            `2点目が ${Math.round(meters)}m 先。積み上げを間違えている`);
});

test("5桁の decode に通すと10倍ずれることを、はっきりさせておく", () => {
  // ⚠️ この確認は「間違ったやり方だとどうなるか」を残すためのもの。
  //    直したつもりで5桁の decode を使い回すと、無言でこうなる
  const wrong = decode(TOKYO_ONE_POINT);      // 5桁前提
  const right = decode6(TOKYO_ONE_POINT);
  assert.ok(Math.abs(wrong[0][1] - right[0][1]) > 100,
            "5桁と6桁で違いが出ていない。decode6 が要らないかもしれない");
});

/**
 * ⚠️ **南や西へ進む線が壊れていないこと。** 差分は符号つきで詰められており、
 *    末尾のビットが立っていたら負の値。ここを見落とすと、
 *    **北東へ進む線だけ正しく、南西へ進む線が飛ぶ**という気付きにくい壊れ方をする。
 *    材料は実際の応答（東京駅→新橋方面・南西へ進む8点）。
 */
test("南西へ進む線でも壊れない", () => {
  const points = decode6("sox`cAwqrqiG~@I|DhA`DdAdAxA`@fAZxAH`C");
  assert.strictEqual(points.length, 8, "8点のはず");
  const [lng0, lat0] = points[0];
  const [lngN, latN] = points[points.length - 1];
  assert.ok(latN < lat0, `南へ進んでいない（${lat0} → ${latN}）`);
  assert.ok(lngN < lng0, `西へ進んでいない（${lng0} → ${lngN}）`);
  // 実測: 緯度 -0.000279 / 経度 -0.000258
  assert.ok(Math.abs((latN - lat0) + 0.000279) < 1e-6,
            `緯度の動きが合わない: ${(latN - lat0).toFixed(6)}（-0.000279 のはず）`);
  assert.ok(Math.abs((lngN - lng0) + 0.000258) < 1e-6,
            `経度の動きが合わない: ${(lngN - lng0).toFixed(6)}（-0.000258 のはず）`);
});

test("点の並びは [経度, 緯度]（このツールの流儀）", () => {
  // ⚠️ Valhalla の応答は lat/lon の順。ここで入れ替えないと、
  //    地図に描いたときアフリカ沖に飛ぶ
  const points = decode6(TOKYO_ONE_POINT);
  const [lng, lat] = points[0];
  assert.ok(lng > 120 && lng < 154, `経度の位置に緯度が入っている: ${lng}`);
  assert.ok(lat > 24 && lat < 46, `緯度の位置に経度が入っている: ${lat}`);
});

// MARK: maneuver の写し方

/**
 * ⚠️ 実測（山梨・6経路）で出た13種類。ここが抜けると
 *    「直進」に落ちて、右折を案内しなくなる。
 */
test("実際に出てくる13種類がすべて写せる", () => {
  const seen = [15, 10, 9, 16, 2, 5, 19, 24, 23, 14, 18, 11, 20];
  const missing = seen.filter((t) => !MANEUVER[t]);
  assert.deepStrictEqual(missing, [],
    `写し先の無い maneuver がある: ${missing.join(",")}`);
});

test("Uターンを取り違えない", () => {
  // ⚠️ 一度ここで間違えた。type 9 は「やや右」で、Uターンは 12/13。
  //    取り違えると「Uターンが出ている」と誤検知して、無駄に引き直す
  assert.strictEqual(MANEUVER[12], "uturnRight");
  assert.strictEqual(MANEUVER[13], "uturnLeft");
  assert.strictEqual(MANEUVER[9], "turnSlightRight", "type 9 をUターン扱いにしている");
  assert.strictEqual(MANEUVER[16], "turnSlightLeft");
});

test("左右を取り違えない", () => {
  assert.strictEqual(MANEUVER[10], "turnRight");
  assert.strictEqual(MANEUVER[15], "turnLeft");
  assert.strictEqual(MANEUVER[11], "turnSharpRight");
  assert.strictEqual(MANEUVER[14], "turnSharpLeft");
});

// MARK: 案の作り分け

test("案は3通りで、最短だけ shortest が立つ", () => {
  assert.deepStrictEqual(Object.keys(VARIANTS), ["shortest", "normal", "fun"]);
  assert.strictEqual(VARIANTS.shortest.options.shortest, true);
  assert.ok(!VARIANTS.normal.options.shortest, "ふつうに shortest が立っている");
  assert.ok(!VARIANTS.fun.options.shortest, "楽しいに shortest が立っている");
});

test("楽しい案は幹線を避ける向きの値になっている", () => {
  // ⚠️ 実測では差は小さい（遠回り+7%）。遠回りを作るのは経由地の方。
  //    それでも向きが逆だと「楽しい」が最短寄りになる
  assert.ok(VARIANTS.fun.options.use_primary < VARIANTS.shortest.options.use_primary,
    `楽しい(${VARIANTS.fun.options.use_primary}) が `
    + `最短(${VARIANTS.shortest.options.use_primary}) より幹線寄りになっている`);
});
