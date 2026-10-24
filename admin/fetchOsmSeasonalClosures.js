#!/usr/bin/env node
/**
 * fetchOsmSeasonalClosures.js
 *
 * OpenStreetMap から冬季閉鎖など「毎年この期間は走れない」道を拾って、登録候補を作る。
 * 出力は admin/data/restriction-osm-season/<romaji>.json（調整ツールの規制タブに並ぶ）。
 *
 * ⚠️ 利用者の判断（2026-10-24）:「スカイラインとかの走れなくなる日付を表示」→「OSM から自動で拾い、調整ツールで直す」。
 * ⚠️ **そのまま配信しない。** 候補まで。期間は OSM では月だけのことが多く、毎年の開通日・閉鎖日は
 *    道路管理者の発表で確かめて、調整ツールで日付を入れてから登録する。
 * ⚠️ **OSM に無い道のほうが多い。** 有名なスカイライン類（ビーナスライン・蔵王エコーライン・
 *    富士山スカイラインなど）には季節の札が付いていない（2026-10-24 に確認）。それらは調整ツールで手で足す。
 * ⚠️ 二輪の規制の候補（`fetchOsmRestrictions.js`）とはファイルを分ける。どちらも県ぶんを丸ごと
 *    書き直すので、同じファイルにすると互いを消し合う（`server.js` の候補の読み込みを参照）。
 *
 * 使い方:
 *   node fetchOsmSeasonalClosures.js --prefecture 長野県
 *   node fetchOsmSeasonalClosures.js --all
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { ROMAJI } = require("./lib/prefectureRomaji");
const { TARGET_HIGHWAYS } = require("./lib/roadsAtPoint");
const { stitch } = require("./lib/roadStitcher");
const { polylineLength } = require("./lib/roadCsv");
const { simplify, encode, decode } = require("./lib/polyline");
const { findOverlaps } = require("./lib/restrictionOverlap");
const { monthsOfPeriod } = require("./lib/restrictionTime");
const { parseSeasonalClosure } = require("./lib/osmSeasonTags");
const { membersOf, overpassWith, MIN_CHAIN_METERS } = require("./fetchOsmRestrictions");

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = argVal("--prefecture");
const ALL = args.includes("--all");

const OUT_DIR = path.join(__dirname, "data", "restriction-osm-season");
/** 公開の Overpass に負担をかけない（`fetchOsmRestrictions.js` と同じ） */
const POLITE_DELAY_MS = 4000;
const TOLERANCE = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 1県ぶんのクエリ。
 * ⚠️ `highway` の絞りはクエリに書かない（桁違いに遅くなる・`fetchOsmRestrictions.js` の実測）。こちらで落とす
 */
function buildQuery(prefecture) {
  return `[out:json][timeout:120];
area["name"="${prefecture}"]["admin_level"="4"]->.a;
(
  way["access:conditional"~"[A-Z][a-z]{2}|winter"](area.a);
  way["motor_vehicle:conditional"~"[A-Z][a-z]{2}|winter"](area.a);
  way["vehicle:conditional"~"[A-Z][a-z]{2}|winter"](area.a);
  way["motorcycle:conditional"~"[A-Z][a-z]{2}|winter"](area.a);
  way["seasonal"](area.a);
  way["description"~"冬[期季]"](area.a);
  way["note"~"冬[期季]"](area.a);
  way["name"~"冬[期季]"](area.a);
);
out geom;`;
}

/** way → 道路断片。期間の読めない・道でない・名前の無いものは落とす */
function toFragments(elements, prefecture) {
  const fragments = [];
  for (const e of elements) {
    const tags = e.tags || {};
    const name = tags.name || tags.ref;
    if (!name) continue;
    if (!TARGET_HIGHWAYS.has(tags.highway)) continue;
    if (!e.geometry || e.geometry.length < 2) continue;
    const closure = parseSeasonalClosure(tags);
    if (!closure) continue;
    fragments.push({
      prefecture, name, ref: tags.ref || "", highway: tags.highway,
      osmId: String(e.id), tags, closure,
      points: e.geometry.map((p) => [p.lon, p.lat]),
    });
  }
  return fragments;
}

/** 登録済みの冬季閉鎖と重なる鎖（二重登録を避ける）。⚠️ 二輪通行禁止と重なるのは二重ではない */
function registeredWinter(romaji, chains) {
  const file = path.join(__dirname, "data", "road-restrictions", `${romaji}.json`);
  if (!fs.existsSync(file)) return new Set();
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")).restrictions || []; }
  catch { return new Set(); }
  const restrictions = saved.filter((r) => r.kind === "winterClosure" || r.kind === "closed")
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, points: decode(r.polyline) }))
    .filter((r) => r.points.length >= 2);
  if (!restrictions.length) return new Set();
  return new Set(findOverlaps(restrictions, chains.map((c, i) => ({ id: i, name: c.name, points: c.points }))).keys());
}

