#!/usr/bin/env node
/**
 * buildRoadNames.js
 *
 * 道路グリッドCSVから「その地域にどんな名前の道路があるか」の一覧だけを作るバッチ。
 * 生成物は admin/data/road-names/<romaji>.json に出す。
 *
 * 【なぜジオメトリ抜きの一覧が要るのか】
 * 走破率とロードデックスの分母は、アプリ側（RoadCompletionCalculator.swift の KnownRoad）が
 * name / highway / roadCategory / prefecture の4項目しか見ておらず、**ジオメトリを一切使わない**。
 * それなのに現状は 212MB のグリッドCSV（93%が WKT ジオメトリ）を全部落とさないと
 * 分母が作れない構造になっている。
 *
 * 実測: 全国の異なる道路（name×種別）は 27,840件 = JSON で 1.71MB。
 *       現行グリッドの 0.81% しかない。
 *
 * これを別配信すれば、
 *   ・グリッド未ダウンロードでも走破率が出る
 *   ・海外は「まず名前一覧だけ」配れば図鑑と走破率が動く（初手が数百KBで済む）
 * ようになる。詳細は touringSpotShare/GLOBAL_OSM_DESIGN.md を参照。
 *
 * ⚠️ アプリ側はこれを**フォールバックとしてのみ**使う（手元にグリッドがあればそちらが優先）。
 *    常時マージすると既存ユーザーの分母が増えて走破率が下がり、不具合に見えるため。
 *
 * 【入力データについて】
 * グリッドCSVは2種類あり、**全国を覆っているのは grid_csvs_japan_empty の方**。
 *
 *   ~/Documents/grid_csvs_japan_empty  4,587件  緯度24.0〜45.5（全国）  列5つ・prefecture 無し
 *   ~/Downloads/python                 2,217件  緯度24.0〜36.0（西日本のみ）  列14・prefecture 有り
 *
 * ⚠️ prefecture 列がある方（Downloads/python）は**北緯36度以北が丸ごと無い**。
 *    北海道・東北・北関東（群馬/栃木）・北陸が落ちる。実測で確認済み。
 *    そのため全国版を使い、県は座標から PrefectureLocator（ポリゴン判定）で当てる。
 *    このライブラリはまさにこの用途のために作られている。
 *
 * 使い方:
 *   node buildRoadNames.js                      # 全国分を生成
 *   node buildRoadNames.js --prefecture 群馬県  # 1県だけ
 *   node buildRoadNames.js --input <dir>        # 入力ディレクトリを変える
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { listGridFiles, readGridFile, parseWkt } = require("./lib/roadCsv");
const { ROMAJI } = require("./lib/prefectureRomaji");
const { PrefectureLocator } = require("./lib/prefectureLocator");

// ---- 引数 ----
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const ONLY_PREFECTURE = argVal("--prefecture", null);
// 既定は全国を覆っている方。prefecture 列は無いので座標から当てる（冒頭の説明を参照）
const INPUT_DIR = argVal("--input", path.join(os.homedir(), "Documents", "grid_csvs_japan_empty"));
const OUT_DIR = path.join(__dirname, "data", "road-names");

/**
 * 集計対象の道路種別。
 * ⚠️ RoadCompletionCalculator.swift の targetHighwayTypes と同じにすること。
 *    ここがずれると、アプリが数える分母と配信する分母が食い違う。
 */
const TARGET_HIGHWAYS = new Set([
  "motorway", "motorway_link",
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
]);

/** _link は親に統合する（同じく Swift 側の highwayGroupMap と揃える） */
function groupOf(highway) {
  return highway.replace(/_link$/, "");
}

/** 名前が無い道路は分母に入れない（Swift 側と同じ除外条件） */
function isUsableName(name) {
  return name && name !== "Unnamed Road" && name !== "Unknown Road";
}

/**
 * グリッドCSVの prefecture 列を ROMAJI テーブルが引ける表記に揃える。
 *
 * ⚠️ 元データに表記ゆれがある。実測（2,217ファイル全走査）で
 *    「神奈川」20,934行 /「鹿児島」16,708行 /「和歌山」9,555行 の3県が
 *    **「県」抜き**で入っていた。そのままだとこの3県が丸ごと欠落する。
 *    OSM の生データ由来なので、上流を直すより受け側で吸収するほうが確実。
 */
function normalizePrefecture(raw) {
  if (!raw) return null;
  if (ROMAJI[raw]) return raw;
  for (const suffix of ["県", "府", "都"]) {
    if (ROMAJI[raw + suffix]) return raw + suffix;
  }
  return null;
}

