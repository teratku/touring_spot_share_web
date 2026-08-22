"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { applyOverrides, overrideKey, normalizeAdded, isValidAdded,
        buildAddedSegment } = require("../lib/roadOverrides");
const { encode } = require("../lib/polyline");

/**
 * 手で足した道（生成データに無い道）を、おすすめに混ぜる処理。
 *
 * 【なぜ要るか】
 * 生成は OSM の道路データからしか作れない。名前が付いていない道・
 * OSM に無い道・区間の切り出しがどうしても合わない道は、いくら調整しても出せない。
 * そこを人が足せるようにする。
 *
 * ⚠️ **距離・曲率・点数を手入力させないこと。** 形から測り直す。
 *    手入力させると、実際の線と数字が食い違ったまま配信される。
 * ⚠️ 足りない情報のまま保存させないこと。生成のときに黙って落ちて
 *    「保存したのに配信に出ない」ことになる。
 */

/** くねくねした道を作る（曲率が出るように振らせる） */
function winding(lat, lng, count, amp = 0.002) {
  return [...Array(count)].map((_, i) =>
    [lng + Math.sin(i / 2) * amp, lat + i * 0.001]);
}

/** 生成データと同じ形の区間 */
function segment(name, points, score = 60) {
  const first = points[0], last = points[points.length - 1];
  return {
    name, ref: "", highway: "secondary", lengthKm: 5, curviness: 400, flow: 25,
    turnCount: 50, score, baseScore: score, polyline: encode(points),
    pointCount: points.length,
    start: [first[1], first[0]], end: [last[1], last[0]], tags: [],
  };
}

const shape = encode(winding(36.0, 139.0, 40));

test("名前と形があれば1本の区間になる", () => {
  const seg = buildAddedSegment({ name: "秘密の峠", shape });
  assert.ok(seg, "組み立てられていない");
  assert.strictEqual(seg.name, "秘密の峠");
  assert.strictEqual(seg.added, true, "手で足した印が付いていない");
  assert.ok(seg.polyline, "線が入っていない");
});

test("距離・曲率・点数は形から測り直す", () => {
  // ⚠️ **手入力の値を信じないこと。** 嘘の数字が配信される
  const seg = buildAddedSegment({
    name: "秘密の峠", shape,
    lengthKm: 999, curviness: 9999, score: 100,   // でたらめを渡す
  });
  assert.ok(seg.lengthKm > 0 && seg.lengthKm < 100, `距離が測り直されていない（${seg.lengthKm}）`);
  assert.ok(seg.curviness > 0 && seg.curviness < 9999, `曲率が測り直されていない（${seg.curviness}）`);
  assert.ok(seg.score > 0 && seg.score <= 100, `点数が測り直されていない（${seg.score}）`);
  assert.notStrictEqual(seg.lengthKm, 999);
  assert.notStrictEqual(seg.score, 100);
});

test("名前か形が無ければ足さない", () => {
  // ⚠️ 中途半端なものを通すと、生成のときに黙って落ちて原因が分からなくなる
  for (const raw of [{ shape }, { name: "名前だけ" }, {}, { name: "短すぎ", shape: encode([[139, 36]]) }]) {
    assert.strictEqual(isValidAdded(raw), false, "足せない指定を通している: " + JSON.stringify(Object.keys(raw)));
    assert.strictEqual(buildAddedSegment(raw), null, "組み立ててしまっている");
  }
  assert.strictEqual(isValidAdded({ name: "ちゃんとした道", shape }), true);
});

test("種別で点数が変わる", () => {
  // ⚠️ 生成と同じ式で点数を出していることの確認。ここが効いていないなら
  //    `funSegments.score` を通っていない
  const a = buildAddedSegment({ name: "道", shape, highway: "primary" });
  const b = buildAddedSegment({ name: "道", shape, highway: "tertiary" });
  assert.notStrictEqual(a.score, b.score, `種別を見ていない（どちらも${a.score}点）`);
});

test("種別を指定しなければ secondary になる", () => {
  assert.strictEqual(normalizeAdded({ name: "道", shape }).highway, "secondary");
});

// MARK: おすすめ一覧への混ざり方

