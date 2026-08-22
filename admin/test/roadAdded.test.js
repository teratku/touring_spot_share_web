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

// MARK: ツールの表示と、配信される値が一致すること

/**
 * ⚠️ 実機で「形を直したのに距離が変わらない」と報告された。画面は元データの
 *    `lengthKm` を出しており、生成側だけが測り直していた。
 *    直したいま、画面は `/api/roads/measure`（`reshape`）の値を出す。
 *    **そこが生成側（`applyOverrides`）と一致していないと、
 *    「ツールでは4.9km、配信は3.1km」という食い違いが起きる。**
 */
test("画面は元データの距離を出さない", () => {
  // ⚠️ **これが報告された不具合そのもの。** 一覧が `seg.lengthKm`（元データ）を
  //    出していたので、形を切り詰めても距離が変わらなかった。
  //    いまは `metricsOf`（サーバで測り直した値）を通す。
  // ⚠️ 値の比較では捕まえられない（画面もサーバも同じ `reshape` を呼ぶので、
  //    式を変えると両方いっしょに変わる）。**どちらを読んでいるか**を見る。
  const fs = require("fs");
  const path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");

  const rows = html.match(/rows\.innerHTML[\s\S]*?div\.innerHTML =[\s\S]*?`;/);
  assert.ok(rows, "一覧の行を組み立てている場所を取り出せない");
  assert.ok(!/seg\.lengthKm/.test(rows[0]),
            "一覧が元データの距離を出している（手直ししても変わらない）: "
            + (rows[0].match(/.*lengthKm.*/) || [""])[0].trim());
  assert.ok(/metricsOf\(/.test(rows[0]), "一覧が測り直した値を通っていない");
});

test("編集欄も測り直した値を出す", () => {
  // ⚠️ 一覧だけ直しても、編集欄が元データのままだと結局「変わらない」と見える
  const fs = require("fs");
  const path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
  // 編集欄の数値ブロック（`class="stats"` から次の閉じタグまで）
  const stats = html.match(/<div class="stats">[\s\S]{0,700}?<\/div>/);
  assert.ok(stats, "編集欄の数値ブロックを取り出せない");
  assert.ok(/metricsOf/.test(stats[0]),
            "編集欄が測り直した値を通っていない: " + stats[0].slice(0, 120).replace(/\s+/g, " "));
  // 元データを直接読んでいないこと（`seg.lengthKm` のような形）
  assert.ok(!/seg\.lengthKm|seg\.curviness|seg\.score/.test(stats[0]),
            "編集欄が元データの値を出している: "
            + (stats[0].match(/.*seg\.(lengthKm|curviness|score).*/) || [""])[0].trim());
});

test("加算は測り直した点数に足す（画面と配信で順序を揃える）", () => {
  // ⚠️ 「形を直してから加算」の順。逆にすると、切り詰めて下がったぶんまで加算が食われる
  const { reshape } = require("../lib/roadOverrides");
  const points = winding(35.5, 138.9, 50);
  const generated = [segment("試す道", points, 60)];
  const newShape = encode(points.slice(0, 25));
  const o = { shape: newShape, boost: 10 };

  const shown = reshape({ name: "x", highway: generated[0].highway }, newShape);
  const published = applyOverrides(generated, { [overrideKey(generated[0])]: o }).segments[0];
  assert.strictEqual(published.score,
                     Number(Math.min(100, shown.score + 10).toFixed(1)),
                     `加算の当て方が違う（測り直し${shown.score} + 10 → ${published.score}）`);
});

test("非表示にした道は配信に出ない", () => {
  // ⚠️ 生成した道の `hidden` と揃えること。足した道だけ効かないと、
  //    画面で非表示にしたのに配信に出続ける（実際にそうなっていた）
  const r = applyOverrides([], {}, { "道@36.00,139.00": { name: "道", shape, hidden: true } });
  assert.strictEqual(r.segments.length, 0, "非表示にしたのに出ている");
  assert.deepStrictEqual(r.addSkipped, ["道@36.00,139.00"], "飛ばした記録が無い");
  // 非表示を外せば出る
  assert.strictEqual(
    applyOverrides([], {}, { "道@36.00,139.00": { name: "道", shape } }).segments.length, 1);
});

test("足した道にも表示名・ひとこと・札が乗る", () => {
  const seg = buildAddedSegment({ name: "道", shape, title: "別名", note: "ひとこと", tags: ["絶景"] });
  assert.strictEqual(seg.title, "別名");
  assert.strictEqual(seg.note, "ひとこと");
  assert.deepStrictEqual(seg.tags, ["絶景"]);
});
