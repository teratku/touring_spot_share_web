/**
 * admin/buildMichiNoEki.js
 *
 * OSM から道の駅の一覧 `admin/data/michinoeki.json` を作る（`admin/lib/michiNoEki.js` が読む）。
 *
 * 利用者の要望（2026-10-01）:「途中で道の駅によるモードあったらいいなー」。判断（2026-10-03）: 休憩の間隔で足す。
 *
 * 作り方（OSM を焼き直したら作り直す）:
 *   osmium tags-filter japan.osm.pbf "nwr/name=道の駅*" "nwr/brand=道の駅" "nwr/brand:ja=道の駅" "nwr/official_name=道の駅*" -o michi.osm.pbf
 *   osmium export michi.osm.pbf -f geojsonseq -o michi.geojsonseq
 *   node admin/buildMichiNoEki.js michi.geojsonseq admin/data/michinoeki.json
 *
 * 形: { stations: [[緯度, 経度, 名前], ...] }
 *
 * ⚠️ 実測（2026-10-03・8/25 の OSM）: 「道の駅」で始まる名前の地物 3,503件 → 道の駅の駅ではないもの
 *    （「道の駅入口」の交差点・バス停など201件）を除き、同じ駅の付属施設（物産館・駐車場・案内所）を
 *    500m 以内でまとめて **1,162駅**。全国の道の駅（約1,230駅）の9割強。
 *    敷地（`highway=services`）894・`rest_area` 65・駐車場 63・建物など 140
 * ⚠️ **名前だけで同じ駅にしない。** 同じ名前の駅が別の県にある（「みかわ」「さかい」「清川」など）。場所で見る
 */
"use strict";
const fs = require("fs");
const readline = require("readline");

//: 同じ駅とみなす距離（m）。付属施設（物産館・第2駐車場）は敷地から数百m 離れて描かれることがある
const MERGE_METERS = 500;
//: 駅ではない（交差点・バス停・看板）
const NOT_STATION = /(入口|入り口|前|バス停|交差点|案内|方面)$/;
const SKIP_HIGHWAY = new Set(["bus_stop", "traffic_signals", "crossing", "stop", "give_way"]);

function meters(a, b) {
  const k = Math.cos((a[0] * Math.PI) / 180) * 111320;
  return Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * k);
}

/** 名前の芯（「道の駅」と空白・かぎ括弧を除く）。駅でないものを見分けるのに使う */
function coreName(name) {
  return String(name || "").normalize("NFKC").trim()
    .replace(/^道の駅/, "").replace(/[\s「」『』()（）・]/g, "");
}

/** 地物の中心 [緯度, 経度] */
function centerOf(geometry) {
  if (!geometry) return null;
  const c = geometry.coordinates;
  if (geometry.type === "Point") return [c[1], c[0]];
  const ring = geometry.type === "Polygon" ? c[0]
    : geometry.type === "MultiPolygon" ? c.map((p) => p[0]).sort((a, b) => b.length - a.length)[0]
    : geometry.type === "LineString" ? c : null;
  if (!ring || !ring.length) return null;
  return [ring.reduce((s, p) => s + p[1], 0) / ring.length, ring.reduce((s, p) => s + p[0], 0) / ring.length];
}

/** 敷地を優先する順（小さいほど先に採る） */
function rankOf(p) {
  if (p.highway === "services") return 0;
  if (p.highway === "rest_area") return 1;
  if (p.amenity === "parking") return 2;
  return 3;
}

/**
 * 地物（geojson の Feature）の並びから、道の駅の一覧を作る。
 * @returns {Array<[number, number, string]>} [緯度, 経度, 名前]
 */
function buildStations(features) {
  const items = [];
  for (const f of features) {
    const p = (f && f.properties) || {};
    const name = String(p.name || "").normalize("NFKC").trim();
    const brand = p.brand === "道の駅" || p["brand:ja"] === "道の駅";
    if (!name.startsWith("道の駅") && !brand) continue;
    const core = coreName(name);
    if (core.length < 2 || NOT_STATION.test(core)) continue;
    if (SKIP_HIGHWAY.has(p.highway) || p.public_transport) continue;
    const at = centerOf(f.geometry);
    if (!at) continue;
    items.push({ rank: rankOf(p), at, name: name.startsWith("道の駅") ? name : `道の駅${name}` });
  }
  // ⚠️ 敷地を先に採り、そこから近い付属施設は同じ駅としてまとめる
  items.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const kept = [];
  for (const it of items) {
    if (kept.every((k) => meters(it.at, k.at) > MERGE_METERS)) kept.push(it);
  }
  return kept.map((k) => [Number(k.at[0].toFixed(6)), Number(k.at[1].toFixed(6)), k.name]);
}

async function main(input, output) {
  const features = [];
  const rl = readline.createInterface({ input: fs.createReadStream(input) });
  for await (const line of rl) {
    const text = line.replace(/^\x1e/, "").trim();
    if (text) features.push(JSON.parse(text));
  }
  const stations = buildStations(features);
  fs.writeFileSync(output, JSON.stringify({ stations }) + "\n");
  console.log(`道の駅 ${stations.length}駅 → ${output}`);
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("使い方: node admin/buildMichiNoEki.js michi.geojsonseq admin/data/michinoeki.json");
    process.exit(1);
  }
  main(input, output).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildStations, coreName, MERGE_METERS };
