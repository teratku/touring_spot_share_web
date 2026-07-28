#!/usr/bin/env node
/**
 * fetchRestrictions.js
 *
 * 二輪車通行規制区間の一覧を取り込んで、開発者が確認・登録するための下書きを作る。
 *
 * 出どころ: 日本二輪車普及安全協会（二普協）
 *   https://www.jmpsa.or.jp/society/roadinfo/
 *   都道府県警察から提供された情報を、二普協が都道府県別にまとめて公開している。
 *
 * ⚠️ ここで作るのは**開発者の下書き**であって配信物ではない。
 *    二普協の規約に書かれているのは「非営利目的ならリンク自由」で、データ転用の許諾ではない。
 *    本アプリは有料プランを持つため、一覧をそのまま配信するのは避ける。
 *    配信するのは、この下書きをもとに開発者が確認して作った**自前の区間形状＋規制の事実**とし、
 *    出典を明記する。交通規制そのものは公的な事実だが、編集された一覧の丸写しは別問題。
 *
 * ⚠️ 相手のサーバーに負担をかけないこと。1ページごとに間隔を空け、User-Agent を明示する。
 *
 * 使い方:
 *   node fetchRestrictions.js --list                    # 都道府県ページの一覧だけ確認
 *   node fetchRestrictions.js --prefecture 栃木県        # 1県だけ取り込む
 *   node fetchRestrictions.js --all                     # 全県（時間がかかる）
 *   node fetchRestrictions.js --all --diff              # 前回と比べて増減を出す
 */
"use strict";

const fs = require("fs");
const path = require("path");

const BASE = "https://www.jmpsa.or.jp/society/roadinfo/";
const AREA_PAGES = ["area-119.html", "area-120.html"];   // 東日本 / 西日本
const OUT_DIR = path.join(__dirname, "data", "restriction-source");
const UA = "biketeilen-admin/1.0 (local tool; tourigspotshare@gmail.com)";
/** 1ページごとに空ける時間。相手のサーバーに負担をかけない */
const POLITE_DELAY_MS = 1500;

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const LIST_ONLY = args.includes("--list");
const ALL = args.includes("--all");
const DIFF = args.includes("--diff");
const ONLY = argVal("--prefecture");

const { ROMAJI } = require("./lib/prefectureRomaji");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

/** タグを落として本文だけにする */
function text(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
}

/** エリアページから 都道府県名 → URL を拾う */
function parseAreaIndex(html) {
  const found = new Map();
  const re = /<a[^>]+href="([^"]*area-1(?:19|20)-\d+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const label = text(m[2]).replace(/\s+/g, "");
    const name = Object.keys(ROMAJI).find((n) => label.includes(n) || label.includes(n.replace(/[都道府県]$/, "")));
    if (!name || found.has(name)) continue;
    found.set(name, new URL(m[1], BASE).href);
  }
  return found;
}

/**
 * 都道府県ページの表を読む。
 * 列は 所在地・道路名 / 所在地・規制区間 / 規制対象 / 規制時間。
 * 1列目は「宇都宮市・国道408号」のように市町村と道路名が中黒で繋がっている。
 */
function parsePrefecturePage(html, prefecture) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1]);
    if (cells.length < 4) continue;
    // 見出し行を飛ばす
    if (/<th/i.test(m[1])) continue;

    const head = text(cells[0]).split("\n").filter((l) => !l.includes("ご要望"));
    const where = head[0] || "";
    const [city, road] = splitCityRoad(where);
    const section = text(cells[1]);
    const target = text(cells[2]).replace(/\s+/g, "");
    const time = text(cells[3]).replace(/\s+/g, "");
    if (!road && !section) continue;

    const [from, to] = section.split("\n");
    // 1列目に道路名が無ければ、区間の説明文から拾う
    const roadsFromSection = extractRoadNames(section);
    const roadName = road || roadsFromSection[0] || "";

    rows.push({
      id: `${ROMAJI[prefecture]}-${rows.length + 1}`,
      prefecture, city, road: roadName,
      // 説明文から拾えた候補も残す（1本に絞れないことがある）
      roadCandidates: roadsFromSection,
      from: (from || "").replace(/[～〜]$/, "").trim(),
      to: (to || "").trim(),
      target,
      appliesTo: classifyTarget(target),
      time,
      rawSection: section.replace(/\n/g, "～"),
    });
  }
  return rows;
}

