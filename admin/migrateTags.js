#!/usr/bin/env node
/**
 * migrateTags.js
 *
 * 手で付けた札（`data/road-overrides/*.json` の `tags`）を、日本語から鍵に直す。
 *
 * 【なぜ要るか】
 * 札は配信データに入り、アプリで音声案内にそのまま乗る
 * （`NavigationEngine.swift:362`）。日本語のまま配ると海外で日本語が読み上げられる。
 * 実測で 1,281件／12県、語彙は7語だけ。**小さいうちに変える。**
 *
 * 【安全のしかた】
 * ⚠️ **既定は下見だけ（書き換えない）。** `--write` を付けて初めて書く。
 * ⚠️ **書く前に控えを取る**（`*.json.bak`）。取れなければ書かない。
 * ⚠️ **二度掛けても壊れない**（鍵はそのまま鍵として返る）。
 * ⚠️ **件数が変わったら書かない。** 変換で札が消えるのがいちばん怖い。
 *
 * 使い方:
 *   node migrateTags.js            # 下見（何がどう変わるか）
 *   node migrateTags.js --write    # 実際に書き換える
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { toKeys, isTagKey } = require("./lib/roadTags");

const DIR = path.join(__dirname, "data", "road-overrides");
const write = process.argv.includes("--write");

function main() {
  if (!fs.existsSync(DIR)) {
    console.log(`  ${DIR} がありません`);
    return 1;
  }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
  let before = 0, after = 0, changedFiles = 0;
  const unknown = new Map();
  const plan = [];

  for (const f of files) {
    const full = path.join(DIR, f);
    const json = JSON.parse(fs.readFileSync(full, "utf8"));
    let touched = 0;
    // ⚠️ **`added`（手で足した道）も忘れないこと。** 最初 `overrides` だけ直して、
    //    配信データに日本語が2件残った（ぐるり富士山風景街道）。
    //    札を持つ入れ物が増えたら、ここに足す
    for (const bucket of ["overrides", "added"]) {
      for (const o of Object.values(json[bucket] || {})) {
        if (!Array.isArray(o.tags) || !o.tags.length) continue;
        before += o.tags.length;
        const next = toKeys(o.tags);
        after += next.length;
        for (const t of next) if (!isTagKey(t)) unknown.set(t, (unknown.get(t) || 0) + 1);
        if (next.join("|") !== o.tags.join("|")) { o.tags = next; touched++; }
      }
    }
    if (touched) { changedFiles++; plan.push({ f, touched, json, full }); }
  }

  console.log(`  札 ${before}件 → ${after}件   直す区間 ${plan.reduce((n, p) => n + p.touched, 0)}件 / ${changedFiles}ファイル`);
  if (unknown.size) {
    console.log(`  ⚠️ 鍵にならなかった札（そのまま残ります）: `
      + [...unknown.entries()].map(([t, n]) => `${t}(${n})`).join(" "));
  }

  // ⚠️ **数が減ったら書かない。** 変換で札が消えるのがいちばん怖い
  if (after !== before) {
    console.log(`  ✗ 件数が変わっています（${before} → ${after}）。書きません`);
    return 2;
  }

  if (!write) {
    console.log("  下見だけです。書き換えるには --write を付けてください");
    return 0;
  }

  for (const { f, json, full } of plan) {
    // ⚠️ 控えが取れなければ書かない
    const bak = full + ".bak";
    fs.copyFileSync(full, bak);
    if (!fs.existsSync(bak)) { console.log(`  ✗ ${f} の控えを取れません。中止`); return 2; }
    fs.writeFileSync(full, JSON.stringify(json, null, 1) + "\n");
    console.log(`  ✅ ${f}（控え: ${path.basename(bak)}）`);
  }
  console.log(`\n  書き換えました。次は buildRoadRecommend.js で作り直してください`);
  return 0;
}

process.exit(main());
