"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 「別画面で開く」が作る URL の確認。
 *
 * ⚠️ Googleマップの URL（`maps/@?api=1&map_action=pano`）に戻さないこと。
 *    あれだと**下の地図が隅の小さなもの**になり、拡大した状態も倍率も
 *    URL で指定できない（実際に開いて確認済み）。だから自前の
 *    `streetview.html` を開いている。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const match = html.match(/function openStreetView\(seg\) \{[\s\S]*?\n\}/);

test("画面側に openStreetView がある", () => {
  assert.ok(match, "road-builder.html から openStreetView を取り出せない");
});

/**
 * ⚠️ **このテストは主張が変わっている。** 以前は「自前ページを開く」を確かめていたが、
 *    実物の URL（ユーザー提供）から、Googleマップでも**下の地図を開いた状態**を
 *    指定できることが分かった。決めているのは末尾の `!9m2!1b1!2iNN`。
 *    いまは Googleマップを開き、ストリートビューが無い地点だけ自前ページに落ちる。
 */
const urlMatch = html.match(/function googleStreetViewUrl\(panoId, latLng, heading, sizePercent\) \{[\s\S]*?\n\}/);

test("画面側に googleStreetViewUrl がある", () => {
  assert.ok(urlMatch, "road-builder.html から googleStreetViewUrl を取り出せない");
});

const googleStreetViewUrl = new Function(`${urlMatch[0]}; return googleStreetViewUrl;`)();
const latLng = { lat: () => 35.9432486, lng: () => 138.87642 };

test("実物と同じ形の URL を作る", () => {
  // ⚠️ 実際に開けた URL（ユーザー提供）と同じ骨組みであること。
  //    `!3m10` などは「続く要素の数」なので、要素を足し引きすると崩れる
  const url = googleStreetViewUrl("YwJF63pS3mTF1M7oCvMIWg", latLng, 82, 33);
  assert.ok(url.startsWith("https://www.google.com/maps/@35.9432486,138.8764200,3a,75y,82h,90t/data="),
            "先頭が違う: " + url.slice(0, 80));
  assert.ok(url.includes("!3m10!1e1!3m8!1sYwJF63pS3mTF1M7oCvMIWg!2e0!6s"), "骨組みが違う");
  assert.ok(url.includes("!7i13312!8i6656!9m2!1b1!2i33"), "末尾が違う");
});

test("下の地図を出す指定が必ず入る", () => {
  // ⚠️ `1b1` が無いと下の地図が出ない。ここが今回の目的
  for (const size of [33, 50, 66]) {
    const url = googleStreetViewUrl("PANO", latLng, 90, size);
    assert.ok(url.includes("!9m2!1b1!"), "下の地図を出す指定が無い");
    assert.ok(url.endsWith(`!2i${size}`), "大きさが渡っていない: " + url.slice(-20));
  }
});

test("パノラマIDを2か所とも差し替える", () => {
  // ⚠️ 画像の下見URL（6s）にも同じIDが入る。片方だけ替えると別の場所の絵が出る
  const url = googleStreetViewUrl("ABC123", latLng, 45, 50);
  assert.strictEqual((url.match(/ABC123/g) || []).length, 2, "IDが2か所に入っていない");
});

test("向きは方角の指定と画像の両方に入る", () => {
  const url = googleStreetViewUrl("PANO", latLng, 123, 50);
  assert.ok(url.includes(",123h,"), "パノラマの向きが入っていない");
  assert.ok(url.includes("yaw%3D123"), "画像の向きが入っていない");
});