/**
 * 1列目を市町村と道路名に分ける。
 *
 * ⚠️ 書式が県によって違う。統一されていない。
 *    栃木「宇都宮市・国道408号」… 市町村・道路名
 *    大阪「茨木市」            … 市町村だけ。道路名は区間の説明文の中にある
 *      （例: 「…（府道茨木摂津線高架部の本線車道に限る。）」）
 *    そのため、1列目に道路名が無ければ区間の説明から拾い直す。
 */
function splitCityRoad(value) {
  const i = value.indexOf("・");
  if (i >= 0) {
    const left = value.slice(0, i).trim();
    const right = value.slice(i + 1).trim();
    // 「大阪市・北区」のように両方が地名のこともある
    if (looksLikeRoad(right)) return [left, right];
    return [value.trim(), ""];
  }
  return looksLikeRoad(value) ? ["", value.trim()] : [value.trim(), ""];
}

/**
 * 道路名らしいか。市町村名と見分けるために使う。
 *
 * ⚠️ 道路名の語尾を並べて判定してはいけない。取りこぼす。
 *    「白山白川郷ホワイトロード」「名古屋港管理組合道路（臨港道路一洲町線）」
 *    「無名道路（野並人道橋）」はどれも道路名だが、語尾の列挙では拾えず
 *    市町村名として捨てていた（190件が「道路名なし」扱いになっていた）。
 *
 * そこで逆に判定する。**市区町村名で終わっていなければ道路名とみなす。**
 * 市町村名は必ず 市／区／町／村／郡 で終わるので、こちらの方が漏れない。
 */
function looksLikeRoad(value) {
  const v = value.replace(/[（(][^）)]*[）)]\s*$/, "").trim();   // 末尾の括弧書きを外して見る
  if (!v) return false;
  if (/^(国道|県道|府道|都道|道道|市道|町道|村道|主要地方道)/.test(v)) return true;
  if (/[市区町村郡]$/.test(v)) return false;   // 市区町村名で終わるものは地名
  return true;
}

/**
 * 区間の説明文から道路名を拾う。
 * 大阪のように1列目が市町村だけの県で使う。
 */
function extractRoadNames(section) {
  const found = new Set();
  const patterns = [
    /(?:国道|県道|府道|都道|道道|市道|町道|村道)[^\s、。（）()「」]{0,12}?\d+号(?:バイパス|旧道|新道)?/g,
    /(?:国道|県道|府道|都道|道道|市道|町道|村道)[一-龥ぁ-んァ-ヶA-Za-z0-9]{2,12}線/g,
    /[一-龥ぁ-んァ-ヶ]{2,10}(?:バイパス|ハイウェイ|ライン|有料道路|スカイライン)/g,
    /[一-龥ぁ-んァ-ヶ]{2,10}(?:大橋|高架橋|トンネル)/g,
  ];
  for (const re of patterns) {
    for (const m of section.matchAll(re)) found.add(m[0]);
  }
  return [...found];
}

/**
 * 規制対象を、こちらの区分に落とす。
 *
 * ⚠️ ここを取り違えると誤警告になる。「原付・自動二輪（125cc以下）」の規制で
 *    大型に乗っている人へ警告を出しても意味がなく、警告が信用されなくなる。
 *
 * 実際に出てくる表記（栃木の13件で確認）:
 *   「原付・自動二輪（125cc以下）」 … 125cc以下だけ通行禁止
 *   「原付・自動二輪」            … 二輪全部
 *   「一般原付」                 … 原付一種だけ
 */
function classifyTarget(target) {
  const t = target.replace(/\s+/g, "");
  if (/125cc以下|125以下|小型二輪以下/.test(t)) return "under125";
  if (/一般原付|原動機付自転車のみ|第一種/.test(t) && !/自動二輪/.test(t)) return "moped";
  if (/自動二輪|二輪の自動車|二輪車/.test(t)) return "all";
  if (/原付|原動機付自転車/.test(t)) return "moped";
  return "unknown";
}

