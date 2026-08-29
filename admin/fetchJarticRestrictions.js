#!/usr/bin/env node
/**
 * fetchJarticRestrictions.js
 *
 * JARTIC の「交通規制情報」オープンデータから、**二輪が通れなくなる規制**を拾って
 * 登録候補を作る。出力は `admin/data/restriction-jartic/<romaji>.json`。
 *
 * 【なぜ要るか】
 * ⚠️ **曜日・時間つきの規制が、いままでどこからも取れなかった。**
 *    OSM の日本データに曜日は0件（神奈川0/223・大阪0/53）。二普協の一覧にも無い。
 *    JARTIC にはある。実測（2026年06月分）:
 *      大阪 155件（曜日つき11・時間つき14）「自二輪 22:00〜06:00 通行禁止」など
 *      新潟 109件（時間つき25）
 *      神奈川 21件（曜日つき1・時間つき10）
 *    いま手で登録できているのは全国279件（曜日つき33・時間つき48）なので、
 *    新潟は 1件 → 109件 になる。
 *
 * 【二普協との決定的な違い】
 * ⚠️ **JARTIC は配信してよい。** 利用規約 第2条「商用利用も可能です」、
 *    第6条で **CC BY 4.0 と互換**。条件は出典表示と、加工した旨の明記。
 *    二普協（`fetchRestrictions.js`）は「非営利ならリンク自由」だけで転用の許諾ではない。
 *    ⚠️ ただし **JARTIC が作ったかのように見せてはいけない**（規約に明記）。
 *
 * 【置き換えではない】
 * ⚠️ **公安委員会の交通規制しか入っていない。** 実測: 石川県は 46,628件中 **0件**。
 *    白山白川郷ホワイトロードの二輪通行止めは道路事業者が決めたもので、
 *    交通規制ではないため入らない。有料道路・林道の規制は従来どおり手で登録する。
 *
 * 【毎月消える】
 * ⚠️ **前月ぶんは取得できなくなる**（JARTIC のページに明記）。
 *    月初に取り込むこと。取り逃すとその月は永久に取れない。
 *
 * 使い方:
 *   node fetchJarticRestrictions.js --list                  # 何月ぶんが出ているか見る
 *   node fetchJarticRestrictions.js --prefecture 神奈川県
 *   node fetchJarticRestrictions.js --all                   # 47県（時間がかかる）
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROMAJI } = require("./lib/prefectureRomaji");
const { toCandidate } = require("./lib/jarticRestrictions");
const { roadsAtPoint } = require("./lib/roadsAtPoint");
const { encode: encodePolyline, simplify } = require("./lib/polyline");

const CATALOG = "https://www.jartic.or.jp/d/opendata/opendata.json";
const BASE = "https://www.jartic.or.jp/d/opendata";
/** 出典に載せるページ。⚠️ データの直リンクではなく、規約の載っているページを指すこと */
const SOURCE_PAGE = "https://www.jartic.or.jp/service/opendata/";
const OUT_DIR = path.join(__dirname, "data", "restriction-jartic");
/**
 * 月ごとの控え。
 *
 * ⚠️ **これが無いと「規制が解除された」ことを永久に検知できない。**
 *    JARTIC は前月ぶんを消すうえ、実測で
 *      意思決定廃止日   0.0%   （山梨24,100行・神奈川210,035行とも）
 *      データ更新日     0.0%
 *    ＝**解除されると印も付かずにファイルから消えるだけ**。
 *    新規は `意思決定改正日` で気づけるが、解除は**差分でしか分からない**。
 *    一度「二輪通行禁止」で登録した道が解除されると、おすすめから外れたまま
 *    戻らず、良い道を隠し続ける。
 *
 * ⚠️ **控えるのは候補JSONだけ。** 生CSVは47県で約363MB/月（年4.3GB）あり、
 *    大半は二輪と無関係な行（一時停止9,742件・横断歩道5,369件など）。
 *    候補なら 3.9MB/月（年47MB）で収まる。
 *    ⚠️ ただし候補は「二輪の通行止め」に絞った後なので、**後から絞り方を
 *       変えたくなっても遡れない**。そこは割り切っている。
 */
const HISTORY_DIR = path.join(OUT_DIR, "history");
const UA = "biketeilen-admin/1.0 (local tool; tourigspotshare@gmail.com)";
/** 1県ごとに空ける時間。相手のサーバーに負担をかけない */
const POLITE_DELAY_MS = 2000;
/** 道路名を引くときの探索半径。⚠️ 実測で3〜15mに乗っていたので、広げすぎない */
const NAME_RADIUS_METERS = 80;

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const LIST_ONLY = args.includes("--list");
const ALL = args.includes("--all");
const ONLY = argVal("--prefecture");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 「2026年06月」→「2026-06」。⚠️ 並べたときに順になる形にすること */
function monthKey(targetMonth) {
  const m = String(targetMonth || "").match(/(\d{4})年\s*(\d{1,2})月/);
  if (!m) return "unknown";
  return `${m[1]}-${String(m[2]).padStart(2, "0")}`;
}

