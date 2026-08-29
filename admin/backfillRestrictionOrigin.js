#!/usr/bin/env node
/**
 * backfillRestrictionOrigin.js
 *
 * 登録済みの規制に、**あとから出どころを書き戻す**（1回きりの作業）。
 *
 * 【なぜ要るか】
 * `lib/restrictionOrigin.js` を入れる前に登録した279件には `origin` が無く、
 * ⚠️ **記録が無いものは販売APIに載らない**ので、販売対象が0件のままになっている。
 * ただし **id の形に証拠が残っている**ので、その範囲だけ機械で埋め戻せる。
 *
 * 【id の形と、そう判断した根拠（すべて実測）】
 *   osm-<県>-<id>          → osm    145件。取り込み側が付けた前置き
 *   <県ローマ字>-<数字>      → jmpsa   16件。⚠️ **同じ id が `data/restriction-source`
 *                                    （二普協の下書き）にそのまま存在する**ことを確かめた
 *   manual-<県>-<時刻>      → jmpsa  118件。road-builder で人が引いたもの。
 *                                    ⚠️ **自前調査とは限らない。** 実測で
 *                                    **100/118 が二普協の下書きと道路名が一致**し、
 *                                    作成日（2026-08-15〜16）も連番のものと同じ。
 *                                    ⚠️ **安全側に倒して売らない。** 逆に振ると
 *                                    転用の許諾が無いデータを売ることになる。
 *
 * ⚠️ **`originFromId` に manual- を足さないこと。** これから人が一から引く規制は
 *    本当に自前調査（survey）でありうる。ここは**過去の279件だけ**の始末で、
 *    今後は road-builder が保存時に `origin` を記録する。
 *
 * ⚠️ **JARTIC への置き換えはここではやらない。** 実測で69件は地図上で重なる候補が
 *    見つかるが、「市道」に「首都圏中央連絡自動車道」が100%重なるような**明らかな
 *    誤りが混ざる**。1件ずつ人が見て決めること（`matchJarticToRegistered.js`）。
 *
 * 使い方:
 *   node backfillRestrictionOrigin.js            # 下見（何も書かない）
 *   node backfillRestrictionOrigin.js --write    # 書き込む
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { ORIGINS } = require("./lib/restrictionOrigin");

const DIR = path.join(__dirname, "data", "road-restrictions");
const DRAFT_DIR = path.join(__dirname, "data", "restriction-source");
const WRITE = process.argv.slice(2).includes("--write");

/** 二普協の下書きに実在する id。⚠️ 推測ではなく突き合わせで決める */
function draftIds() {
  const ids = new Set();
  if (!fs.existsSync(DRAFT_DIR)) return ids;
  for (const f of fs.readdirSync(DRAFT_DIR).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, f), "utf8"));
    for (const r of j.restrictions || []) if (r.id) ids.add(String(r.id));
  }
  return ids;
}

/**
 * 1件の出どころを決める。
 * ⚠️ **決められないものは null のまま返す。** 憶測で埋めない
 */
function decideOrigin(restriction, drafts) {
  const id = String((restriction && restriction.id) || "");
  if (id.startsWith("osm-")) return "osm";
  if (id.startsWith("jartic-")) return "jartic";
  // ⚠️ 下書きに実在する id だけ。形が似ているだけでは決めない
  if (drafts.has(id)) return "jmpsa";
  // ⚠️ 安全側。売らないほうに倒す（上の説明）
  if (/^manual-[a-z]+-\d+$/.test(id)) return "jmpsa";
  return null;
}

/** 県名が空のものを、ファイル名（ローマ字）から埋める */
function prefectureFromFile(file, romajiToName) {
  return romajiToName[path.basename(file, ".json")] || null;
}

function main() {
  const drafts = draftIds();
  const { ROMAJI } = require("./lib/prefectureRomaji");
  const romajiToName = {};
  for (const [name, romaji] of Object.entries(ROMAJI)) romajiToName[romaji] = name;

  const tally = {};
  let total = 0, filledOrigin = 0, filledPref = 0, changedFiles = 0;

  for (const file of fs.readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
    const full = path.join(DIR, file);
    const json = JSON.parse(fs.readFileSync(full, "utf8"));
    let touched = false;

    for (const r of json.restrictions || []) {
      total++;
      if (!r.origin) {
        const origin = decideOrigin(r, drafts);
        if (origin) {
          // ⚠️ 知らない値を書き込まない
          if (!ORIGINS.has(origin)) throw new Error(`知らない出どころ: ${origin}`);
          r.origin = origin;
          filledOrigin++;
          touched = true;
        }
      }
      if (!r.prefecture) {
        const pref = prefectureFromFile(file, romajiToName);
        if (pref) { r.prefecture = pref; filledPref++; touched = true; }
      }
      const key = r.origin || "（決められない）";
      tally[key] = (tally[key] || 0) + 1;
    }

    if (touched && WRITE) {
      fs.writeFileSync(full, JSON.stringify(json, null, 2) + "\n");
      changedFiles++;
    } else if (touched) {
      changedFiles++;
    }
  }

  console.log(WRITE ? "== 書き込みました ==" : "== 下見（--write で書き込む）==");
  console.log(`登録済み ${total}件 ／ 出どころを埋めた ${filledOrigin}件 ／ 県名を埋めた ${filledPref}件 ／ ファイル ${changedFiles}件`);
  console.log("\n== 埋めたあとの内訳 ==");
  const { SELLABLE_ORIGINS } = require("./lib/restrictionOrigin");
  let sellable = 0;
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    const mark = SELLABLE_ORIGINS.has(k) ? "販売可" : "販売不可";
    if (SELLABLE_ORIGINS.has(k)) sellable += v;
    console.log(`  ${String(v).padStart(4)}  ${k.padEnd(14)} ${mark}`);
  }
  console.log(`\n販売APIに載る規制: ${sellable}件`);
}

if (require.main === module) main();
module.exports = { decideOrigin, draftIds };