// ---- 取り込み ----

async function loadIndex() {
  const all = new Map();
  for (const page of AREA_PAGES) {
    const html = await get(BASE + page);
    for (const [name, url] of parseAreaIndex(html)) all.set(name, url);
    await sleep(POLITE_DELAY_MS);
  }
  return all;
}

async function main() {
  const index = await loadIndex();
  console.log(`二普協の都道府県ページ: ${index.size}件`);
  if (LIST_ONLY) {
    for (const [name, url] of [...index].sort()) console.log(`  ${name.padEnd(6)} ${url}`);
    const missing = Object.keys(ROMAJI).filter((n) => !index.has(n));
    if (missing.length) console.log(`\n掲載の無い県（規制ゼロか未掲載）: ${missing.join("、")}`);
    return;
  }

  const targets = ONLY ? [ONLY] : ALL ? [...index.keys()] : [];
  if (!targets.length) {
    console.error("--prefecture <県名> か --all を指定してください（--list で一覧）");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = [];
  for (const prefecture of targets) {
    const url = index.get(prefecture);
    if (!url) { console.log(`  ⚠️ ${prefecture}: ページが無い（規制ゼロか未掲載）`); continue; }
    const html = await get(url);
    const rows = parsePrefecturePage(html, prefecture);
    const file = path.join(OUT_DIR, `${ROMAJI[prefecture]}.json`);

    let previous = null;
    if (DIFF && fs.existsSync(file)) {
      try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 壊れていたら無視 */ }
    }

    fs.writeFileSync(file, JSON.stringify({
      prefecture, romaji: ROMAJI[prefecture], source: url,
      fetchedAt: new Date().toISOString(), count: rows.length, restrictions: rows,
    }, null, 1) + "\n");

    const kinds = rows.reduce((acc, r) => { acc[r.appliesTo] = (acc[r.appliesTo] || 0) + 1; return acc; }, {});
    summary.push({ prefecture, count: rows.length, kinds });
    console.log(`  ${prefecture.padEnd(6)} ${String(rows.length).padStart(3)}件  ${JSON.stringify(kinds)}`);

    if (previous) reportDiff(prefecture, previous.restrictions || [], rows);
    await sleep(POLITE_DELAY_MS);
  }

  const total = summary.reduce((a, s) => a + s.count, 0);
  const kinds = summary.reduce((acc, s) => {
    for (const [k, v] of Object.entries(s.kinds)) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});
  console.log(`\n合計 ${total}件`);
  console.log(`  対象別: ${JSON.stringify(kinds)}`);
  console.log(`  under125 … 排気量設定（BikeProfile）で拾える可能性がある`);
  console.log(`  all/moped … 個別に登録が要る`);
}

/**
 * 前回との差分。
 *
 * ⚠️ 消えた規制を自動で削除してはいけない。解除されたのか、
 *    掲載の仕方が変わっただけなのか、ここでは判別できない。
 *    誤って消すと「通れる」と誤案内することになるので、外すのは人の判断で行う。
 */
function reportDiff(prefecture, before, after) {
  const key = (r) => `${r.road}|${r.from}|${r.to}`;
  const beforeMap = new Map(before.map((r) => [key(r), r]));
  const afterMap = new Map(after.map((r) => [key(r), r]));
  const added = [...afterMap.keys()].filter((k) => !beforeMap.has(k));
  const removed = [...beforeMap.keys()].filter((k) => !afterMap.has(k));
  const changed = [...afterMap.entries()].filter(([k, r]) => {
    const b = beforeMap.get(k);
    return b && (b.target !== r.target || b.time !== r.time);
  });
  if (!added.length && !removed.length && !changed.length) return;
  console.log(`    ── ${prefecture} の変化 ──`);
  for (const k of added)   console.log(`      ＋ 増えた: ${k}`);
  for (const k of removed) console.log(`      － 消えた: ${k}  ← 解除された可能性。確認して手で外すこと`);
  for (const [k] of changed) console.log(`      ± 内容が変わった: ${k}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
