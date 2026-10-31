/**
 * jarticTurnBans.js
 *
 * JARTIC の「指定方向外進行禁止」（直進のみ・左折のみ などの標識）を、タイルに焼く形へ直す。
 * 焼くのは `tiles/patchJarticTurnBans.py`。
 *
 * 【なぜ要るか】
 * OSM の日本データは曲がる規制の登録がまばらで、Valhalla は知らない右折を平気で案内する。
 * 実例: 新大宮バイパス 三橋三丁目の右折（2026-10-31 の走行で発覚）。OSM には0件、JARTIC にはある。
 *
 * 【形】1行は1つの入り口。
 *   規制場所の経度緯度  … 停止線あたりの1点
 *   進入方向(座標)      … その手前。ここ → 規制場所 が入ってくる向き
 *   指定する方向(座標)  … 進んでよい方向の点（1〜3個）。ここに無い方向が禁止
 *
 * ⚠️ **守らなくてよい規制を焼くと、通れる交差点を塞ぐ。** 迷う行はすべて捨てる。
 *    時間・曜日つき … タイルは時刻を持てない（朝だけの規制で一日中曲がれなくなる）
 *    二輪を除く     … 二輪は曲がってよい
 *    大型だけなど   … 対象が「車両」「自動車」以外なら二輪は名指しされていない
 * ⚠️ **対象が「自動車」の規制は 50cc 以下には掛からない**（仕様書: 1(車両)=2(自動車)+36(原付)+38(軽車両)）。
 *    それでも焼く。アプリの 50cc と 125cc はどちらも motor_scooter でタイルでは分けられず、
 *    50cc が遠回りするだけで済む。逆に焼かないと 125cc が違反する。
 */
"use strict";

const { bearing } = require("./mopedTurnRules");
const { vehicleBits } = require("./jarticRestrictions");

/** 指定方向外進行禁止の共通規制種別コード */
const TURN_BAN_KIND = "12";
/** 対象車両 A の桁: 1=車両 2=自動車。二輪を含むのはこの2つだけ */
const VEHICLE_A_ALL = 1;
const VEHICLE_A_MOTOR = 2;
/** 除外車両 D の桁: 1=二輪 2=自二輪 4=原付 5=小二輪。どれかが除かれていれば二輪は曲がってよい */
const TWO_WHEEL_D = [1, 2, 4, 5];

const point = (text) => {
  const p = String(text || "").trim().split(/\s+/).map(Number);
  return p.length === 2 && p.every(Number.isFinite) ? p : null;
};

/** 時間の指定が「いつでも」か。⚠️ 空も終日（`jarticRestrictions.parseHours` と同じ） */
function isAllDay(row, index) {
  const a = String(row[`規制時間${index}_開始`] || "").trim();
  const b = String(row[`規制時間${index}_終了`] || "").trim();
  return (!a && !b) || (Number(a) === 0 && Number(b) === 2400);
}

/**
 * CSV の1行を、焼ける禁止へ。焼かない行は null。
 * @returns {{at:[number,number], inHeading:number, allowed:number[], key:string}|null}
 */
function banFromRow(row) {
  if (String(row["共通規制種別コード"] || "").trim() !== TURN_BAN_KIND) return null;
  if (!isAllDay(row, 1) || String(row["規制曜日コード1"] || "").trim()) return null;
  // ⚠️ 2組目があるのは「平日は○時、休日は○時」の形。1組目だけ見て終日と決めない
  if (String(row["規制時間2_開始"] || "").trim() || String(row["規制曜日コード2"] || "").trim()) return null;

  const target = vehicleBits(row["対象車両コード1_A"]);
  if (!target.has(VEHICLE_A_ALL) && !target.has(VEHICLE_A_MOTOR)) return null;
  const excluded = vehicleBits(row["除外車両コード1_D"]);
  if (TWO_WHEEL_D.some((b) => excluded.has(b))) return null;

  const at = point(row["規制場所の経度緯度"]);
  const entry = point(row["進入方向(座標)"]);
  const exits = String(row["指定する方向(座標)"] || "").split(";").map(point).filter(Boolean);
  if (!at || !entry || !exits.length) return null;
  // ⚠️ 進入方向が規制場所と同じ点の行がある（埼玉 47/1187）。向きが分からず、方位の計算は真北を返す
  if (entry[0] === at[0] && entry[1] === at[1]) return null;
  return {
    at,
    inHeading: Math.round(bearing(entry, at)),
    allowed: exits.map((p) => Math.round(bearing(at, p))),
    key: String(row["ユニークキー"] || row["意思決定番号"] || ""),
  };
}

module.exports = { banFromRow, TURN_BAN_KIND };
