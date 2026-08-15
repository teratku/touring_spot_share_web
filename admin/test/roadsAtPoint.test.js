"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { gridFileName, gridFilesFor, distanceToLine, roadsAtPoint,
        DEFAULT_RADIUS, MAX_RADIUS } = require("../lib/roadsAtPoint");

/**
 * 地図で指した点から道路を組み立てる処理の確認。
 *
 * ⚠️ グリッドの式（a = floor(lat*10)+900 / b = floor(lng*10)+1800）を間違えると、
 *    **エラーにならず別の場所のCSVを読む**。「その辺に道が無いのだろう」と
 *    勘違いするだけで気付けないので、ここで固定する。
 *    式は実データ4,587ファイルのうち無作為12個で、点の中央値がマスに入ることを確認して決めた。
 */
test("グリッドのファイル名を座標から決める", () => {
  // 実ファイルで確かめた対応（roads_grid_1140_3037.csv は lat 24.0〜24.1 / lng 123.7〜123.8）
  assert.strictEqual(gridFileName(24.0522, 123.7732), "roads_grid_1140_3037.csv");
  assert.strictEqual(gridFileName(36.1970, 139.2876), "roads_grid_1261_3192.csv");
  assert.strictEqual(gridFileName(45.5007, 141.8911), "roads_grid_1355_3218.csv");
});

test("マスの下端はそのマス、上端は次のマス", () => {
  // 境目の扱いを取り違えると、指した場所と1マスずれる
  assert.strictEqual(gridFileName(36.0, 139.0), "roads_grid_1260_3190.csv");
  assert.strictEqual(gridFileName(36.0999, 139.0999), "roads_grid_1260_3190.csv");
  assert.strictEqual(gridFileName(36.1, 139.1), "roads_grid_1261_3191.csv");
});

test("境目を指したら隣のマスも見る", () => {
  // ⚠️ 指したマスだけだと、道の続きが隣にあって途中で切れた線が返る
  const onEdge = gridFilesFor(36.0, 139.4869, 300);
  assert.ok(onEdge.length >= 2, "境目なのに1マスしか見ていない: " + onEdge.join(","));
  assert.ok(onEdge.includes("roads_grid_1260_3194.csv"));
  assert.ok(onEdge.includes("roads_grid_1259_3194.csv"));
});

test("マスの真ん中なら1マスで足りる", () => {
  assert.deepStrictEqual(gridFilesFor(36.05, 139.05, 300), ["roads_grid_1260_3190.csv"]);
});

test("マスの真ん中なら半径を広げても1マスのまま", () => {
  // 1マスは約11km×9km。上限の3kmでも真ん中からははみ出さない
  assert.strictEqual(gridFilesFor(36.05, 139.05, MAX_RADIUS).length, 1);
});

test("マスの角では4マスを見る", () => {
  const corner = gridFilesFor(36.0, 139.0, 800);
  assert.strictEqual(corner.length, 4, "角なのに4マス見ていない: " + corner.join(","));
});

test("上限の半径は1マスより小さい", () => {
  // ⚠️ ここが崩れると `gridFilesFor` の四隅だけの見方では真ん中のマスを取りこぼす。
  //    上限を上げるなら総当たりに書き換えること
  const cellMeters = 0.1 * 111320;
  assert.ok(MAX_RADIUS * 2 < cellMeters,
            `半径の上限が1マスを超えている（${MAX_RADIUS * 2}m vs ${Math.round(cellMeters)}m）`);
});

test("点から線までの距離は辺の途中も見る", () => {
  // ⚠️ 頂点だけを見ると、長い直線のそばに立っているのに「遠い」と判定して道を見落とす
  const line = [[139.0, 36.0], [139.0, 36.1]];       // 約11kmの直線
  const middle = [139.0, 36.05];                      // その中ほど（頂点ではない）
  assert.ok(distanceToLine(middle, line) < 300,
            "辺の途中を見ていない: " + distanceToLine(middle, line));
});

test("半径は上限で止める", async (t) => {
  const dir = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
  if (!fs.existsSync(dir)) return t.skip("手元にCSVが無い環境");
  // ⚠️ 上限が効かないと、1回のクリックで何十マスも読んで待たされる
  const r = await roadsAtPoint(36.7386, 139.4869, { radiusMeters: 999999 });
  assert.strictEqual(r.radius, MAX_RADIUS);
});

test("半径を指定しなければ既定を使う", async (t) => {
  const dir = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
  if (!fs.existsSync(dir)) return t.skip("手元にCSVが無い環境");
  const r = await roadsAtPoint(36.7386, 139.4869, {});
  assert.strictEqual(r.radius, DEFAULT_RADIUS);
});

test("道の上を指せばその道が返る", async (t) => {
  const dir = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
  if (!fs.existsSync(dir)) return t.skip("手元にCSVが無い環境");
  // いろは坂のあたり（実データで確認済み）
  const r = await roadsAtPoint(36.7386, 139.4869, { prefecture: "栃木県" });
  assert.ok(r.roads.length >= 1, "道が1本も返らない");
  assert.ok(r.roads[0].distanceMeters <= DEFAULT_RADIUS, "半径の外の道が混ざっている");
  assert.ok(r.roads[0].polyline.length > 0, "線が空");
});

test("近い道から順に返す", async (t) => {
  const dir = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
  if (!fs.existsSync(dir)) return t.skip("手元にCSVが無い環境");
  // ⚠️ 押し間違いでも本命が上に来るように。遠い道が先頭だと選び間違える
  const r = await roadsAtPoint(35.541343, 138.873705, { prefecture: "山梨県", radiusMeters: 2000 });
  for (let i = 1; i < r.roads.length; i++) {
    assert.ok(r.roads[i - 1].distanceMeters <= r.roads[i].distanceMeters,
              "近い順になっていない");
  }
});

test("道の無い場所でも落ちない", async (t) => {
  const dir = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
  if (!fs.existsSync(dir)) return t.skip("手元にCSVが無い環境");
  const r = await roadsAtPoint(35.0, 141.5, {});   // 太平洋の上
  assert.deepStrictEqual(r.roads, []);
  assert.ok(Array.isArray(r.missing));
});
