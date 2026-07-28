#!/usr/bin/env node
/**
 * buildRoadRecommend.js
 *
 * 道路グリッドCSVから「走って楽しい区間」を全国分まとめて作るバッチ。
 * 生成物は admin/data/road-recommend/<romaji>.json に出す。
 *
 * ⚠️ このスクリプトが「正」。アプリ側にも曲率計算が残っているが、
 *    そちらは配信が取れなかったときのフォールバック専用。
 *    2か所で同じ式を維持すると必ずずれるので、重みや閾値を変えるときはここだけを直す。
 *
 * 使い方:
 *   node buildRoadRecommend.js --audit                  # 元データの健全性を確認（まずこれ）
 *   node buildRoadRecommend.js --audit --limit 200      # 一部だけ見る（速い）
 *
 * 既定の入力は ~/Downloads/python（prefecture / city を持つ方）。
 * --input で別ディレクトリも指定できる。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseWkt, polylineLength, listGridFiles, readGridFile } = require("./lib/roadCsv");
const { PrefectureLocator } = require("./lib/prefectureLocator");
const { stitch } = require("./lib/roadStitcher");
const { extract, score } = require("./lib/funSegments");
const { simplify, encode } = require("./lib/polyline");

// ---- 引数 ----
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const AUDIT = args.includes("--audit");
const BUILD = args.includes("--build");
const ONLY_PREFECTURE = argVal("--prefecture", null);
const TOP = Number(argVal("--top", "150"));

/** 県名 → ローマ字。既存の data/prefecture-recommend/<romaji>.json と同じ綴りに合わせる */
const ROMAJI = {
  北海道: "hokkaido", 青森県: "aomori", 岩手県: "iwate", 宮城県: "miyagi", 秋田県: "akita",
  山形県: "yamagata", 福島県: "fukushima", 茨城県: "ibaraki", 栃木県: "tochigi", 群馬県: "gunma",
  埼玉県: "saitama", 千葉県: "chiba", 東京都: "tokyo", 神奈川県: "kanagawa", 新潟県: "niigata",
  富山県: "toyama", 石川県: "ishikawa", 福井県: "fukui", 山梨県: "yamanashi", 長野県: "nagano",
  岐阜県: "gifu", 静岡県: "shizuoka", 愛知県: "aichi", 三重県: "mie", 滋賀県: "shiga",
  京都府: "kyoto", 大阪府: "osaka", 兵庫県: "hyogo", 奈良県: "nara", 和歌山県: "wakayama",
  鳥取県: "tottori", 島根県: "shimane", 岡山県: "okayama", 広島県: "hiroshima", 山口県: "yamaguchi",
  徳島県: "tokushima", 香川県: "kagawa", 愛媛県: "ehime", 高知県: "kochi", 福岡県: "fukuoka",
  佐賀県: "saga", 長崎県: "nagasaki", 熊本県: "kumamoto", 大分県: "oita", 宮崎県: "miyazaki",
  鹿児島県: "kagoshima", 沖縄県: "okinawa",
};
const romaji = (pref) => ROMAJI[pref] || pref;

/**
 * 答え合わせ用の「正解リスト」。ツーリングで名の知れた道。
 * 上位に来ていなければ、重みか区間の切り出しが間違っている。
 *
 * ⚠️ OSM に載っている名前で書くこと。通称は入っていないことが多い。
 *    「椿ライン」「ヤビツ峠」「麦草峠」「金精道路」「霧降高原道路」はいずれも
 *    名前として存在しなかった（椿ラインは正式名の「湯河原箱根線」で9位に入っている）。
 *    通称で書くと、抜き出せているのに「❌ 抜き出せていない」と出て判断を誤る。
 */
const KNOWN = {
  栃木県: ["いろは坂", "もみじライン", "塩原矢板線", "鹿沼足尾線"],
  群馬県: ["草津", "志賀", "赤城", "榛名", "妙義"],
  長野県: ["ビーナス", "美ヶ原", "白樺"],
  神奈川県: ["湯河原箱根線", "芦ノ湖"],
  静岡県: ["西伊豆", "富士山スカイライン"],
  大分県: ["別府", "阿蘇"],
};
/**
 * 既定の入力は全国をカバーしている方。
 *
 * ⚠️ ~/Downloads/python は列が豊富（prefecture / city / road_category を持つ）が、
 *    緯度 24.0〜36.0度ぶんしか無い。北海道・東北・栃木・群馬・新潟・富山・石川が
 *    丸ごと欠けている（12県）。おすすめ道路の主役級が抜けるので使えない。
 *    grid_csvs_japan_empty は列が osm_id,name,highway,ref,geometry の5つだけだが
 *    緯度 24.0〜45.5度で全国そろっている。県は座標から自前で当てる。
 */
