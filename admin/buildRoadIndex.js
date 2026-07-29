#!/usr/bin/env node
/**
 * buildRoadIndex.js
 *
 * 県ごとに「道路名 → 連結した線」の索引を作る。
 * 規制を新規追加するとき、道路名で引いて地図に出すために使う。
 *
 * ⚠️ ブラウザにまるごと送るには大きすぎるので、サーバー側に置いて
 *    名前で検索し、選ばれた道路だけを返す。
 *
 *   node buildRoadIndex.js --prefecture 茨城県
 *   node buildRoadIndex.js --all
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { listGridFiles, readGridFile, parseWkt, distanceMeters } = require("./lib/roadCsv");
const { stitch } = require("./lib/roadStitcher");
const { simplify, encode } = require("./lib/polyline");
const { PrefectureLocator } = require("./lib/prefectureLocator");
const { ROMAJI } = require("./lib/prefectureRomaji");

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = argVal("--prefecture");
const ALL = args.includes("--all");
const OUT_DIR = path.join(__dirname, "data", "road-index");
const GRID_DIR = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
/** 規制区間になりうる道だけ。歩道・自転車道は要らない */
const TARGET = new Set(["primary", "secondary", "tertiary", "trunk", "motorway", "unclassified", "residential"]);
/** 索引の線の粗さ。地図で区間を切るのに使うだけなので粗くてよい */
const TOLERANCE = 20;
/** これより短い道は載せない（索引が膨らむわりに使わない） */
const MIN_METERS = 200;

async function main() {
  const targets = ONLY ? [ONLY] : ALL ? Object.keys(ROMAJI) : [];
  if (!targets.length) { console.error("--prefecture <県名> か --all を指定してください"); process.exit(1); }

  const locator = new PrefectureLocator();
  const wanted = new Set(targets);
  const byPref = new Map();
  const files = listGridFiles(GRID_DIR);
  let read = 0;
  for (const file of files) {
    await readGridFile(file, ({ get }) => {
      const name = get("name");
      const highway = get("highway");
      if (!name || !TARGET.has(highway)) return;
      const points = parseWkt(get("geometry"));
      if (!points) return;
      const pref = locator.locatePolyline(points);
      if (!pref || !wanted.has(pref)) return;
      const list = byPref.get(pref) || [];
      list.push({ prefecture: pref, name, ref: get("ref"), highway, osmId: get("osm_id"), points });
      byPref.set(pref, list);
    });
    if (++read % 800 === 0) process.stderr.write(`  読み込み ${read}/${files.length}\r`);
  }
  process.stderr.write("".padEnd(40) + "\r");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [prefecture, fragments] of byPref) {
    const roads = [];
    for (const chain of stitch(fragments)) {
      let meters = 0;
      for (let i = 1; i < chain.points.length; i++) meters += distanceMeters(chain.points[i - 1], chain.points[i]);
      if (meters < MIN_METERS) continue;
      roads.push({
        name: chain.name, highway: chain.highway,
        lengthMeters: Math.round(meters),
        polyline: encode(simplify(chain.points, TOLERANCE)),
      });
    }
    roads.sort((a, b) => b.lengthMeters - a.lengthMeters);
    const file = path.join(OUT_DIR, `${ROMAJI[prefecture]}.json`);
    fs.writeFileSync(file, JSON.stringify({ prefecture, romaji: ROMAJI[prefecture], count: roads.length, roads }) + "\n");
    console.log(`  ${prefecture.padEnd(6)} ${String(roads.length).padStart(5)}本  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)}MB`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
