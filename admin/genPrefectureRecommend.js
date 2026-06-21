#!/usr/bin/env node
/**
 * genPrefectureRecommend.js
 * 各都道府県の「おすすめスポット」スタンプラリーJSONを一括生成（category="prefecture"）。
 *
 * 出典: data/prefecture-recommend/<romaji>.json（savePrefectureRecommend.js で生成 ＋ ビルダーで編集）。
 *   → ビルダーで磨いたおすすめがそのままラリーに反映される（一気通貫）。
 *
 * 出力: generated/prefecture-recommend-2026/<romaji>-recommend-2026.json
 * 投入: for f in generated/prefecture-recommend-2026/*.json; do node importRallies.js --file "$f"; done
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ROMAJI, REGION } = require("./lib/prefectures");

const FY = 2026;
const DATA_DIR = path.join(__dirname, "data", "prefecture-recommend");
const OUT_DIR = path.join(__dirname, "generated", `prefecture-recommend-${FY}`);
const MAX_TARGETS = 8; // 1ラリーの対象上限

function loadSpots(romaji) {
  const f = path.join(DATA_DIR, `${romaji}.json`);
  if (!fs.existsSync(f)) return [];
  try { return (JSON.parse(fs.readFileSync(f, "utf8")).spots) || []; } catch (_) { return []; }
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`❌ ${path.relative(__dirname, DATA_DIR)} がありません。先に node savePrefectureRecommend.js を実行してください。`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let count = 0;
  const empty = [];
  for (const pref of Object.keys(ROMAJI)) {
    const romaji = ROMAJI[pref];
    const spots = loadSpots(romaji).slice(0, MAX_TARGETS);
    if (!spots.length) { empty.push(pref); continue; }

    const targets = spots.map((s, i) => {
      const t = { targetId: `t${String(i + 1).padStart(2, "0")}`, name: s.name, lat: s.lat, lng: s.lng, order: i + 1 };
      if (s.address) t.address = s.address;
      if (s.spotId) t.spotId = s.spotId;
      if (s.imageURL) t.imageURL = s.imageURL;
      return t;
    });

    const rally = {
      _note: `県別おすすめラリー（${pref}）。data/prefecture-recommend/${romaji}.json から生成。座標は Nominatim 由来。targetIdは年度内固定。内容変更はビルダーで「おすすめ」を編集→再生成。`,
      rallyId: `pref-${romaji}-recommend-${FY}`,
      name: `${pref} おすすめスポット ${FY}`,
      theme: "recommend",
      category: "prefecture",
      prefecture: pref,
      region: REGION[pref] || "",
      description: `${pref}の人気観光スポットをめぐる通年チャレンジ。`,
      fiscalYear: FY,
      startAt: `${FY}-04-01T00:00:00+09:00`,
      endAt: `${FY + 1}-03-31T23:59:59+09:00`,
      rewardBadgeId: `badge_pref_${romaji}_recommend_${FY}`,
      completionTitle: `${pref} 名所めぐり ${FY}`,
      targets,
    };
    fs.writeFileSync(path.join(OUT_DIR, `${romaji}-recommend-${FY}.json`), JSON.stringify(rally, null, 2) + "\n");
    count++;
  }
  console.log(`✅ 生成 ${count} 件 → ${path.relative(__dirname, OUT_DIR)}/（出典: data/prefecture-recommend/）`);
  if (empty.length) console.log(`⚠️ おすすめが空のためスキップ: ${empty.join("、")}`);
  console.log(`投入: for f in generated/prefecture-recommend-${FY}/*.json; do node importRallies.js --file "$f"; done`);
}
main();
