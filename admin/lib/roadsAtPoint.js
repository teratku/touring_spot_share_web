/**
 * roadsAtPoint.js
 *
 * 地図で指した1点のまわりにある道路を、手元のグリッドCSVから組み立てる。
 *
 * 【なぜ必要か】
 * 通行規制の登録は、これまで**道路名で引く**しかなかった（`/api/restrictions/roads`）。
 * それには県ごとの索引（`buildRoadIndex.js`）が要り、全国を作るには時間がかかるため
 * 3県しか用意できていない。しかも二普協の道路名と地図の名前は食い違うことがあり
 * （「道祖神峠」と「笠間つくば線」）、名前が分からないと何も出せない。
 *
 * 場所さえ分かれば道は特定できるので、**点を渡して**そのまわりの道を組み立てる。
 * 索引が無い県でもすぐ使える。
 *
 * 【グリッドの決まり（実データ4,587ファイルから逆算して確認）】
 *   ファイル名 roads_grid_<a>_<b>.csv
 *     a = floor(lat * 10) + 900
 *     b = floor(lng * 10) + 1800
 *   1マス 0.1度（緯度で約11km）。無作為12ファイルで点の中央値がマス内に入ることを確認済み。
 *
 * ⚠️ このディレクトリの CSV は列が `osm_id,name,highway,ref,geometry` の5つで、
 *    **県の列が無い**（`~/Downloads/python/` の古い方とは別物）。県は呼び出し側が渡す。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseWkt, distanceMeters, readGridFile } = require("./roadCsv");
const { stitch } = require("./roadStitcher");
const { simplify, encode } = require("./polyline");

/** 手元のグリッドCSVの置き場 */
const GRID_DIR = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");

/** 1マスの大きさ（度） */
const CELL_DEGREES = 0.1;

/** 規制区間になりうる道だけ。歩道・自転車道・私道は要らない */
const TARGET_HIGHWAYS = new Set([
  "primary", "secondary", "tertiary", "trunk", "motorway",
  "unclassified", "residential",
  // ランプ類。峠の入口が接続路になっていることがある
  "primary_link", "secondary_link", "tertiary_link", "trunk_link", "motorway_link",
]);

/** 探す既定の半径（m）。0.1度マスは約11kmあるので、指した道だけに絞る */
const DEFAULT_RADIUS = 300;
/** 半径の上限。広げすぎると1マスを何度も読み直して待たされる */
const MAX_RADIUS = 3000;

/** 地図に返す線の粗さ。区間を切るのに使うだけなので粗くてよい */
const TOLERANCE = 15;

function gridFileName(lat, lng) {
  // ⚠️ **0.1 で割らないこと。** `Math.floor(139.1 / 0.1)` は 1390 になる
  //    （139.1/0.1 = 1390.9999999999998）。マスの境目ちょうどを指したとき
  //    1つ手前のマスを読み、エラーも出ないまま「道が無い」ように見える。
  //    10 を掛ける方は 139.1*10 = 1391.0000000000002 で正しく丸まる。
  const a = Math.floor(lat * 10) + 900;
  const b = Math.floor(lng * 10) + 1800;
  return `roads_grid_${a}_${b}.csv`;
}

/**
 * 半径ぶん見るのに必要なマスの一覧。
 *
 * ⚠️ 指した点のマスだけでは足りない。マスの境目を指すと、道の続きが隣のマスにあり
 *    そこで途切れた線が返る。半径ぶん広げた四隅のマスをすべて見る。
 *
 * ⚠️ **四隅だけで足りるのは、半径が1マス（0.1度＝約11km）より小さいから。**
 *    範囲が3マス以上にまたがると真ん中のマスを取りこぼす。`MAX_RADIUS` を
 *    1マスより大きくするなら、ここも総当たりに変えること。
 */
function gridFilesFor(lat, lng, radiusMeters) {
  const dLat = radiusMeters / 111_320;
  const dLng = radiusMeters / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const names = new Set();
  for (const y of [lat - dLat, lat, lat + dLat]) {
    for (const x of [lng - dLng, lng, lng + dLng]) {
      names.add(gridFileName(y, x));
    }
  }
  return [...names];
}

/** 点から線までの最短距離（m）。頂点だけでなく辺も見る */
function distanceToLine(point, points) {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    best = Math.min(best, distanceMeters(point, points[i]));
    if (i + 1 < points.length) {
      const mid = [(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2];
      best = Math.min(best, distanceMeters(point, mid));
    }
  }
  return best;
}

/**
 * 指した点のまわりの道路を組み立てる。
 *
 * @param {number} lat  指した緯度
 * @param {number} lng  指した経度
 * @param {object} options
 *   - radiusMeters: 探す半径（既定 300、上限 3000）
 *   - prefecture:   県名。CSV に列が無いので呼び出し側が渡す（繋ぐときの束ね方に使う）
 *   - gridDir:      CSV の置き場（テスト用に差し替える）
 * @returns {Promise<{roads: Array, grids: string[], missing: string[]}>}
 */
async function roadsAtPoint(lat, lng, options = {}) {
  const radius = Math.min(MAX_RADIUS, Math.max(10, Number(options.radiusMeters) || DEFAULT_RADIUS));
  const prefecture = options.prefecture || "";
  const dir = options.gridDir || GRID_DIR;
  const at = [lng, lat];   // CSV と同じ [lng, lat] の並びに合わせる

  const files = gridFilesFor(lat, lng, radius);
  const grids = [];
  const missing = [];
  const fragments = [];

  for (const name of files) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    grids.push(name);
    await readGridFile(file, (row) => {
      const highway = row.get("highway");
      if (!TARGET_HIGHWAYS.has(highway)) return;
      const points = parseWkt(row.get("geometry"));
      if (!points || points.length < 2) return;
      // ⚠️ 先に粗く弾く。全部の辺を測ると1マス数万本で待たされる
      if (distanceMeters(at, points[0]) > radius + 20_000) return;
      if (distanceToLine(at, points) > radius) return;
      fragments.push({
        prefecture,
        name: row.get("name") || row.get("ref") || "",
        ref: row.get("ref") || "",
        highway,
        osmId: row.get("osm_id"),
        points,
      });
    });
  }

  // ⚠️ 名前の無い断片をまとめて繋がないこと。`stitch` は県＋名前で束ねるので、
  //    名前が空の断片が全部1本の道に化ける。osm_id で別々にしておく。
  for (const f of fragments) {
    if (!f.name) f.name = `（名前なし）${f.osmId}`;
  }

  const stitched = stitch(fragments);
  const roads = stitched
    .map((road) => {
      const thinned = simplify(road.points, TOLERANCE);
      return {
        name: road.name,
        ref: road.ref || "",
        highway: road.highway,
        lengthMeters: Math.round(lengthOf(road.points)),
        distanceMeters: Math.round(distanceToLine(at, road.points)),
        fragmentCount: road.fragmentCount,
        polyline: encode(thinned),
      };
    })
    // 指した場所に近い道から出す。押し間違いでも上に本命が来る
    .sort((a, b) => a.distanceMeters - b.distanceMeters || b.lengthMeters - a.lengthMeters);

  return { roads, grids, missing, radius };
}

function lengthOf(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

module.exports = {
  roadsAtPoint, gridFileName, gridFilesFor, distanceToLine,
  GRID_DIR, DEFAULT_RADIUS, MAX_RADIUS, TARGET_HIGHWAYS,
};
