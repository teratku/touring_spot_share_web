"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { decode6, MANEUVER, VARIANTS, DISPLACEMENTS,
        ROAD_CLASS_TIERS, ROAD_CLASS_COLORS } = require("../lib/valhallaRoute");
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
  for (const costing of ["motor_scooter", "motorcycle"]) {
    assert.strictEqual(VARIANTS.shortest[costing].shortest, true,
      `${costing} の最短に shortest が立っていない`);
    assert.ok(!VARIANTS.normal[costing].shortest, `${costing} のふつうに shortest が立っている`);
    assert.ok(!VARIANTS.fun[costing].shortest, `${costing} の楽しいに shortest が立っている`);
  }
});

test("原付とバイクで設定を分けている", () => {
  // ⚠️ **同じ設定を渡していて、バイクの「楽しい」が高速道路を66.5km走っていた。**
  //    `use_primary` は motor_scooter 専用でバイクには効かない
  for (const v of Object.values(VARIANTS)) {
    assert.ok(v.motor_scooter, `${v.label} に motor_scooter の設定が無い`);
    assert.ok(v.motorcycle, `${v.label} に motorcycle の設定が無い`);
  }
});

test("楽しい案は幹線を避ける向きの値になっている（原付）", () => {
  // ⚠️ 実測では差は小さい（遠回り+7%）。遠回りを作るのは経由地の方。
  //    それでも向きが逆だと「楽しい」が最短寄りになる
  // ⚠️ **重みの置き場所は ROAD_CLASS_TIERS ひとつ。** 以前は VARIANTS にも
  //    同じ値があり、片方を消しても効いてしまう二重状態だった
  for (const disp of ["moped50", "small125", "default"]) {
    const fun = ROAD_CLASS_TIERS[disp].fun.use_primary;
    const short = ROAD_CLASS_TIERS[disp].shortest.use_primary;
    assert.ok(fun < short,
      `${disp}: 楽しい(${fun}) が 最短(${short}) より幹線寄りになっている`);
  }
  for (const [name, v] of Object.entries(VARIANTS)) {
    assert.ok(!("use_primary" in v.motor_scooter),
      `VARIANTS.${name} にも幹線の重みがある（二重になっている）`);
  }
});

test("バイクの楽しい案は高速を外す", () => {
  // ⚠️ **これが無いと高速道路を走る。** 実測（新座→愛川）:
  //      既定           77.8km うち高速66.5km 曲率57度
  //      use_highways 0 51.7km うち高速 0.0km 曲率128度
  assert.strictEqual(VARIANTS.fun.motorcycle.use_highways, 0,
    "バイクの楽しい案で高速を外していない");
});

test("ふつうは高速を外さない", () => {
  // ⚠️ アプリの avoidHighways の既定は false で、126cc以上は高速に乗れる。
  //    「ふつう＝いちばん速い道」を保つ。外すのは「楽しい」だけ
  assert.strictEqual(VARIANTS.normal.motorcycle.use_highways, undefined,
    "ふつうで高速を外している");
});

test("効かない設定を渡さない", () => {
  // ⚠️ 実測で経路を1mも変えなかったもの。残すと「効いているつもり」になる
  const NO_EFFECT = ["use_living_streets", "use_tracks", "use_trails",
                     "service_penalty", "maneuver_penalty", "use_tolls", "top_speed"];
  for (const [name, v] of Object.entries(VARIANTS)) {
    for (const key of NO_EFFECT) {
      assert.ok(!(key in v.motorcycle),
        `${name} のバイク設定に、効かない ${key} が入っている`);
    }
    // ⚠️ use_primary はバイクには効かない（motor_scooter 専用）
    assert.ok(!("use_primary" in v.motorcycle),
      `${name} のバイク設定に use_primary（原付専用）が入っている`);
  }
});

// MARK: 排気量と回避（アプリと同じ設定）

test("排気量で costing が決まる", () => {
  // ⚠️ **50cc に motorcycle を使うと高速に乗る経路が出る。**
  //    画面で costing を直接選ばせず、排気量から決める
  assert.strictEqual(DISPLACEMENTS.moped50.costing, "motor_scooter");
  assert.strictEqual(DISPLACEMENTS.small125.costing, "motor_scooter");
  assert.strictEqual(DISPLACEMENTS.medium250.costing, "motorcycle");
  assert.strictEqual(DISPLACEMENTS.large.costing, "motorcycle");
});

test("125cc以下は高速を通れない（法令）", () => {
  assert.strictEqual(DISPLACEMENTS.moped50.canUseExpressway, false);
  assert.strictEqual(DISPLACEMENTS.small125.canUseExpressway, false);
  assert.strictEqual(DISPLACEMENTS.medium250.canUseExpressway, true);
  assert.strictEqual(DISPLACEMENTS.large.canUseExpressway, true);
});