/** 県コード R01〜R47 → 都道府県名。JARTIC の並びは全国地方公共団体コード順 */
const PREF_ORDER = Object.keys(ROMAJI);

async function fetchCatalog() {
  const res = await fetch(CATALOG, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`一覧が取れません: HTTP ${res.status}`);
  return res.json();
}

/**
 * ZIP を落として、中の CSV を UTF-8 の文字列で返す。
 *
 * ⚠️ **CSV は cp932（Shift-JIS）。** UTF-8 として読むと県名も規制名も化ける。
 * ⚠️ **ZIP 内のファイル名も cp932。** `unzip -p` にワイルドカードを渡して名前を避ける。
 */
async function fetchCsv(link) {
  const res = await fetch(BASE + link, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `jartic-${Date.now()}.zip`);
  fs.writeFileSync(tmp, buf);
  try {
    // ⚠️ 18MB 級になる県がある。既定の maxBuffer では足りない
    const out = execFileSync("/bin/sh",
      ["-c", `unzip -p ${JSON.stringify(tmp)} "*.csv" | iconv -f CP932 -t UTF-8`],
      { maxBuffer: 512 * 1024 * 1024 });
    return out.toString("utf8");
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** ⚠️ 値の中に読点が入る。素朴な split は使えない */
function splitCsvLine(line) {
  const out = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

/**
 * 道路名を手元のグリッドから当てる。
 * ⚠️ **JARTIC に道路名は入っていない**（実測: 路線名0% / 交差点名0% / 始終点0%）。
 *    地図で確かめる人に手がかりが無いと確認できないので、こちらで補う。
 *    ⚠️ 補ったものは**推定**。`nameSource: "grid"` を付けて、断定しないこと。
 */
async function resolveName(points) {
  const mid = points[Math.floor(points.length / 2)];
  try {
    const found = await roadsAtPoint(mid[1], mid[0], { radiusMeters: NAME_RADIUS_METERS });
    const roads = (found && found.roads) || [];
    const named = roads.filter((r) => r.name);
    if (!named.length) return null;
    named.sort((a, b) => (a.distanceMeters || 0) - (b.distanceMeters || 0));
    return { name: named[0].name, meters: Math.round(named[0].distanceMeters || 0) };
  } catch (e) {
    return null;
  }
}

async function buildPrefecture(prefecture, link, meta) {
  const csv = await fetchCsv(link);
  const lines = csv.split("\n");
  const head = splitCsvLine(lines[0]);
  const candidates = [];
  let rows = 0;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    rows++;
    const values = splitCsvLine(lines[i]);
    const row = {};
    head.forEach((h, j) => { row[h] = values[j]; });
    const c = toCandidate(row, { prefecture });
    if (c) candidates.push(c);
  }

  // 名前を当てる（件数が少ないので1件ずつでよい。実測で県あたり0〜155件）
  for (const c of candidates) {
    const hit = await resolveName(c.points);
    if (hit) { c.name = hit.name; c.nameSource = "grid"; c.nameDistanceMeters = hit.meters; }
    else { c.nameSource = null; }

    // ⚠️ **画面（road-builder の規制タブ）が読む欄に合わせること。**
    //    二普協・OSM の候補と同じ形にしておかないと、同じ一覧に並べられない
    c.chainPolyline = encodePolyline(simplify(c.points, 5));
    c.sourceRoad = c.name || "(名前が引けず)";
    c.matchedName = c.name || "";
    c.city = "";
    c.from = "";
    c.to = "";
    c.targetLabel = c.jartic.vehicles.join("・");
    // ⚠️ **JARTIC は「公安委員会の規制そのもの」。** OSM のタグより確かだが、
    //    区間の切れ目が道の単位とは限らないので、確認はやはり要る
    c.confidence = "JARTIC";
    c.reason = [
      c.jartic.kindName || "通行止め",
      c.activeHours ? `${c.activeHours.from}〜${c.activeHours.to}` : "終日",
      c.jartic.dayLabel || "",
      c.jartic.decidedAt ? `意思決定 ${c.jartic.decidedAt}` : "",
    ].filter(Boolean).join(" / ");
  }

  return {
    prefecture,
    romaji: ROMAJI[prefecture],
    // ⚠️ **出典は規約の求める形で持つこと。** 配信物にもこのまま載せる
    attribution: `出典：「交通規制情報」（公益財団法人日本道路交通情報センター）`
      + `（${SOURCE_PAGE}）（${new Date().toISOString().slice(0, 10)}に利用）を加工して作成`,
    sourceUrl: SOURCE_PAGE,
    targetMonth: meta.targetMonth,
    releaseDay: meta.releaseDay,
    fetchedAt: new Date().toISOString(),
    totalRows: rows,
    candidates,
  };
}

/**
 * 前の月と比べて、増えた規制と**消えた規制**を出す。
 *
 * ⚠️ **消えたほうが大事。** 新規は `意思決定改正日` で気づけるが、
 *    解除は差分でしか分からない（JARTIC は廃止の印を付けない）。
 *    解除された規制を登録したままにすると、走れる道を隠し続ける。
 */
function reportDiff(currentMonth) {
  if (!fs.existsSync(HISTORY_DIR)) return;
  const months = fs.readdirSync(HISTORY_DIR)
    .filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
  const previous = months.filter((m) => m < currentMonth).pop();
  if (!previous) {
    console.log(`\nℹ️ 前の月の控えがありません。次回から増減を出せます（いまの控え: ${currentMonth}）`);
    return;
  }

  const read = (month) => {
    const dir = path.join(HISTORY_DIR, month);
    const out = new Map();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        for (const c of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).candidates || []) {
          out.set(c.id, c);
        }
      } catch (e) { /* 壊れた県は飛ばす */ }
    }
    return out;
  };

  const before = read(previous);
  const after = read(currentMonth);
  const added = [...after.keys()].filter((id) => !before.has(id));
  const gone = [...before.keys()].filter((id) => !after.has(id));

  console.log(`\n${previous} → ${currentMonth} の増減`);
  console.log(`  増えた ${added.length}件 / 消えた ${gone.length}件`);
  if (gone.length) {
    console.log(`  ⚠️ **消えた規制は解除された可能性がある。** 登録済みなら外すか確かめること:`);
    for (const id of gone.slice(0, 20)) {
      const c = before.get(id);
      console.log(`     ${(c.name || "(名前なし)").padEnd(18)} ${c.prefecture}  ${c.reason || ""}`);
    }
    if (gone.length > 20) console.log(`     …ほか ${gone.length - 20}件`);
  }
}