const DEFAULT_INPUT = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
const INPUT_DIR = path.resolve(argVal("--input", DEFAULT_INPUT));
const LIMIT = Number(argVal("--limit", "0")) || 0;

/**
 * 走って楽しい道の候補にする道種。
 *
 * ⚠️ trunk を外してはいけない。このデータでは国道の峠道が trunk になっており、
 *    第一いろは坂・第二いろは坂も trunk だった。除外していたせいで、
 *    栃木でいちばん有名な道が候補にすら上がっていなかった。
 *    交通量が多い幹線が混ざるぶんは CLASS_RANK（trunk=0.5）で下げる。
 *
 * motorway は高速・自動車専用なので入れない。
 */
const TARGET_HIGHWAYS = new Set(["primary", "secondary", "tertiary", "trunk"]);

const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

/**
 * CSV の prefecture 値を正式名に直す。
 *
 * ⚠️ CSV は「鹿児島」のように接尾辞（都/道/府/県）を落とした表記で入っている。
 *    そのまま47県表と突き合わせると全県が「欠けている」と出る。
 */
const PREFECTURE_BY_SHORT = (() => {
  const map = new Map();
  for (const full of PREFECTURES) {
    map.set(full, full);
    // 北海道は「北海」にしない
    if (full !== "北海道") map.set(full.replace(/[都府県]$/, ""), full);
  }
  return map;
})();

function normalizePrefecture(raw) {
  if (!raw) return null;
  return PREFECTURE_BY_SHORT.get(raw.trim()) || null;
}

// ---- 監査 ----

