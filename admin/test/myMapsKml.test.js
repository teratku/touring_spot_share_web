"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { midFrom, kmlUrl, parseKml, parseCoordinates } = require("../lib/myMapsKml");

/**
 * Google マイマップ（県警などが規制区間を公開している）からの取り込み。
 *
 * ⚠️ 材料は**実際に取得した KML**（国道238号 二輪車通行規制区間）。
 *    作った XML で試すと、CDATA・全角・経度が先、といった実物の癖を取りこぼす。
 */
const kml = fs.readFileSync(path.join(__dirname, "fixtures-mymap.kml"), "utf8");

test("URL から mid を取り出す", () => {
  assert.strictEqual(
    midFrom("https://www.google.com/maps/d/u/0/viewer?mid=1XTnTE_3wQeMMFrb4os_4YmAVlls-Kk8&ll=44.2,143.4&z=19"),
    "1XTnTE_3wQeMMFrb4os_4YmAVlls-Kk8");
  assert.strictEqual(midFrom("https://www.google.com/maps/d/edit?mid=ABC-123_x&usp=sharing"), "ABC-123_x");
});

test("mid をそのまま渡してもよい", () => {
  assert.strictEqual(midFrom("1XTnTE_3wQeMMFrb4os_4YmAVlls-Kk8"), "1XTnTE_3wQeMMFrb4os_4YmAVlls-Kk8");
});

test("読めないものは null", () => {
  for (const t of ["", null, undefined, "https://example.com/", "短い"]) {
    assert.strictEqual(midFrom(t), null, JSON.stringify(t));
  }
});

test("KMLのURLには forcekml を付ける", () => {
  // ⚠️ 付けないと KMZ（zip）で返り、そのままでは読めない
  assert.ok(kmlUrl("ABC").includes("forcekml=1"), kmlUrl("ABC"));
});

test("地図の名前と説明を取り出す", () => {
  const r = parseKml(kml);
  assert.ok(r.title.includes("国道238号"), r.title);
  // 規制の中身は説明文にしか書かれていない。取りこぼすと種別を誤る
  assert.ok(r.description.includes("原付一種"), r.description.slice(0, 60));
});

test("両端の地点を取り出す", () => {
  const r = parseKml(kml);
  assert.strictEqual(r.places.length, 2, "地点が2つでない");
  assert.ok(Math.abs(r.places[0].lat - 44.2469217) < 1e-6, JSON.stringify(r.places[0]));
  assert.ok(Math.abs(r.places[0].lng - 143.4936039) < 1e-6, JSON.stringify(r.places[0]));
  assert.ok(Math.abs(r.places[1].lat - 44.2911710) < 1e-6, JSON.stringify(r.places[1]));
});

test("区間の線も取り出す", () => {
  const r = parseKml(kml);
  assert.strictEqual(r.lines.length, 1);
  assert.strictEqual(r.lines[0].lengthPoints, 220, "点の数が違う");
});

test("KMLは経度が先", () => {
  // ⚠️ 緯度と取り違えると地球の裏側になる。ここを間違えても
  //    エラーにはならず、遠くの地図が開くだけなので気付きにくい
  const points = parseCoordinates("143.4936,44.24692,0 143.4930,44.2470,0");
  assert.deepStrictEqual(points[0], [143.4936, 44.24692]);
});

test("壊れた座標は飛ばす", () => {
  const points = parseCoordinates("143.49,44.24,0 こわれた 143.50,44.25,0");
  assert.strictEqual(points.length, 2);
});

test("地点も線も無いKMLでも落ちない", () => {
  const r = parseKml('<kml><Document><name>から</name></Document></kml>');
  assert.deepStrictEqual(r.places, []);
  assert.deepStrictEqual(r.lines, []);
});