async function main() {
  const files = listGridFiles(INPUT_DIR);
  if (!files.length) {
    console.error(`❌ グリッドCSVが見つかりません: ${INPUT_DIR}`);
    process.exit(1);
  }
  console.log(`📖 ${files.length} ファイルを走査します（${INPUT_DIR}）`);

  const locator = new PrefectureLocator();

  // 県 → Map<"name|highway", {n,h,c}>  で重複排除しながら集める
  const byPrefecture = new Map();
  let scanned = 0;
  let unlocated = 0;

  for (const file of files) {
    // ⚠️ readGridFile が渡すのは { get, header }。プレーンなオブジェクトではない
    await readGridFile(file, ({ get }) => {
      const highway = get("highway");
      if (!TARGET_HIGHWAYS.has(highway)) return;

      const name = get("name");
      if (!isUsableName(name)) return;

      // prefecture 列があればそれを使い（Downloads/python 形式）、
      // 無ければ座標から当てる（grid_csvs_japan_empty 形式）
      let prefecture = normalizePrefecture(get("prefecture"));
      if (!prefecture) {
        const points = parseWkt(get("geometry"));
        if (!points || !points.length) return;
        prefecture = locator.locatePolyline(points);
        if (!prefecture) { unlocated++; return; }
      }
      if (ONLY_PREFECTURE && prefecture !== ONLY_PREFECTURE) return;

      const group = groupOf(highway);
      const key = `${name}|${group}`;
      if (!byPrefecture.has(prefecture)) byPrefecture.set(prefecture, new Map());
      const bucket = byPrefecture.get(prefecture);
      if (!bucket.has(key)) {
        // road_category は全国版CSVに無い。分母の集計では使われないので空でよい
        bucket.set(key, { n: name, h: group, c: get("road_category") });
      }
    });
    scanned++;
    if (scanned % 500 === 0) console.log(`   ... ${scanned}/${files.length}`);
  }
  if (unlocated) {
    console.log(`ℹ️ 県を判定できなかった道路: ${unlocated.toLocaleString()} 件（離島・県境の間引き誤差など）`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const builtAt = new Date().toISOString();
  let totalRoads = 0;
  let totalBytes = 0;
  const summary = [];

  for (const [prefecture, bucket] of [...byPrefecture].sort()) {
    const romaji = ROMAJI[prefecture];
    if (!romaji) {
      console.warn(`⚠️ ローマ字が引けない県名なので飛ばします: ${prefecture}`);
      continue;
    }
    // 名前順に並べる。差分を見たときに読めるようにするため
    const roads = [...bucket.values()].sort((a, b) =>
      a.n === b.n ? a.h.localeCompare(b.h) : a.n.localeCompare(b.n, "ja"));

    const payload = {
      prefecture,
      romaji,
      generation: 1,
      builtAt,
      count: roads.length,
      roads,
    };
    const out = path.join(OUT_DIR, `${romaji}.json`);
    const json = JSON.stringify(payload);
    fs.writeFileSync(out, json);

    totalRoads += roads.length;
    totalBytes += Buffer.byteLength(json);
    summary.push({ prefecture, romaji, count: roads.length, kb: Buffer.byteLength(json) / 1024 });
  }

  summary.sort((a, b) => b.count - a.count);
  console.log("\n地域別（上位10）:");
  for (const s of summary.slice(0, 10)) {
    console.log(`  ${s.prefecture.padEnd(8)} ${String(s.count).padStart(6)} 件  ${s.kb.toFixed(1)} KB`);
  }
  console.log(`\n✅ ${summary.length} 地域 / 計 ${totalRoads.toLocaleString()} 件 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   出力先: ${OUT_DIR}`);

  // ⚠️ 元データが47都道府県を覆えていない。黙って欠けると
  //    「その県だけ走破率が出ない」という分かりにくい形で表面化するので、必ず出す。
  if (!ONLY_PREFECTURE) {
    const covered = new Set(summary.map((s) => s.prefecture));
    const missing = Object.keys(ROMAJI).filter((p) => !covered.has(p));
    if (missing.length) {
      console.log(`\n⚠️ グリッドCSVに道路が1件も無い県が ${missing.length} 件あります:`);
      console.log(`   ${missing.join(" / ")}`);
      console.log(`   → この県は走破率の分母が作れません。元データ側の欠落を確認してください。`);
    }
  }
}

main().catch((e) => {
  console.error("❌ 失敗:", e);
  process.exit(1);
});