(async () => {
  const catalog = await fetchCatalog();
  const typeD = catalog.find((g) => g.type === "typeD");
  if (!typeD) throw new Error("交通規制情報（typeD）が一覧にありません");

  console.log(`JARTIC 交通規制情報  対象 ${typeD.targetMonth} / 公開 ${typeD.releaseDay} / ${typeD.targetList.length}県`);
  console.log(`⚠️ 前月ぶんは取得できなくなります。月初に取り込むこと。`);

  const targets = typeD.targetList.map((t) => {
    const index = Number(String(t.id).replace(/^R/, "")) - 1;
    return { prefecture: PREF_ORDER[index], link: t.link };
  }).filter((t) => t.prefecture);

  if (LIST_ONLY) {
    for (const t of targets) console.log(`  ${t.prefecture}  ${t.link}`);
    return;
  }

  const chosen = ONLY ? targets.filter((t) => t.prefecture === ONLY) : (ALL ? targets : []);
  if (!chosen.length) {
    console.error("--prefecture <県名> か --all を指定してください（--list で一覧）");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  for (const [i, t] of chosen.entries()) {
    process.stdout.write(`  ${t.prefecture} … `);
    try {
      const built = await buildPrefecture(t.prefecture, t.link, typeD);
      const body = JSON.stringify(built, null, 2);
      fs.writeFileSync(path.join(OUT_DIR, `${built.romaji}.json`), body);
      // ⚠️ 月ごとの控えも残す（HISTORY_DIR の説明を読むこと）
      const monthDir = path.join(HISTORY_DIR, monthKey(built.targetMonth));
      fs.mkdirSync(monthDir, { recursive: true });
      fs.writeFileSync(path.join(monthDir, `${built.romaji}.json`), body);
      const withTime = built.candidates.filter((c) => c.activeHours).length;
      const withDay = built.candidates.filter((c) => c.activeDays || c.includesHoliday).length;
      const named = built.candidates.filter((c) => c.name).length;
      console.log(`${built.totalRows.toLocaleString()}行 → 候補${built.candidates.length}件`
        + `（時間つき${withTime} 曜日つき${withDay} 名前つき${named}）`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
    if (i < chosen.length - 1) await sleep(POLITE_DELAY_MS);
  }
  reportDiff(monthKey(typeD.targetMonth));
  console.log(`\n⚠️ そのまま配信しないこと。road-builder の規制タブで1件ずつ地図で確認して登録する。`);
})().catch((e) => { console.error(e); process.exit(1); });
