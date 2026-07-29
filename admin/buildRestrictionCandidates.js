#!/usr/bin/env node
/**
 * buildRestrictionCandidates.js
 *
 * 取り込んだ規制情報から、区間の候補ポリラインを作る。
 * 出力は admin/data/restriction-candidates/<romaji>.json（開発者が確認するための下書き）。
 *
 * ⚠️ そのまま配信しない。road-builder の規制タブで1件ずつ地図で確認して登録する。
 *
 * 使い方:
 *   node buildRestrictionCandidates.js --prefecture 茨城県
 *   node buildRestrictionCandidates.js --all
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { listGridFiles, readGridFile, parseWkt } = require("./lib/roadCsv");
const { buildIndex } = require("./lib/roadNameMatcher");
const { buildCandidate } = require("./lib/restrictionMatcher");
const { parseTarget } = require("./lib/restrictionTarget");
const { ROMAJI } = require("./lib/prefectureRomaji");
const { PrefectureLocator } = require("./lib/prefectureLocator");

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = argVal("--prefecture");
const ALL = args.includes("--all");
const API_KEY = process.env.GOOGLE_MAPS_API_KEY || "AIzaSyASDL3J6KQSn7uxxgRcuH0gYAYrYWE9I24";
const SRC_DIR = path.join(__dirname, "data", "restriction-source");
const OUT_DIR = path.join(__dirname, "data", "restriction-candidates");
const GRID_DIR = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");

/** 対象の県に関わる道路の断片だけを集める（全国を持つとメモリが厳しい） */
async function loadFragments(prefectures) {
  const locator = new PrefectureLocator();
  const wanted = new Set(prefectures);
  const byName = new Map();
  const names = new Set();
  const files = listGridFiles(GRID_DIR);
  let read = 0;
  for (const file of files) {
    await readGridFile(file, ({ get }) => {
      const name = get("name");
      if (!name) return;
      names.add(name);
      const points = parseWkt(get("geometry"));
      if (!points) return;
      const pref = locator.locatePolyline(points);
      if (!pref || !wanted.has(pref)) return;
      const list = byName.get(name) || [];
      list.push({ prefecture: pref, name, ref: get("ref"), highway: get("highway"),
                  osmId: get("osm_id"), points });
      byName.set(name, list);
    });
    if (++read % 800 === 0) process.stderr.write(`  道路データ ${read}/${files.length}\r`);
  }
  process.stderr.write("".padEnd(40) + "\r");
  return { byName, index: buildIndex(names) };
}

async function main() {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".json"));
  const sources = files.map((f) => JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), "utf8")))
                       .filter((d) => !ONLY || d.prefecture === ONLY);
  const bySourceRomaji = new Map(sources.map((s) => [ROMAJI[s.prefecture], s]));
  if (!sources.length) { console.error("対象がありません。--prefecture か --all を確認してください"); process.exit(1); }
  if (!ONLY && !ALL) { console.error("--prefecture <県名> か --all を指定してください"); process.exit(1); }

  console.log(`対象: ${sources.map((s) => s.prefecture).join("、")}`);
  const { byName, index } = await loadFragments(sources.map((s) => s.prefecture));
  console.log(`道路名の索引 ${index.exact.size.toLocaleString()}種類 / 対象県の道路 ${byName.size.toLocaleString()}本\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const source of sources) {
    const candidates = [];
    for (const entry of source.restrictions) {
      const c = await buildCandidate(entry, { index, fragmentsByName: byName, apiKey: API_KEY });
      const target = parseTarget(entry.target);
      c.minCc = target ? (target.minCc > 0 ? target.minCc : null) : null;
      c.maxCc = target ? (target.maxCc < 99999 ? target.maxCc : null) : null;
      c.targetLabel = target ? require("./lib/restrictionTarget").describe(target) : "二輪は対象外";
      candidates.push(c);
    }
    const ok = candidates.filter((c) => c.polyline).length;
    fs.writeFileSync(path.join(OUT_DIR, `${ROMAJI[source.prefecture]}.json`),
      JSON.stringify({
        prefecture: source.prefecture, romaji: ROMAJI[source.prefecture],
        builtAt: new Date().toISOString(), count: candidates.length, withGeometry: ok,
        // 一次情報（開発者が現地名・距離を裏取りするための出どころ）。
        // road-builder.html の一覧表示で「元データを見る」リンクとして出す。
        sourceUrl: source.source, sourceFetchedAt: source.fetchedAt,
        candidates,
      }, null, 1) + "\n");
    console.log(`  ${source.prefecture.padEnd(6)} ${String(ok).padStart(3)}/${candidates.length} 件で区間を作れた`);
    for (const c of candidates.filter((x) => !x.polyline).slice(0, 3)) {
      console.log(`      × ${(c.sourceRoad || "(名前なし)").slice(0, 20)} … ${c.reason}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
