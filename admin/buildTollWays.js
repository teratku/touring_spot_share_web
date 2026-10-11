/**
 * admin/buildTollWays.js
 *
 * OSM から有料の道の一覧 `admin/data/toll-ways.json` を作る（`admin/lib/roadToll.js` が読む）。
 * おすすめ道路の生成（`buildRoadRecommend.js`）が、道ごとに「有料」「一部有料」を判定するのに使う。
 *
 * 利用者の要望（2026-10-11）:「web のおすすめ道路編集で各道に有料かどうかを記載して、アプリ側でも有料か表示」
 *
 * 作り方（OSM を焼き直したら作り直す）:
 *   osmium tags-filter japan.osm.pbf w/toll -o toll.osm.pbf
 *   osmium export toll.osm.pbf -f geojsonseq -o toll.geojsonseq --geometry-types=linestring
 *   node admin/buildTollWays.js toll.geojsonseq admin/data/toll-ways.json
 *
 * 形: { ways: [{ n: 名前, r: 路線番号, h: 道の種類, p: 線（Encoded Polyline） }, ...] }
 *
 * ⚠️ 実測（2026-10-11・8/25 の OSM）: `toll` の付いた道 81,537本のうち `toll=yes` が 63,561本。
 *    ほとんどが高速（motorway 37,892・motorway_link 23,258）で、一般道の種類は primary 453・
 *    tertiary 392・trunk 304 など。`toll=no` や「自転車・原付だけ有料」（`toll=bicycle;moped`）は入れない
 * ⚠️ **高速も入れる。** 芦ノ湖スカイラインは OSM で一部が motorway になっている。
 *    街の高架（首都高など）を数えない工夫は判定の側（`roadToll.js`）でする
 */
"use strict";
const fs = require("fs");
const readline = require("readline");
const { encode } = require("./lib/polyline");

/** 車で通らない道（歩道・建設中など）。有料でも判定に使わない */
const SKIP_HIGHWAY = new Set(["footway", "path", "cycleway", "steps", "pedestrian", "construction",
                              "proposed", "service", "track", "bridleway"]);

/** geojsonseq の1行 → 入れるなら { n, r, h, p }、入れないなら null */
function tollWayOf(feature) {
  if (!feature || !feature.geometry || feature.geometry.type !== "LineString") return null;
  const p = feature.properties || {};
  if (p.toll !== "yes") return null;
  if (SKIP_HIGHWAY.has(p.highway)) return null;
  const coords = feature.geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  return { n: p.name || "", r: p.ref || "", h: p.highway || "", p: encode(coords) };  // geojson の座標は [経度, 緯度]（encode と同じ並び）
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("使い方: node admin/buildTollWays.js toll.geojsonseq admin/data/toll-ways.json");
    process.exit(1);
  }
  const ways = [];
  let read = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(input, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of lines) {
    // ⚠️ geojsonseq は行頭に区切り文字（RS・\x1e）が付く
    const line = raw.replace(/^\x1e/, "").trim();
    if (!line) continue;
    read++;
    const way = tollWayOf(JSON.parse(line));
    if (way) ways.push(way);
  }
  fs.writeFileSync(output, JSON.stringify({ builtAt: new Date().toISOString(), source: input, ways }) + "\n");
  console.log(`読んだ ${read}件 → 有料の道 ${ways.length}本: ${output}（${(fs.statSync(output).size / 1024 / 1024).toFixed(1)}MB）`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { tollWayOf, SKIP_HIGHWAY };