/** 鎖の期間は断片の多数派（区間ごとに違えば注意書きを付ける） */
function dominantClosure(members) {
  const counts = new Map();
  for (const m of members) {
    const key = JSON.stringify(m.closure.period);
    const hit = counts.get(key) || { count: 0, closure: m.closure };
    hit.count++;
    counts.set(key, hit);
  }
  let best = null;
  for (const hit of counts.values()) if (!best || hit.count > best.count) best = hit;
  return { closure: best.closure, mixed: counts.size > 1 };
}

function buildCandidates(prefecture, romaji, elements) {
  const fragments = toFragments(elements, prefecture);
  if (!fragments.length) return [];
  const chains = stitch(fragments)
    .map((c) => ({ ...c, lengthMeters: Math.round(polylineLength(c.points)) }))
    .filter((c) => c.lengthMeters >= MIN_CHAIN_METERS)
    .sort((a, b) => b.lengthMeters - a.lengthMeters);
  const dup = registeredWinter(romaji, chains);

  return chains.map((chain, index) => {
    const members = membersOf(chain, fragments);
    if (!members.length) return null;
    const { closure, mixed } = dominantClosure(members);
    const polyline = encode(simplify(chain.points, TOLERANCE));
    const reasons = [closure.reason];
    if (!closure.period) reasons.push("期間が無い。日付を入れてから登録すること");
    if (mixed) reasons.push("この道は区間によって期間の書かれ方が違う。範囲を必ず確かめること");
    if (dup.has(index)) reasons.push("登録済みの冬季閉鎖・通行止めと重なっている（二重登録に注意）");
    return {
      // ⚠️ 取り込み直しても変わらない id（鎖の中でいちばん小さい way 番号）。
      //    二輪の候補（osm-）と同じ道でも別の規制なので、頭を変える
      id: `osmw-${romaji}-${members.map((m) => Number(m.osmId)).sort((a, b) => a - b)[0]}`,
      prefecture, city: "",
      sourceRoad: chain.name,
      matchedName: chain.name,
      from: "", to: "",
      target: closure.sourceTag,
      targetLabel: "二輪すべて",
      confidence: "OSM",
      reason: reasons.filter(Boolean).join(" / "),
      chainPolyline: polyline,
      polyline,
      lengthMeters: chain.lengthMeters,
      geocode: null,
      kind: "winterClosure",
      minCc: null, maxCc: null,
      activePeriod: closure.period,
      activeMonths: monthsOfPeriod(closure.period),
      activeDays: null, includesHoliday: false, activeHours: null,
      fragmentCount: chain.fragmentCount,
      alreadyRegistered: dup.has(index),
    };
  }).filter(Boolean);
}

async function main() {
  const targets = ONLY ? [ONLY] : ALL ? Object.keys(ROMAJI) : null;
  if (!targets) {
    console.log("使い方:");
    console.log("  node fetchOsmSeasonalClosures.js --prefecture 長野県   1県だけ");
    console.log("  node fetchOsmSeasonalClosures.js --all                全国（数分かかる）");
    return;
  }
  const unknown = targets.filter((p) => !ROMAJI[p]);
  if (unknown.length) { console.error(`県名が分かりません: ${unknown.join("、")}`); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let total = 0, failed = 0;
  for (const prefecture of targets) {
    const romaji = ROMAJI[prefecture];
    const data = await overpassWith(prefecture, buildQuery(prefecture));
    if (!data) {
      console.log(`  ❌ ${prefecture.padEnd(5)} 取れなかった（時間をおいて --prefecture で試すこと）`);
      failed++;
      await sleep(POLITE_DELAY_MS);
      continue;
    }
    const candidates = buildCandidates(prefecture, romaji, data.elements || []);
    const file = path.join(OUT_DIR, `${romaji}.json`);
    if (candidates.length) {
      fs.writeFileSync(file, JSON.stringify({
        prefecture, romaji,
        builtAt: new Date().toISOString(),
        count: candidates.length,
        source: "openstreetmap",
        sourceUrl: "https://www.openstreetmap.org/",
        attribution: "© OpenStreetMap contributors（ODbL）",
        candidates,
      }, null, 1) + "\n");
      total += candidates.length;
      console.log(`  ✅ ${prefecture.padEnd(5)} ${String(candidates.length).padStart(3)}本　`
        + candidates.slice(0, 3).map((c) => `${c.sourceRoad}（${c.activePeriod ? `${c.activePeriod.from}〜${c.activePeriod.to}` : "期間なし"}）`).join("・"));
    } else {
      // ⚠️ 前回の候補が残らないよう、0本の県はファイルを消さずに空で書き直す（消すと調整ツールが古い候補を出す心配は無いが、取った記録を残す）
      if (fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ prefecture, romaji, builtAt: new Date().toISOString(), count: 0, source: "openstreetmap", attribution: "© OpenStreetMap contributors（ODbL）", candidates: [] }, null, 1) + "\n");
      console.log(`  ・ ${prefecture.padEnd(5)}   0本`);
    }
    await sleep(POLITE_DELAY_MS);
  }
  console.log(`\n候補 ${total}本${failed ? `（取れなかった県 ${failed}）` : ""}`);
  console.log("⚠️ これは候補です。調整ツールの規制タブで期間を確かめて登録してください。");
}

module.exports = { buildQuery, buildCandidates, toFragments };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