test("生成した道と一緒に並ぶ", () => {
  const generated = [segment("既存の道", winding(35.0, 138.0, 30), 70)];
  const added = { "秘密の峠@36.00,139.00": { name: "秘密の峠", shape } };
  const r = applyOverrides(generated, {}, added);

  assert.strictEqual(r.segments.length, 2, "足した道が混ざっていない");
  assert.ok(r.segments.some((s) => s.name === "秘密の峠"), "足した道が見つからない");
  assert.deepStrictEqual(r.added, ["秘密の峠@36.00,139.00"]);
});

test("点数の順に並び直される", () => {
  // ⚠️ 足した道を末尾に置いたままにしないこと。生成した道と同じ物差しで並べる
  const generated = [segment("低い道", winding(35.0, 138.0, 30), 10)];
  const added = { "高い道@36.00,139.00": { name: "高い道", shape, boost: 100 } };
  const r = applyOverrides(generated, {}, added);
  assert.strictEqual(r.segments[0].name, "高い道",
                     "点数が高いのに先頭に来ていない: " + r.segments.map((s) => `${s.name}(${s.score})`).join(" / "));
});

test("加算は測り直した点数に足す", () => {
  const base = buildAddedSegment({ name: "道", shape });
  const boosted = buildAddedSegment({ name: "道", shape, boost: 20 });
  assert.strictEqual(boosted.score, Number(Math.min(100, base.score + 20).toFixed(1)),
                     `加算が効いていない（${base.score} → ${boosted.score}）`);
  assert.strictEqual(boosted.baseScore, base.score, "加算前の点数が残っていない");
});

test("生成側に同じ道があるなら足さない", () => {
  // ⚠️ 二重に出さない。名前の無かった道に名前を付けて足したあと、
  //    OSM 側にも名前が入った、という順で起きる
  const points = winding(36.0, 139.0, 40);
  const generated = [segment("秘密の峠", points, 70)];
  const key = overrideKey(generated[0]);
  const r = applyOverrides(generated, {}, { [key]: { name: "秘密の峠", shape: encode(points) } });

  assert.strictEqual(r.segments.length, 1, "同じ道が二重に出ている");
  assert.deepStrictEqual(r.added, [], "足したことになっている");
  assert.deepStrictEqual(r.addSkipped, [key], "飛ばした理由が残っていない");
});

test("壊れた線は飛ばして、飛ばしたことを残す", () => {
  // ⚠️ 黙って捨てると「保存したのに出てこない」になる。
  // ⚠️ "@@@" は**2点に復号できてしまう**（0m・緯度経度ほぼ0＝アフリカ沖）。
  //    点数だけ見ていると通ってしまい、配信の検証でその県まるごと止まる
  const r = applyOverrides([], {}, { "壊れ@36.00,139.00": { name: "壊れ", shape: "@@@" } });
  assert.strictEqual(r.segments.length, 0, "0mの線を足している");
  assert.deepStrictEqual(r.addSkipped, ["壊れ@36.00,139.00"], "飛ばした記録が無い");
});

test("短すぎる線は足さない", () => {
  // ⚠️ 配信の検証は「長さ0より大きい」しか見ない。数十mの線が
  //    おすすめとして出ると、押しても何も起きない道になる
  const tiny = encode([[139.0, 36.0], [139.0, 36.0005]]);   // 約55m
  assert.strictEqual(isValidAdded({ name: "短い道", shape: tiny }), false,
                     "55mの線を足せることになっている");
});

test("日本の外は足さない", () => {
  // ⚠️ 緯度経度の取り違えがここに出る。止めないと配信でその県まるごと落ちる
  //    （`importRoadRecommend.js` が始点の範囲を見ている）
  const abroad = encode(winding(48.0, 2.0, 40));            // パリのあたり
  assert.strictEqual(isValidAdded({ name: "国外の道", shape: abroad }), false,
                     "日本の外の道を足せることになっている");
  // 入れ替えた座標（経度139・緯度36 のつもりで逆に入れた）
  const swapped = encode(winding(139.0, 36.0, 40));
  assert.strictEqual(isValidAdded({ name: "逆", shape: swapped }), false,
                     "緯度経度が逆のまま通っている");
});

test("足した道が無くても、これまでどおり動く", () => {
  const generated = [segment("既存の道", winding(35.0, 138.0, 30), 70)];
  for (const added of [undefined, {}, null]) {
    const r = applyOverrides(generated, {}, added);
    assert.strictEqual(r.segments.length, 1);
    assert.deepStrictEqual(r.added, []);
  }
});