async function audit() {
  if (!fs.existsSync(INPUT_DIR)) {
    console.error(`入力ディレクトリが無い: ${INPUT_DIR}`);
    process.exit(1);
  }
  let files = listGridFiles(INPUT_DIR);
  if (LIMIT) files = files.slice(0, LIMIT);
  if (files.length === 0) {
    console.error(`roads_grid_*.csv が見つからない: ${INPUT_DIR}`);
    process.exit(1);
  }

  const locator = new PrefectureLocator();
  console.log(`入力: ${INPUT_DIR}`);
  console.log(`ファイル: ${files.length}件${LIMIT ? `（--limit ${LIMIT} で制限中）` : ""}`);
  console.log(`県境ポリゴン: ${locator.prefectureCount}県 / ${locator.shapes.length}枚\n`);

  const byPref = new Map();       // 県 → { files:Set, roads, targetRoads, meters }
  const highwayCount = new Map();  // highway → 件数
  const categoryCount = new Map(); // road_category → 件数
  const missing = { name: 0, prefecture: 0, geometry: 0, city: 0 };
  const unknownPref = new Map();   // 47県表に無い prefecture 値
  let totalRows = 0;
  let headerSeen = null;
  const started = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const base = path.basename(file);
    const header = await readGridFile(file, ({ get }) => {
      totalRows++;
      const highway = get("highway");
      const category = get("road_category");
      const name = get("name");
      const rawPref = get("prefecture");
      const city = get("city");
      const wkt = get("geometry");

      highwayCount.set(highway || "(空)", (highwayCount.get(highway || "(空)") || 0) + 1);
      categoryCount.set(category || "(空)", (categoryCount.get(category || "(空)") || 0) + 1);

      if (!name) missing.name++;
      if (!city) missing.city++;

      const points = parseWkt(wkt);
      if (!points) { missing.geometry++; return; }

      // CSV に prefecture があればそれを使い、無ければ座標から当てる
      let pref = normalizePrefecture(rawPref);
      if (!pref) {
        if (rawPref) unknownPref.set(rawPref, (unknownPref.get(rawPref) || 0) + 1);
        pref = locator.locatePolyline(points);
      }
      if (!pref) { missing.prefecture++; return; }
      let entry = byPref.get(pref);
      if (!entry) {
        entry = { files: new Set(), roads: 0, targetRoads: 0, meters: 0, targetMeters: 0 };
        byPref.set(pref, entry);
      }
      entry.files.add(base);
      entry.roads++;
      const meters = polylineLength(points);
      entry.meters += meters;
      if (TARGET_HIGHWAYS.has(highway)) {
        entry.targetRoads++;
        entry.targetMeters += meters;
      }
    });
    if (!headerSeen) headerSeen = header;
    if ((i + 1) % 250 === 0) {
      process.stderr.write(`  ${i + 1}/${files.length} ファイル…\r`);
    }
  }
  process.stderr.write("".padEnd(40) + "\r");

  console.log(`列: ${headerSeen.join(", ")}`);
  console.log(`行数: ${totalRows.toLocaleString()}  （${((Date.now() - started) / 1000).toFixed(1)}秒）\n`);

  // --- 県ごとのカバレッジ ---
  console.log("── 都道府県ごとのカバレッジ ──");
  console.log("県         グリッド    道路数   総延長km   対象道路   対象延長km");
  const found = [];
  const absent = [];
  for (const pref of PREFECTURES) {
    const e = byPref.get(pref);
    if (!e) { absent.push(pref); continue; }
    found.push(pref);
    console.log(
      pref.padEnd(9) +
      String(e.files.size).padStart(7) +
      String(e.roads).padStart(10) +
      (e.meters / 1000).toFixed(0).padStart(11) +
      String(e.targetRoads).padStart(11) +
      (e.targetMeters / 1000).toFixed(0).padStart(12)
    );
  }
  console.log(`\n収録: ${found.length}/47 県`);
  if (absent.length) {
    console.log(`⚠️ データが無い県 (${absent.length}): ${absent.join("、")}`);
  }
  if (unknownPref.size) {
    const list = [...unknownPref.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`⚠️ 47県に当てられなかった prefecture 値 (${unknownPref.size}種): ` +
                list.map(([k, v]) => `${k}(${v})`).join("、"));
  }

  // --- highway の分布 ---
  console.log("\n── highway の分布 ──");
  const highways = [...highwayCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, count] of highways.slice(0, 20)) {
    const mark = TARGET_HIGHWAYS.has(key) ? " ← 対象" : "";
    console.log(`  ${key.padEnd(20)} ${String(count).padStart(9)}  ${(count / totalRows * 100).toFixed(1)}%${mark}`);
  }
  if (highways.length > 20) console.log(`  …他 ${highways.length - 20} 種類`);

  // --- road_category の実値（設計書で未確認だった項目）---
  console.log("\n── road_category の実値 ──");
  const categories = [...categoryCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, count] of categories.slice(0, 15)) {
    console.log(`  ${key.padEnd(20)} ${String(count).padStart(9)}  ${(count / totalRows * 100).toFixed(1)}%`);
  }

  // --- 欠損 ---
  console.log("\n── 欠損率 ──");
  for (const [key, count] of Object.entries(missing)) {
    console.log(`  ${key.padEnd(12)} ${String(count).padStart(9)}  ${(count / totalRows * 100).toFixed(1)}%`);
  }

  console.log("\n── 県の判定内訳 ──");
  const st = locator.stats;
  const totalLocate = st.hits + st.cacheHits + st.nearby + st.boxed + st.misses;
  if (totalLocate > 0) {
    console.log(`  ポリゴン内     ${String(st.hits + st.cacheHits).padStart(9)}  ${((st.hits + st.cacheHits) / totalLocate * 100).toFixed(1)}%`);
    console.log(`  近傍で補完     ${String(st.nearby).padStart(9)}  ${(st.nearby / totalLocate * 100).toFixed(1)}%  ← 海沿い`);
    console.log(`  矩形で補完     ${String(st.boxed).padStart(9)}  ${(st.boxed / totalLocate * 100).toFixed(1)}%  ← 離島`);
    console.log(`  当てられず     ${String(st.misses).padStart(9)}  ${(st.misses / totalLocate * 100).toFixed(1)}%`);
  }

  console.log("\n判定:");
  if (absent.length === 0) {
    console.log("  ✅ 47県すべてにデータがある。このまま区間切り出しへ進める");
  } else {
    console.log(`  ❌ ${absent.length}県が欠けている: ${absent.join("、")}`);
  }
}

