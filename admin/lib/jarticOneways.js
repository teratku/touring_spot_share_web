/**
 * jarticOneways.js
 *
 * JARTIC の「一方通行」を、タイルに焼く形へ直す。焼くのは `tiles/patchJarticOneways.py`。
 *
 * 【なぜ要るか】
 * OSM は一方通行の登録が抜けていて、Valhalla は逆走の経路を平気で出す。
 * 実測（埼玉まわり 772km）: 両方向のままの道が 120km、逆走の経路が出る道が 530本・約101km。
 *
 * 【形】`規制場所の経度緯度` が線。`;` で点、`/` で線を区切る。**点の順が進む向き**
 * （OSM の一方通行と比べて 同じ向き 647km／逆 4.4km で確認）。
 * ⚠️ **点の順が進む向きなのは埼玉など一部の県だけ。** 東京は OSM の 8割、大阪は 5割が逆になり、全国の
 *    2,415km を裏返す結果になった。`指定・禁止方向の別コード` が 2 の県は静岡・長崎などを除けば合うが、
 *    1 の県は群馬と福岡を除いて合わず、列では見分けられない。県ごとの判定は `patchJarticOneways.py`。
 *
 * ⚠️ 迷う行は捨てる。`jarticTurnBans.js` と同じ（時間・曜日つき／二輪を除く／大型だけ など）。
 * ⚠️ 高速は焼かない。OSM の方が確かで、上下線の取り違えが起きると本線が止まる。
 */
"use strict";

const { isAlwaysOn, bindsTwoWheelers } = require("./jarticTurnBans");

/** 一方通行の共通規制種別コード */
const ONEWAY_KIND = "11";

/** 線の文字列を点の並びへ。⚠️ 2点に満たない線は向きが無いので捨てる */
function linesOf(text) {
  const lines = [];
  for (const part of String(text || "").split("/")) {
    const line = [];
    for (const piece of part.split(";")) {
      const p = piece.trim().split(/\s+/).map(Number);
      if (p.length === 2 && p.every(Number.isFinite)) line.push(p);
    }
    if (line.length >= 2) lines.push(line);
  }
  return lines;
}

/**
 * CSV の1行を、焼ける一方通行へ。焼かない行は null。
 * @returns {{lines:[number,number][][], key:string}|null}
 */
function onewayFromRow(row) {
  if (String(row["共通規制種別コード"] || "").trim() !== ONEWAY_KIND) return null;
  if (String(row["県別規制種別名称"] || "").includes("高速")) return null;
  if (!isAlwaysOn(row) || !bindsTwoWheelers(row)) return null;
  // ⚠️ 線の一部が規制の外の行。どこが外かを道に当てられない
  if (String(row["除外区間及び区域の経度緯度"] || "").trim()) return null;
  const lines = linesOf(row["規制場所の経度緯度"]);
  if (!lines.length) return null;
  return { lines, key: String(row["ユニークキー"] || row["意思決定番号"] || "") };
}

module.exports = { onewayFromRow, linesOf, ONEWAY_KIND };
