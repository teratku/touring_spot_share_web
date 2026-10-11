"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cellKeysInBounds, parseCellKey, cellWays, MAX_CELLS } = require("../lib/osmGridLayer");
const { TARGET_HIGHWAYS } = require("../lib/roadsAtPoint");
const { decode } = require("../lib/polyline");

/**
 * /roads の「OSMの道」（利用者の要望 2026-10-11: 道を足す・直すときに、線がどこを通るか確かめたい）。
 * ⚠️ 線を引く経路探索と同じ道だけ・見えているマスだけ
 */
function tempGrid(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-grid-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
const HEAD = "﻿osm_id,name,highway,ref,geometry\n";

test("見えている範囲に掛かるマスのうち、ファイルがあるものだけを返す", () => {
  // 東京駅のあたり（1256_3197）と隣（1256_3198）。1257_3197 は海のつもりでファイルを置かない
  const dir = tempGrid({ "roads_grid_1256_3197.csv": HEAD, "roads_grid_1256_3198.csv": HEAD });
  const r = cellKeysInBounds({ s: 35.65, w: 139.75, n: 35.72, e: 139.85 }, { gridDir: dir });
  assert.deepStrictEqual(r, { tooMany: false, cells: ["1256_3197", "1256_3198"] });
  // ⚠️ マスの境目ちょうど（139.1）は 1391 側。0.1 で割ると 1390 になり、隣のマスを読む
  const edge = tempGrid({ "roads_grid_1260_3191.csv": HEAD });
  assert.deepStrictEqual(cellKeysInBounds({ s: 36.0, w: 139.1, n: 36.05, e: 139.1 }, { gridDir: edge }).cells,
                         ["1260_3191"], "境目ちょうどで隣のマスを見た");
});

test("広すぎる範囲はマスを読まずに断り、おかしな範囲はエラー", () => {
  const dir = tempGrid({});
  const wide = cellKeysInBounds({ s: 35.0, w: 139.0, n: 35.5, e: 139.5 }, { gridDir: dir }); // 5×5 = 25マス
  assert.strictEqual(wide.tooMany, true, "広すぎるのに読みに行った");
  assert.strictEqual(MAX_CELLS, 24);
  const fits = cellKeysInBounds({ s: 35.0, w: 139.0, n: 35.39, e: 139.59 }, { gridDir: dir }); // 4×6 = 24マス
  assert.strictEqual(fits.tooMany, false, "上限ちょうどを断った");
  assert.ok(cellKeysInBounds({ s: 36, w: 139, n: 35, e: 140 }).error, "南北が逆なのに通した");
  assert.ok(cellKeysInBounds({ s: NaN, w: 139, n: 36, e: 140 }).error);
});

test("マスの名前は数字だけ通す（ファイル名に使う）", () => {
  assert.deepStrictEqual(parseCellKey("1256_3197"), { a: 1256, b: 3197 });
  assert.strictEqual(parseCellKey("../1256_3197"), null);
  assert.strictEqual(parseCellKey("1256_3197.csv"), null);
  assert.strictEqual(parseCellKey(""), null);
});

test("経路探索と同じ道だけを返す（ランプ・名前の無い道は落とさず、歩道や私道は入れない）", async () => {
  const dir = tempGrid({
    "roads_grid_1256_3197.csv": HEAD
      + `1,国道1号,primary,1,"LINESTRING (139.70 35.60, 139.71 35.61)"\n`
      + `2,,residential,,"LINESTRING (139.72 35.60, 139.72 35.62)"\n`
      + `3,,primary_link,,"LINESTRING (139.73 35.60, 139.74 35.60)"\n`
      + `4,遊歩道,footway,,"LINESTRING (139.75 35.60, 139.76 35.60)"\n`
      + `5,,service,,"LINESTRING (139.77 35.60, 139.78 35.60)"\n`
      + `6,壊れた線,primary,,"LINESTRING ()"\n`,
  });
  const ways = await cellWays("1256_3197", { gridDir: dir });
  assert.deepStrictEqual(ways.map((w) => w.i), ["1", "2", "3"], "経路探索と違う道を返した");
  assert.ok(["primary", "residential", "primary_link"].every((h) => TARGET_HIGHWAYS.has(h)));
  assert.ok(!TARGET_HIGHWAYS.has("footway") && !TARGET_HIGHWAYS.has("service"));
  assert.deepStrictEqual({ n: ways[0].n, h: ways[0].h, r: ways[0].r }, { n: "国道1号", h: "primary", r: "1" });
  assert.deepStrictEqual(decode(ways[1].p), [[139.72, 35.6], [139.72, 35.62]], "線の形が変わった");
  assert.strictEqual(await cellWays("1256_3198", { gridDir: dir }), null, "無いマスを空の道として返した");
});

test("CSV を作り直したら、覚えていたマスを読み直す", async () => {
  const dir = tempGrid({ "roads_grid_1256_3197.csv": HEAD + `1,A,primary,,"LINESTRING (139.70 35.60, 139.71 35.61)"\n` });
  assert.strictEqual((await cellWays("1256_3197", { gridDir: dir })).length, 1);
  const file = path.join(dir, "roads_grid_1256_3197.csv");
  fs.appendFileSync(file, `2,B,secondary,,"LINESTRING (139.72 35.60, 139.73 35.61)"\n`);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.strictEqual((await cellWays("1256_3197", { gridDir: dir })).length, 2, "古いマスを返し続けた");
});

// ---- 画面（road-builder.html）の計算 ----
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const grab = (name) => {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `road-builder.html から ${name} を取り出せない`);
  return m[0];
};