// ---- 生成 ----

/**
 * 区間ポリラインの間引き。
 *
 * ⚠️ 粗くしすぎると峠の形が消える。100m で間引いたら1区間あたり平均11点まで落ち、
 *    復号した線の長さが実際より最大 38.6% 短くなった（＝カーブを直線で突っ切る）。
 *    地図に描くと道から外れて見える。
 *    実測（栃木県・150区間）:
 *      100m → 平均11点 / 長さ誤差 38.6% / 59KB
 *       50m → 平均19点 / 長さ誤差 18.2% / 63KB
 *       20m → 平均35点 / 長さ誤差  5.6% / 71KB
 *       10m → 平均52点 / 長さ誤差  5%未満 / 80KB   ← これを使う
 *    1県 80KB なら全国で 3.5MB 程度。上限（300KB/県）には十分収まる。
 */
const OUTPUT_TOLERANCE_METERS = 10;

async function build() {
  const locator = new PrefectureLocator();
  let files = listGridFiles(INPUT_DIR);
  if (LIMIT) files = files.slice(0, LIMIT);

  console.log(`入力: ${INPUT_DIR}（${files.length}ファイル）`);
  if (ONLY_PREFECTURE) console.log(`対象: ${ONLY_PREFECTURE} のみ`);

  // 県ごとに断片を集める。全国を一度に持つとメモリが厳しいので、
  // 対象県が指定されていればそれ以外は捨てる
  const fragmentsByPref = new Map();
  let read = 0;
  const started = Date.now();
  for (const file of files) {
    await readGridFile(file, ({ get }) => {
      const highway = get("highway");
      if (!TARGET_HIGHWAYS.has(highway)) return;
      const name = get("name");
      if (!name) return;
      const points = parseWkt(get("geometry"));
      if (!points) return;
      const pref = normalizePrefecture(get("prefecture")) || locator.locatePolyline(points);
      if (!pref) return;
      if (ONLY_PREFECTURE && pref !== ONLY_PREFECTURE) return;
      let list = fragmentsByPref.get(pref);
      if (!list) { list = []; fragmentsByPref.set(pref, list); }
      list.push({ prefecture: pref, name, ref: get("ref"), highway, osmId: get("osm_id"), points });
    });
    if (++read % 500 === 0) process.stderr.write(`  読み込み ${read}/${files.length}\r`);
  }
  process.stderr.write("".padEnd(40) + "\r");
  console.log(`読み込み完了（${((Date.now() - started) / 1000).toFixed(1)}秒）\n`);

  const outDir = path.join(__dirname, "data", "road-recommend");
  fs.mkdirSync(outDir, { recursive: true });

  const summary = [];
  for (const [pref, fragments] of [...fragmentsByPref.entries()].sort()) {
    const chains = stitch(fragments);
    const segments = [];
    for (const chain of chains) {
      for (const seg of extract(chain.points)) {
        const { score: value, signals } = score(seg, chain.highway);
        const thinned = simplify(seg.points, OUTPUT_TOLERANCE_METERS);
        segments.push({
          name: chain.name,
          ref: chain.ref,
          highway: chain.highway,
          lengthKm: Number((seg.lengthMeters / 1000).toFixed(2)),
          curviness: Number(seg.curviness.toFixed(1)),
          flow: Number(seg.flow.toFixed(1)),
          turnCount: seg.turnCount,
          score: Number(value.toFixed(1)),
          signals,
          polyline: encode(thinned),
          pointCount: thinned.length,
          start: [Number(seg.points[0][1].toFixed(6)), Number(seg.points[0][0].toFixed(6))],
          end: [Number(seg.points[seg.points.length - 1][1].toFixed(6)),
                Number(seg.points[seg.points.length - 1][0].toFixed(6))],
        });
      }
    }
    segments.sort((a, b) => b.score - a.score);
    const top = segments.slice(0, TOP).map((s, i) => ({ id: `${pref}:${i}`, ...s }));
    summary.push({ pref, chains: chains.length, segments: segments.length, kept: top.length,
                   list: top, all: segments });
  }

  // 生成物を書き出す（配信はこのあと別スクリプトで行う）
  for (const row of summary) {
    const file = path.join(outDir, `${romaji(row.pref)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      prefecture: row.pref, romaji: romaji(row.pref), generation: 1,
      builtAt: new Date().toISOString(),
      weights: require("./lib/funSegments").WEIGHTS,
      count: row.list.length,
      segments: row.list.map(({ signals, ...rest }) => rest),
    }, null, 1) + "\n");
  }

  console.log("県          断片→連結    区間数   採用   最高点   出力KB");
  for (const row of summary) {
    const json = JSON.stringify({ prefecture: row.pref, count: row.list.length, segments: row.list });
    console.log(
      row.pref.padEnd(10) + String(row.chains).padStart(9) +
      String(row.segments).padStart(9) + String(row.kept).padStart(7) +
      (row.list[0]?.score ?? 0).toFixed(1).padStart(9) +
      (json.length / 1024).toFixed(0).padStart(9)
    );
  }

  // 信号の分布。正規化の基準値がここと合っていないと点数が振り切れて順位がつかない
  console.log("\n── 抜き出した区間の分布（正規化の基準を決めるのに使う）──");
  const all = summary.flatMap((r) => r.all);
  const pct = (values, p) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 0;
  for (const key of ["curviness", "flow", "lengthKm", "score"]) {
    const values = all.map((s) => s[key]).sort((a, b) => a - b);
    console.log(`  ${key.padEnd(10)} 中央 ${pct(values, 0.5).toFixed(1).padStart(7)}` +
                `  75% ${pct(values, 0.75).toFixed(1).padStart(7)}` +
                `  90% ${pct(values, 0.90).toFixed(1).padStart(7)}` +
                `  99% ${pct(values, 0.99).toFixed(1).padStart(7)}` +
                `  最大 ${pct(values, 1).toFixed(1).padStart(7)}`);
  }
  const { NORMALIZERS } = require("./lib/funSegments");
  for (const [key, base] of Object.entries(NORMALIZERS)) {
    const field = key === "length" ? "lengthKm" : key;
    const scale = key === "length" ? 1000 : 1;
    const values = all.map((s) => s[field] * scale).sort((a, b) => a - b);
    const saturated = values.filter((v) => v >= base).length;
    console.log(`  基準 ${key.padEnd(9)} ${String(base).padStart(6)} → 振り切れ ${(saturated / values.length * 100).toFixed(1)}%`);
  }

  // 既知の道での答え合わせ
  console.log("\n── 既知の道の順位 ──");
  for (const row of summary) {
    if (!KNOWN[row.pref]) continue;
    const list = row.all;
    for (const known of KNOWN[row.pref]) {
      const hits = list.map((s, i) => ({ ...s, rank: i + 1 }))
                       .filter((s) => s.name.includes(known));
      if (hits.length === 0) { console.log(`  ❌ ${row.pref} ${known}: 抜き出せていない`); continue; }
      const best = hits[0];
      const mark = best.rank <= 30 ? "✅" : best.rank <= TOP ? "△" : "❌";
      console.log(`  ${mark} ${row.pref.padEnd(8)}${known.padEnd(12)} ${String(best.rank).padStart(4)}位 / ${list.length}中` +
                  `  点数${best.score.toFixed(1)} ${best.lengthKm.toFixed(1)}km 曲率${best.curviness.toFixed(0)}`);
    }
  }

  // 上位を目視できるように出す（多すぎるので指定県か既知リストのある県だけ）
  for (const row of summary) {
    if (!ONLY_PREFECTURE && !KNOWN[row.pref]) continue;
    console.log(`\n── ${row.pref} の上位20 ──`);
    console.log("  点数  長さ   曲率  flow  道路名");
    for (const s of row.list.slice(0, 20)) {
      console.log(`  ${s.score.toFixed(1).padStart(4)} ${s.lengthKm.toFixed(1).padStart(5)}km ` +
                  `${s.curviness.toFixed(0).padStart(5)} ${s.flow.toFixed(1).padStart(5)}  ${s.name}`);
    }
  }
}

// ---- 入口 ----
(async () => {
  if (AUDIT) { await audit(); return; }
  if (BUILD) { await build(); return; }
  console.log("使い方:");
  console.log("  node buildRoadRecommend.js --audit                      元データの確認");
  console.log("  node buildRoadRecommend.js --build --prefecture 群馬県   1県だけ生成して確認");
})().catch((e) => { console.error(e); process.exit(1); });
