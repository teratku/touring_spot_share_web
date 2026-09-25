/**
 * admin/lib/publishLog.js
 *
 * **本番へ配信した記録**（おすすめ道路・通行規制）。直近どれを配信したかを、調整ツールの
 * 「配信の記録」で確かめられるようにする（利用者の要望 2026-09-26）。
 *
 * 形: `admin/data/publish-log.jsonl`（1行に1件の JSON。追記だけ）。
 *
 * ⚠️ **書くのは配信する本体（`importRoadRecommend.js` / `importRestrictions.js`）。** 画面の窓口で
 *    書くと、手でコマンドを打って配信したものが記録に残らない。どちらから配信したかは `via` に入る
 *    （画面から呼ぶときは `PUBLISH_VIA=tool` を渡す）。
 * ⚠️ **書き込みに成功したものだけ書く。** 下見（--commit なし）や途中で落ちたものは書かない。
 * ⚠️ 記録が書けなくても配信は止めない（本番へは送り終わっている）。
 */
"use strict";
const fs = require("fs");
const path = require("path");

/** ⚠️ `PUBLISH_LOG_FILE` は確かめるとき用（本物の記録を汚さない） */
const FILE = process.env.PUBLISH_LOG_FILE || path.join(__dirname, "..", "data", "publish-log.jsonl");

/** 1件を書き足す。`at` は付けなければ今 */
function append(entry, file = FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = { at: new Date().toISOString(), via: process.env.PUBLISH_VIA || "cli", ...entry };
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    return true;
  } catch (e) {
    console.error(`⚠️ 配信の記録を書けませんでした（配信は済んでいます）: ${e.message}`);
    return false;
  }
}

/**
 * 新しい順に読む。壊れた行は飛ばす（途中で落ちて半端に書かれた行など）。
 * @returns {object[]}
 */
function read({ limit = 200 } = {}, file = FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 壊れた行 */ }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return rows.slice(0, limit);
}

/** 県ごとの最新（種類ごと）。`{ roads: {tochigi: row}, restrictions: {...} }` */
function latestByPrefecture(rows) {
  const out = { roads: {}, restrictions: {} };
  for (const r of rows) {   // 新しい順に来るので、最初に見たものが最新
    const bucket = out[r.kind];
    if (bucket && r.romaji && !bucket[r.romaji]) bucket[r.romaji] = r;
  }
  return out;
}

module.exports = { append, read, latestByPrefecture, FILE };
