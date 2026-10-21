#!/usr/bin/env node
/**
 * moveMisplacedAdded.js
 *
 * おすすめ道路の調整で、**別の県のファイルに入ってしまった足した道**を正しい県へ移す。
 *
 *   node moveMisplacedAdded.js          … 下見（何も書かない）
 *   node moveMisplacedAdded.js --apply  … data/road-overrides を書き換える
 *
 * 【なぜ要るか】調整ツールは開いた1県しか見えず、ほかの県の道を開いていた県に足してしまっていた
 *   （2026-10-21 利用者の報告。福島県に蔵王エコーライン、埼玉県に上野原丹波山線など）。利用者の判断「正しい都道府県にする」。
 * ⚠️ 書き換えるのは手元の調整ファイルだけ。配信には、移した元の県と移した先の県の**両方**を再生成して配信する
 *    （元の県から消えたことも、配信し直さないとアプリに残る）
 * ⚠️ 移した先で生成済みの道と重なる道は、移したあと調整ツールで確かめる（非表示にするか消すかは人が決める）
 */
"use strict";
const path = require("path");
const { PrefectureLocator } = require("./lib/prefectureLocator");
const { planMisplaced, applyMisplaced } = require("./lib/roadCrossPrefecture");

const apply = process.argv.includes("--apply");
const locator = new PrefectureLocator();
const dataDir = path.join(__dirname, "data");
const plan = planMisplaced(dataDir, (lng, lat) => locator.locate(lng, lat));
const pct = (v) => `${Math.round(v * 100)}%`;
if (!plan.length) { console.log("別の県に入っている足した道はありません"); process.exit(0); }
for (const p of plan) {
  const what = p.action === "move" ? `${p.from} → ${p.to}` : `${p.from} から外す（${p.to} に同じ道がある）`;
  console.log(`${what}  「${p.name}」（${p.toName}を${pct(p.share)}通る）`);
  for (const o of p.overlapsAfter) console.log(`    ⚠️ ${p.toName}の「${o.title || o.name}」と${pct(o.fraction)}重なる（${o.source === "added" ? "手で足した道" : "生成済み"}）`);
}
if (!apply) { console.log(`\n下見です（${plan.length}件）。書き換えるには --apply`); process.exit(0); }
const done = applyMisplaced(dataDir, plan);
const failed = done.filter((d) => !d.ok);
console.log(`\n${done.length - failed.length}件 書き換えました`);
for (const f of failed) console.log(`  できなかった: ${f.from}「${f.name}」 ${f.reason}`);
const touched = [...new Set(done.filter((d) => d.ok).flatMap((d) => d.action === "move" ? [d.from, d.to] : [d.from]))].sort();
console.log(`再生成して配信が要る県: ${touched.join(", ")}`);
