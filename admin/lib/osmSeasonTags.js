/**
 * osmSeasonTags.js
 *
 * OpenStreetMap のタグから、冬季閉鎖など「毎年この期間は走れない」を読む（純ロジック）。
 *
 * ⚠️ 利用者の判断（2026-10-24）:「スカイラインとかの走れなくなる日付を表示」→「OSM から自動で拾い、調整ツールで直す」。
 *    ここで作るのは**候補まで**。配信するのは調整ツールで日付を確かめて登録したものだけ。
 *
 * 【OSM にどれだけあるか】（2026-10-24 に全国を Overpass で数えた）
 *   ・期間つきの書き方は `access:conditional` がほとんど。月だけ（"no @ (Dec-Apr)"）が多く、日付まであるのは数本
 *   ・**有名なスカイライン類にはほぼ付いていない**（ビーナスライン・蔵王エコーライン・八幡平アスピーテライン・
 *     富士山スカイライン・志賀草津道路・鳥海ブルーラインは季節の札が0）。手で足す前提
 *   ・説明（description / note）に「冬季通行止め」とだけ書いた道もある（国道477号・小樽定山渓線など）。
 *     期間が無いので、候補にはするが日付は空のまま
 *
 * 【読み方】
 *   "no @ (Dec-Apr)"                → 12/1〜4/30
 *   "no @ (Nov 15-Apr 25)"          → 11/15〜4/25
 *   "yes @ (Jul 1-Sep 30 06:00-18:00; Oct 1-Oct 31 07:00-18:00)"
 *                                   → 開いている 7/1〜10/31 の外 = 11/1〜6/30（時間は捨てる）
 *   "no @ (winter)"                 → 12/1〜3/31 を仮に入れ、「winter とだけ」と添える
 * ⚠️ **時間つきの月の指定（"Nov-Jun 00:00-07:00"）は冬季閉鎖として読まない。** 夜間の規制で、
 *    昼は走れる。終日の期間だけを拾う。
 * ⚠️ `permit @ Jul-Oct`（南アルプス公園線）は「許可が要る」で閉鎖ではない。拾わない。
 */
"use strict";

const { normalizePeriod, parseMonthDay } = require("./restrictionTime");

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const LAST_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 期間を読む鍵。強い（二輪に近い）ものから見る */
const CONDITIONAL_KEYS = ["motorcycle:conditional", "motor_vehicle:conditional", "vehicle:conditional", "access:conditional"];

/** 「冬に閉まる」と書かれた説明。⚠️ 「冬期も開放」「冬期営業時間」を拾わないよう、閉まる言葉まで見る */
// ⚠️ 間に期間が挟まる書き方（「冬期 (12/1 - 3/31) 通行止め」）があるので、20字までは間を許す
const WINTER_TEXT = /冬[期季][^。]{0,20}?(?:通行止|閉鎖|使用不可|利用不可)/;

/**
 * "Dec-Apr" / "Nov 15-Apr 25" / "Mar-01-Nov-30" を読む。
 * @returns {{from: number, to: number, rest: string}|null} from/to は 1115 の形。rest は後ろに残った文字（時間・曜日）
 */
function parseRange(rule) {
  const text = rule.replace(/[‐-―−]/g, "-").trim();
  const m = text.match(/^([A-Z][a-z]{2})(?:[\s-](\d{1,2}))?\s*-\s*([A-Z][a-z]{2})(?:[\s-](\d{1,2}))?(?![\d:])(.*)$/);
  if (!m || !MONTHS[m[1]] || !MONTHS[m[3]]) return null;
  const fromMonth = MONTHS[m[1]], toMonth = MONTHS[m[3]];
  const from = fromMonth * 100 + (m[2] ? Number(m[2]) : 1);
  const to = toMonth * 100 + (m[4] ? Number(m[4]) : LAST_DAY[toMonth - 1]);
  if (parseMonthDay(fmt(from)) === null || parseMonthDay(fmt(to)) === null) return null;
  return { from, to, rest: m[5].trim() };
}

const fmt = (v) => `${String(Math.floor(v / 100)).padStart(2, "0")}-${String(v % 100).padStart(2, "0")}`;

/** 1115 → 0〜365 の通し番号（2/29 を含む 366 日の暦） */
function dayIndex(v) {
  const month = Math.floor(v / 100), day = v % 100;
  let index = 0;
  for (let i = 0; i < month - 1; i++) index += LAST_DAY[i];
  return index + day - 1;
}

function fromIndex(index) {
  let month = 0;
  while (index >= LAST_DAY[month]) { index -= LAST_DAY[month]; month++; }
  return (month + 1) * 100 + index + 1;
}

/**
 * 開いている期間の並びから、閉まっている期間（ひと続きのときだけ）を出す。
 * ⚠️ 閉まる期間が2つに割れるとき（春と秋だけ開く等）は1つの期間で表せない。null を返して人に任せる
 */
