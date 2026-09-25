#!/usr/bin/env node
/**
 * buildJarticMopedTurns.js
 *
 * JARTIC の「交通規制情報」から、**原付の右折方法の標識**（二段階・小回り）と**信号**を全国ぶん抜き出す。
 * 出力:
 *   admin/data/jartic-moped-turns.json  … 標識（`lib/mopedTurnRules.js` が読む）
 *   admin/data/jartic-signals.bin       … 信号（`lib/trafficSignals.js` と同じ形: 緯度・経度を 1e6 倍した Int32 の組、緯度順）
 *
 * 【なぜ要るか】
 * 原付の二段階右折は標識で変えられるが、OSM には標識が無い（全国0件）。JARTIC にはある。
 * 信号も OSM より多い（実測: 原付の右折387か所で、OSM に無く JARTIC にある信号が20m以内に21か所）。
 *
 * ⚠️ **配信するにはイメージを作り直すこと。** データはイメージに入る（`service/Dockerfile`）。
 * ⚠️ **出典の表示が要る**（利用規約。応答の `attribution` に JARTIC を入れてある）。
 * ⚠️ **前月ぶんは取得できなくなる**（JARTIC）。月初の取り込み（`jartic-monthly.sh`）で一緒に作る。
 * ⚠️ 生 CSV は大きい（東京406MB・愛知365MB）。**行ごとに読む**（全部を文字列にしない）。
 *
 * 使い方:
 *   node buildJarticMopedTurns.js                # 47都道府県
 *   node buildJarticMopedTurns.js --prefecture 大阪府   # 1県だけ（確かめ用。出力は上書きしない）
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { ROMAJI } = require("./lib/prefectureRomaji");
const { placesFromGeometry, KINDS } = require("./lib/mopedTurnRules");

const CATALOG = "https://www.jartic.or.jp/d/opendata/opendata.json";
const BASE = "https://www.jartic.or.jp/d/opendata";
const SOURCE_PAGE = "https://www.jartic.or.jp/service/opendata/";
const UA = "biketeilen-admin/1.0 (local tool; tourigspotshare@gmail.com)";
const POLITE_DELAY_MS = 2000;
const OUT_RULES = path.join(__dirname, "data", "jartic-moped-turns.json");
const OUT_SIGNALS = path.join(__dirname, "data", "jartic-signals.bin");
/** 信号の共通規制種別コード（定周期・押ボタン・集中制御など） */
const SIGNAL_KIND = "98";

const args = process.argv.slice(2);
const ONLY = (() => { const i = args.indexOf("--prefecture"); return i >= 0 ? args[i + 1] : null; })();

/** ⚠️ 値の中に読点が入る。素朴な split は使えない（`fetchJarticRestrictions.js` と同じ） */
function splitCsvLine(line) {
  const out = [];
  let cell = "", quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

/**
 * CSV の1行から、標識と信号を取り出す（純ロジック）。
 * @returns {{rules: object[], signals: number[][]}}
 */
function fromRow(row, prefecture) {
  const kind = KINDS[row["共通規制種別コード"]];
  const geometry = row["規制場所の経度緯度"];
  if (kind) {
    return {
      rules: placesFromGeometry(geometry).map((p) => ({ kind, at: p.at, inHeading: p.inHeading, prefecture,
                                                        key: row["ユニークキー"] })),
      signals: [],
    };
  }
  if (row["共通規制種別コード"] === SIGNAL_KIND) {
    return { rules: [], signals: placesFromGeometry(geometry).map((p) => p.at) };
  }
  return { rules: [], signals: [] };
}

/** ZIP を落とし、CSV を行ごとに読む。⚠️ CSV も ZIP 内の名前も cp932 */
async function eachRow(link, onRow) {
  const res = await fetch(BASE + link, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tmp = path.join(os.tmpdir(), `jartic-moped-${Date.now()}.zip`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    const child = spawn("/bin/sh", ["-c", `unzip -p ${JSON.stringify(tmp)} "*.csv" | iconv -f CP932 -t UTF-8`]);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let head = null, rows = 0;
    for await (const line of rl) {
      if (!head) { head = splitCsvLine(line); continue; }
      if (!line.trim()) continue;
      const values = splitCsvLine(line);
      const row = {};
      head.forEach((h, j) => { row[h] = values[j]; });
      onRow(row);
      rows++;
    }
    return rows;
  } finally {
    fs.unlinkSync(tmp);
  }
}

/**
 * 書き出す形にする（純ロジック）。
 * ⚠️ **緯度順に並べること。** `lib/mopedTurnRules.js` の `ruleAt` は緯度で二分探索する
 * ⚠️ **出典と加工の明記を入れること**（JARTIC の利用規約）
 */
function toOutput(rules, counts, typeD, now) {
  return {
    attribution: `出典：「交通規制情報」（公益財団法人日本道路交通情報センター）`
      + `（${SOURCE_PAGE}）（${now.toISOString().slice(0, 10)}に利用）を加工して作成`,
    sourceUrl: SOURCE_PAGE,
    targetMonth: typeD.targetMonth,
    releaseDay: typeD.releaseDay,
    fetchedAt: now.toISOString(),
    counts,
    rules: [...rules].sort((a, b) => a.at[1] - b.at[1]),
  };
}

/** 信号を緯度順の Int32 の組にする（`lib/trafficSignals.js` の形） */
function signalsToBin(points) {
  const sorted = points
    .map(([lng, lat]) => [Math.round(lat * 1e6), Math.round(lng * 1e6)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Int32Array(sorted.length * 2);
  sorted.forEach(([lat, lng], i) => { out[i * 2] = lat; out[i * 2 + 1] = lng; });
  return Buffer.from(out.buffer);
}

async function main() {
  const catalog = await (await fetch(CATALOG, { headers: { "User-Agent": UA } })).json();
  const typeD = catalog.find((g) => g.type === "typeD");
  if (!typeD) throw new Error("交通規制情報（typeD）が一覧にありません");
  const order = Object.keys(ROMAJI);
  const targets = typeD.targetList.map((t) => ({
    prefecture: order[Number(String(t.id).replace(/^R/, "")) - 1], link: t.link,
  })).filter((t) => t.prefecture && (!ONLY || t.prefecture === ONLY));
  console.log(`JARTIC 交通規制情報 ${typeD.targetMonth}（公開 ${typeD.releaseDay}）${targets.length}都道府県`);

  const rules = [], signals = [], counts = {};
  for (const t of targets) {
    const c = { twoStage: 0, smallTurn: 0, signals: 0, rows: 0 };
    c.rows = await eachRow(t.link, (row) => {
      const got = fromRow(row, t.prefecture);
      for (const r of got.rules) { rules.push(r); c[r.kind]++; }
      for (const s of got.signals) signals.push(s);
      c.signals += got.signals.length;
    });
    counts[t.prefecture] = c;
    console.log(`${t.prefecture}  二段階 ${c.twoStage}・小回り ${c.smallTurn}・信号 ${c.signals}（${c.rows}行）`);
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
  }
  const data = toOutput(rules, counts, typeD, new Date());
  if (ONLY) {
    console.log(`（確かめだけ。書き出さない）標識 ${rules.length}・信号 ${signals.length}`);
    return;
  }
  fs.writeFileSync(OUT_RULES, JSON.stringify(data));
  fs.writeFileSync(OUT_SIGNALS, signalsToBin(signals));
  console.log(`書き出した: 標識 ${rules.length}件 → ${OUT_RULES}`);
  console.log(`書き出した: 信号 ${signals.length}点 → ${OUT_SIGNALS}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { fromRow, signalsToBin, splitCsvLine, toOutput };