test("画面の世界座標は Google マップと同じ（シカゴの例）・線分までの距離", () => {
  const osmWorld = new Function(`${grab("osmWorld")}; return osmWorld;`)();
  // Google Maps のドキュメントの例: シカゴ (41.85, -87.65) → 世界座標 (65.67111, 95.17490)
  const [x, y] = osmWorld(41.85, -87.65);
  assert.ok(Math.abs(x - 65.67111) < 1e-4 && Math.abs(y - 95.17490) < 1e-4, `${x},${y}`);
  const dist = new Function(`${grab("osmSegmentDistance")}; return osmSegmentDistance;`)();
  assert.strictEqual(dist(5, 3, 0, 0, 10, 0), 3, "線分の途中への距離");
  assert.strictEqual(dist(-4, 3, 0, 0, 10, 0), 5, "線分の外は端までの距離");
  assert.strictEqual(dist(13, 4, 0, 0, 10, 0), 5);
});

test("画面はサーバの線をそのまま読み、枠を作る（名前の無い道もそのまま）", () => {
  const prepare = new Function(`${grab("decodePolyline")}; ${grab("osmWorld")}; ${grab("osmPrepareCell")}; return osmPrepareCell;`)();
  const { encode } = require("../lib/polyline");
  const [way] = prepare([{ i: "2", n: "", h: "residential", r: "", p: encode([[139.72, 35.6], [139.73, 35.62]]) }]);
  assert.deepStrictEqual({ id: way.id, name: way.name, highway: way.highway }, { id: "2", name: "", highway: "residential" });
  assert.strictEqual(way.xy.length, 4);
  const osmWorld = new Function(`${grab("osmWorld")}; return osmWorld;`)();
  const [x0, y0] = osmWorld(35.62, 139.72), [x1, y1] = osmWorld(35.6, 139.73);
  assert.deepStrictEqual(way.box.map((v) => v.toFixed(9)), [x0, y0, x1, y1].map((v) => v.toFixed(9)), "枠が線を囲んでいない");
});

test("画面は寄ったときだけ見えているマスを取りに行き、キャンバスはクリックを奪わない", () => {
  assert.match(html, /const OSM_MIN_ZOOM = 13;/);
  const refresh = grab("refreshOsm");
  const zoomGate = refresh.search(/\n  if \(z < OSM_MIN_ZOOM\) \{/);
  assert.ok(zoomGate >= 0 && zoomGate < refresh.indexOf("/api/roads/osm-cells"), "引いているのにマスを聞いた");
  assert.match(refresh, /if \(seq !== osm\.seq\) return;/, "古い答えで描き直している");
  assert.match(refresh, /osm\.visible = r\.cells;\n.*\n  osm\.hover = null;/, "前に乗せた道の名前が、別の場所へ移っても残る");
  assert.match(html, /c\.style\.cssText = "position:absolute;pointer-events:none;";/, "キャンバスが道を足すクリックを奪う");
  assert.match(html, /setupOsmLayer\(\);\n {2}loadWeights\(\)/, "地図を作ったときに OSM の道を用意していない");
});