test("効かない排気量には top_speed を渡さない", () => {
  // ⚠️ **ここには以前「どの排気量にも top_speed を入れない」と書いてあった。**
  //    理由は「30を渡すと60km/hの一般道をほぼ全部避ける」だったが、
  //    5区間で測り直すと言い過ぎだった（`top_speed: 30` でも主要地方道を
  //    16〜30%使い、距離の増えかたは最大+7%）。**禁止ではなく傾きにすぎない。**
  //    いまは原付の走り方を表すために使っている（DISPLACEMENTS 参照）。
  //
  // ⚠️ **motorcycle には渡さない。** 8通り試して経路が1mも変わらなかったので、
  //    渡しても設定が増えるだけで紛らわしい
  for (const d of ["medium250", "large"]) {
    assert.ok(!DISPLACEMENTS[d].topSpeed,
      `${d} に topSpeed が入っている（motorcycle では効かない）`);
  }
});

// MARK: 道の種別（色分けの材料）

test("種別の鍵は3つだけ", () => {
  // ⚠️ 画面の KIND_COLORS と揃っていること
  const kinds = new Set(["expressway", "toll", "surface"]);
  assert.strictEqual(kinds.size, 3);
});

// MARK: 道路クラスごとの重み（GenNavi と同じ考え方）

test("3段階で幹線の使い方が変わる", () => {
  // ⚠️ スライドの表: 最短0.9使う / 推奨バランス / 裏道0.1避ける
  for (const disp of ["moped50", "small125", "default"]) {
    const t = ROAD_CLASS_TIERS[disp];
    const s = t.shortest.use_primary, n = t.normal.use_primary, f = t.fun.use_primary;
    assert.ok(s > n && n >= f,
      `${disp}: 段階になっていない（最短${s} / 推奨${n} / 裏道${f}）`);
  }
});

test("原付一種は生活道路寄り、原付二種は幹線寄り", () => {
  // ⚠️ **ここが今回の要**。以前は両方とも同じ値で、画面で選び分けても
  //    経路が1mも変わらなかった。
  //    実測（5区間・高速回避）で大きい道の割合:
  //      原付一種 56→18 / 76→55 / 66→58 / 71→58 / 23→21 %
  //      原付二種 56→88 / 76→76 / 66→79 / 71→79 / 23→53 %
  const moped = ROAD_CLASS_TIERS.moped50;
  const small = ROAD_CLASS_TIERS.small125;
  for (const v of ["shortest", "normal", "fun"]) {
    assert.ok(moped[v].use_primary < small[v].use_primary,
      `${v}: 原付一種(${moped[v].use_primary}) が `
      + `原付二種(${small[v].use_primary}) より幹線寄りになっている`);
  }
  assert.ok(moped.normal.use_primary <= 0.1,
    `原付一種の「ふつう」が幹線を避ける値になっていない: ${moped.normal.use_primary}`);
  assert.ok(small.normal.use_primary >= 0.8,
    `原付二種の「ふつう」が幹線を使う値になっていない: ${small.normal.use_primary}`);
});

test("排気量ごとの速度が法令と合っている", () => {
  // ⚠️ **`top_speed` は所要時間も決める。** 入れる前は原付一種 49km が80分
  //    （＝37km/h）で、法定30km/h では出せない数字だった
  assert.strictEqual(DISPLACEMENTS.moped50.topSpeed, 30, "原付一種は法定30km/h");
  assert.strictEqual(DISPLACEMENTS.small125.topSpeed, 60, "原付二種は法定60km/h");
  // ⚠️ **軽二輪・大型には入れない。** motorcycle costing では効かないことを実測済み
  //    （8通り試して経路が1mも変わらなかった）
  for (const d of ["medium250", "large"]) {
    assert.ok(!DISPLACEMENTS[d].topSpeed,
      `${d} に topSpeed がある（motorcycle では効かない）`);
  }
});

test("use_living_streets は入れない", () => {
  // ⚠️ 3区間で試して**経路が1mも変わらなかった**。
  //    Valhalla の living_street は日本にほとんど無く、residential とは別物
  for (const [disp, tiers] of Object.entries(ROAD_CLASS_TIERS)) {
    for (const [tier, o] of Object.entries(tiers)) {
      assert.ok(!("use_living_streets" in o),
        `${disp}.${tier} に use_living_streets が入っている（効かないことを実測済み）`);
    }
  }
});

test("クラスの色は Valhalla の road_class に揃える", () => {
  // ⚠️ 勝手な鍵を足すと、実際には来ない色が凡例に出る
  const known = ["motorway", "trunk", "primary", "secondary",
                 "tertiary", "unclassified", "residential", "service_other"];
  assert.deepStrictEqual(Object.keys(ROAD_CLASS_COLORS).sort(), known.slice().sort());
});
