#!/usr/bin/env node
/**
 * matchJarticToRegistered.js
 *
 * 二普協由来の規制それぞれに、**JARTIC の置き換え候補を並べた確認待ちの一覧**を作る。
 *
 * ⚠️ **昇格はしない。** ここが作るのは人が見るための行列で、判定ではない
 *    （理由は `lib/restrictionRebuild.js` の頭に実測つきで書いてある）。
 * ⚠️ 昇格は road-builder の画面で1件ずつ。そこで `origin: "jartic"` が記録される。
 *
 * 使い方:
 *   node matchJarticToRegistered.js                  # 全県
 *   node matchJarticToRegistered.js --prefecture 東京都
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { decode } = require("./lib/polyline");
const { rankCandidates, TIERS } = require("./lib/restrictionRebuild");
const { ROMAJI } = require("./lib/prefectureRomaji");

const REG_DIR = path.join(__dirname, "data", "road-restrictions");
const CAND_DIR = path.join(__dirname, "data", "restriction-jartic");
const OUT_DIR = path.join(__dirname, "data", "restriction-rebuild");

const args = process.argv.slice(2);
const only = args.includes("--prefecture") ? args[args.indexOf("--prefecture") + 1] : null;

function candidatesByPrefecture() {
  const map = {};
  if (!fs.existsSync(CAND_DIR)) return map;
  for (const f of fs.readdirSync(CAND_DIR).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(CAND_DIR, f), "utf8"));
    map[j.prefecture] = (j.candidates || []).filter((c) => Array.isArray(c.points) && c.points.length);
  }
  return map;
}

function main() {
  const byPref = candidatesByPrefecture();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tally = { [TIERS.STRONG]: 0, [TIERS.REVIEW]: 0, [TIERS.NONE]: 0 };
  let total = 0;
  const perPrefecture = {};

  for (const file of fs.readdirSync(REG_DIR).filter((x) => x.endsWith(".json"))) {
    const json = JSON.parse(fs.readFileSync(path.join(REG_DIR, file), "utf8"));
    for (const r of json.restrictions || []) {
      // ⚠️ 販売できない出どころだけが対象。osm はそのまま売れる
      if (r.origin !== "jmpsa") continue;
      if (only && r.prefecture !== only) continue;
      total++;

      let points = [];
      try { points = decode(r.polyline || ""); } catch (e) { points = []; }
      const ranked = rankCandidates({ name: r.name, points }, byPref[r.prefecture] || []);
      const tier = ranked.length ? ranked[0].tier : TIERS.NONE;
      tally[tier]++;

      const pref = r.prefecture || "（県名なし）";
      (perPrefecture[pref] = perPrefecture[pref] || []).push({
        registered: { id: r.id, name: r.name, kind: r.kind, polyline: r.polyline,
                      minCc: r.minCc, maxCc: r.maxCc, prefecture: r.prefecture },
        tier,
        matches: ranked.map((m) => ({
          id: m.candidate.id,
          name: m.candidate.name || m.candidate.sourceRoad || null,
          note: m.candidate.note || null,
          reason: m.candidate.reason || null,
          minCc: m.candidate.minCc, maxCc: m.candidate.maxCc,
          activeDays: m.candidate.activeDays, activeHours: m.candidate.activeHours,
          forward: +m.forward.toFixed(2),
          backward: +m.backward.toFixed(2),
          nameAgrees: m.nameAgrees,
        })),
      });
    }
  }

  for (const [pref, items] of Object.entries(perPrefecture)) {
    const romaji = ROMAJI[pref] || "unknown";
    // 強い一致から先に出す（確認が速い順）
    items.sort((a, b) => (a.tier === TIERS.STRONG ? -1 : 1) - (b.tier === TIERS.STRONG ? -1 : 1));
    fs.writeFileSync(path.join(OUT_DIR, `${romaji}.json`),
      JSON.stringify({ prefecture: pref, romaji, builtAt: new Date().toISOString().slice(0, 10),
                       count: items.length, items }, null, 2) + "\n");
  }

  console.log(`二普協由来 ${total}件を突き合わせました → data/restriction-rebuild/`);
  console.log(`  ${TIERS.STRONG}: ${tally[TIERS.STRONG]}件   （名前も一致、または両方向で重なる）`);
  console.log(`  ${TIERS.REVIEW}: ${tally[TIERS.REVIEW]}件   （重なるが名前が違う。⚠️ 誤りが混ざる）`);
  console.log(`  ${TIERS.NONE}: ${tally[TIERS.NONE]}件   （JARTIC に見当たらない）`);
  console.log("\n⚠️ どれも自動では昇格しません。road-builder で1件ずつ確認すること。");
}

if (require.main === module) main();