function complement(openRanges) {
  const open = new Array(366).fill(false);
  for (const { from, to } of openRanges) {
    for (let i = dayIndex(from); ; i = (i + 1) % 366) {
      open[i] = true;
      if (i === dayIndex(to)) break;
    }
  }
  if (open.every(Boolean) || !open.some(Boolean)) return null;
  // 開いている日のすぐ後から数え始める（年をまたぐ閉鎖をひと続きで見るため）
  const start = (open.lastIndexOf(true) + 1) % 366;
  const runs = [];
  let run = null;
  for (let k = 0; k < 366; k++) {
    const i = (start + k) % 366;
    if (!open[i]) {
      if (!run) run = { from: i, to: i };
      else run.to = i;
    } else if (run) { runs.push(run); run = null; }
  }
  if (run) runs.push(run);
  if (runs.length !== 1) return null;
  return { from: fromIndex(runs[0].from), to: fromIndex(runs[0].to) };
}

/** 説明の中の「12/1 - 3/31」「12月1日〜3月31日」を読む */
function periodInText(text) {
  const m = String(text).match(/(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?\s*[-~〜～ー－]\s*(\d{1,2})\s*[/月]\s*(\d{1,2})/);
  if (!m) return null;
  return normalizePeriod({ from: `${m[1]}/${m[2].padStart(2, "0")}`, to: `${m[3]}/${m[4].padStart(2, "0")}` });
}

/**
 * 1本の way のタグから、毎年の閉鎖期間を読む。
 *
 * @returns {null|{period: {from,to}|null, sourceTag: string, reason: string}}
 *   period が null のときは「冬に閉まるとは書いてあるが期間が無い」（調整ツールで埋める）
 */
function parseSeasonalClosure(tags) {
  if (!tags) return null;
  for (const key of CONDITIONAL_KEYS) {
    const raw = tags[key];
    if (typeof raw !== "string" || !raw.includes("@")) continue;
    const at = raw.indexOf("@");
    const value = raw.slice(0, at).trim().toLowerCase();
    let condition = raw.slice(at + 1).trim();
    if (condition.startsWith("(") && condition.endsWith(")")) condition = condition.slice(1, -1);
    const rules = condition.split(";").map((r) => r.trim()).filter(Boolean);
    const source = `${key}=${raw}`;

    // ⚠️ 曜日の入った指定は季節の閉鎖ではなく曜日の規制（枚方大和郡山線の
    //    "no @ (Jan 01-Jun 30 Sa,Su,PH; Jul 01-Aug 31; Sep 01-Dec 31 Sa,Su,PH)" は「夏休みは毎日・ほかは土日祝」の二輪規制）。
    //    そちらは二輪の規制の候補（`fetchOsmRestrictions.js`）で拾う
    if (rules.some((r) => /\b(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/.test(r))) continue;
    if (value === "no") {
      // ⚠️ 終日の期間だけ（後ろに時間・曜日が付いていない）。時間つきは夜間の規制
      const whole = rules.map(parseRange).find((r) => r && !r.rest);
      if (whole) {
        const others = rules.length > 1 ? "（ほかに時間の規制も書かれている）" : "";
        return { period: normalizePeriod({ from: fmt(whole.from), to: fmt(whole.to) }), sourceTag: source,
                 reason: `OSM の ${source} から期間を読んだ${others}。毎年の開通日・閉鎖日を道路管理者の発表で確かめること` };
      }
      if (rules.some((r) => /^winter$/i.test(r))) {
        return { period: normalizePeriod({ from: "12-01", to: "03-31" }), sourceTag: source,
                 reason: `OSM には ${source} とだけ書かれている（期間は 12/1〜3/31 を仮に入れた）。必ず確かめること` };
      }
    } else if (value === "yes") {
      // 開いている期間だけが書かれている → その外が閉鎖（時間は捨てる）
      const ranges = rules.map(parseRange);
      if (ranges.length && ranges.every(Boolean)) {
        const closed = complement(ranges);
        if (closed) {
          return { period: normalizePeriod({ from: fmt(closed.from), to: fmt(closed.to) }), sourceTag: source,
                   reason: `OSM の ${source}（開いている期間）の外を閉鎖とした。開通日を道路管理者の発表で確かめること` };
        }
      }
    }
  }

  // 説明に「冬季通行止め」とだけ書かれた道
  for (const key of ["description", "note", "name"]) {
    const text = tags[key];
    if (typeof text !== "string" || !WINTER_TEXT.test(text)) continue;
    const night = /夜間/.test(text);
    return { period: periodInText(text), sourceTag: `${key}=${text}`,
             reason: night ? `OSM の説明に「${text}」。夜間だけの閉鎖なので、時間と期間を確かめること`
                           : `OSM の説明に「${text}」とある。期間を道路管理者の発表で確かめて入れること` };
  }

  // seasonal=spring;summer;autumn（冬だけ使えない）
  const seasonal = typeof tags.seasonal === "string" ? tags.seasonal.split(";").map((s) => s.trim()) : [];
  const SEASONS = ["spring", "summer", "autumn", "winter"];
  if (seasonal.length && seasonal.every((s) => SEASONS.includes(s)) && !seasonal.includes("winter")) {
    return { period: null, sourceTag: `seasonal=${tags.seasonal}`,
             reason: `OSM の seasonal=${tags.seasonal}（冬は使えない）。期間を確かめて入れること` };
  }
  return null;
}

module.exports = { parseSeasonalClosure, parseRange, complement, periodInText, WINTER_TEXT };
