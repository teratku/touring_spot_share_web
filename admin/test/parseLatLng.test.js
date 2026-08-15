"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 通行規制で「座標で探す」に貼った文字から緯度経度を読む処理。
 *
 * ⚠️ 読み違えても**エラーにはならず、別の場所の道を出す**だけなので気付きにくい。
 *    特に緯度と経度の取り違えは、地球の裏側を指したまま「道が無い」としか見えない。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const match = html.match(/function parseLatLng\(text\) \{[\s\S]*?\n\}/);

test("画面側に parseLatLng がある", () => {
  assert.ok(match, "road-builder.html から parseLatLng を取り出せない");
});

const parseLatLng = new Function(`${match[0]}; return parseLatLng;`)();
const near = (got, lat, lng) => {
  assert.ok(got, "読み取れていない");
  assert.ok(Math.abs(got.lat - lat) < 1e-6 && Math.abs(got.lng - lng) < 1e-6,
            `${JSON.stringify(got)} が ${lat},${lng} と違う`);
};

test("Googleマップの「座標をコピー」をそのまま貼れる", () => {
  near(parseLatLng("35.541343, 138.873705"), 35.541343, 138.873705);
});

test("区切りが違っても読む", () => {
  for (const text of ["35.541343,138.873705", "35.541343 138.873705",
                      "35.541343，138.873705", "  35.541343 ,  138.873705  "]) {
    near(parseLatLng(text), 35.541343, 138.873705);
  }
});

test("GoogleマップのURLから拾う", () => {
  // ⚠️ URL には座標以外の数字（ズーム 17z など）も入る。先頭2つを拾うと壊れる
  near(parseLatLng("https://www.google.com/maps/@35.6812,139.7671,17z"), 35.6812, 139.7671);
  near(parseLatLng("https://maps.google.com/?q=35.6812,139.7671"), 35.6812, 139.7671);
  near(parseLatLng("https://www.google.com/maps/place/x/@35.1,139.1,17z/data=!3d35.6812!4d139.7671"),
       35.6812, 139.7671);
});

test("緯度と経度が逆でも直す", () => {
  // ⚠️ よくある貼り間違い。日本の緯度20〜46と経度122〜154は重ならないので直せる
  near(parseLatLng("138.873705, 35.541343"), 35.541343, 138.873705);
});

test("方角の文字が付いていても読む", () => {
  near(parseLatLng("35.5N, 139.5E"), 35.5, 139.5);
});

test("読めないものは null", () => {
  for (const text of ["", "ただの文字", null, undefined, "abc, def"]) {
    assert.strictEqual(parseLatLng(text), null, JSON.stringify(text) + " を読めたことにしている");
  }
});

test("数字が1つしかなければ読まない", () => {
  // ⚠️ 片方だけで通すと、もう片方が undefined のまま探しにいく。
  //    途中まで入力しただけで勝手に走り出さないためでもある
  for (const text of ["35.5", "35.541343,", "  139.4869  "]) {
    assert.strictEqual(parseLatLng(text), null, JSON.stringify(text) + " を読めたことにしている");
  }
});

test("地球の外は受け付けない", () => {
  // ⚠️ 入れ替えても収まらない値は捨てる。黙って通すと変な場所を探しにいく
  assert.strictEqual(parseLatLng("999, 999"), null);
  assert.strictEqual(parseLatLng("100, 200"), null);
});

test("南半球・西経も読める（値を勝手に丸めない）", () => {
  near(parseLatLng("-33.8688, 151.2093"), -33.8688, 151.2093);   // シドニー
});
