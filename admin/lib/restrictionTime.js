/**
 * restrictionTime.js
 *
 * 通行規制の「効いている時間」を扱う（純ロジック）。
 *
 * 【なぜ必要か】
 * 二輪の規制は時間や曜日で切られていることが多い（「土日祝の 7:00〜19:00 のみ二輪通行禁止」など）。
 * 月（`activeMonths`）だけでは表せず、通れる時間まで「通行禁止」と案内してしまう。
 *
 * 【持ち方】
 *   activeDays  … 1=月 〜 7=日。空／未指定なら毎日
 *   includesHoliday … 祝日も含めるか（土日と別に指定されることがある）
 *   activeHours … { from: "07:00", to: "19:00" }。未指定なら終日
 *
 * ⚠️ **日をまたぐ指定を落とさないこと。** 「22:00〜05:00」は実在する（夜間規制）。
 *    from > to のときは、またぐものとして扱う。
 *
 *   activePeriod … { from: "11-15", to: "04-24" }。毎年くり返す期間（両端の日を含む）。未指定なら通年
 *
 * ⚠️ 利用者の要望（2026-10-24）:「スカイラインとかの走れなくなる日付を表示」。冬季閉鎖は
 *    「11月中旬〜4月下旬」のように月の途中で切られるので、月（`activeMonths`）では日付を出せない。
 *    **期間を持つときも `activeMonths` を一緒に書く**（期間がかかる月）。期間を知らない古いアプリ・
 *    Web はそちらを見る（月の途中の日は閉まっている側に倒れる＝走れると言ってしまうよりよい）。
 * ⚠️ **年をまたぐ期間（11-15〜04-24）を落とさないこと。** 冬季閉鎖はほぼすべてこれ。
 */
"use strict";

/** "07:00" → 420（分）。読めなければ null */
function parseHm(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
  return h * 60 + min;
}

/** 分 → "07:00" */
function formatHm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 保存できる形に整える。おかしな値は落とす（null にする）。
 *
 * ⚠️ 片方だけの時刻を通さないこと。「7:00から」だけでは終わりが決まらず、
 *    アプリ側で終日と区別できない。
 */
function normalizeHours(hours) {
  if (!hours) return null;
  const from = parseHm(hours.from);
  const to = parseHm(hours.to);
  if (from === null || to === null) return null;
  if (from === to) return null;              // 同じ時刻は「終日」と区別できない
  return { from: formatHm(from), to: formatHm(to) };
}

/** 曜日の指定を整える。1〜7 以外は落とす。全部そろっていれば「毎日」として null にする */
function normalizeDays(days) {
  if (!Array.isArray(days)) return null;
  const set = [...new Set(days.map(Number).filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (!set.length || set.length === 7) return null;
  return set;
}

/** "11-15"・"11/15"・"1115" → 1115（月×100＋日）。読めなければ null */
function parseMonthDay(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{1,2})[-/]?(\d{2})$|^(\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[1] ?? m[3]);
  const day = Number(m[2] ?? m[4]);
  if (!(month >= 1 && month <= 12)) return null;
  // ⚠️ 2月29日は通す（うるう年の閉鎖の終わりに書かれる）
  const last = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!(day >= 1 && day <= last)) return null;
  return month * 100 + day;
}

/** 1115 → "11-15" */
function formatMonthDay(value) {
  return `${String(Math.floor(value / 100)).padStart(2, "0")}-${String(value % 100).padStart(2, "0")}`;
}

/**
 * 期間を保存できる形に整える。おかしな値は null。
 * ⚠️ 片方だけは通さない（終わりの無い冬季閉鎖は「通年」と区別できない）。同じ日は1日だけの閉鎖として通す
 */
function normalizePeriod(period) {
  if (!period) return null;
  const from = parseMonthDay(period.from);
  const to = parseMonthDay(period.to);
  if (from === null || to === null) return null;
  return { from: formatMonthDay(from), to: formatMonthDay(to) };
}

/** その月日（1115 の形）が期間に入るか。年をまたぐ期間も扱う */
function periodContains(period, monthDay) {
  const p = normalizePeriod(period);
  if (!p) return true;
  const from = parseMonthDay(p.from);
  const to = parseMonthDay(p.to);
  return from <= to ? monthDay >= from && monthDay <= to
                    : monthDay >= from || monthDay <= to;
}

/** 期間がかかる月（古いアプリ向けの `activeMonths`）。並びは期間の始まりから */
function monthsOfPeriod(period) {
  const p = normalizePeriod(period);
  if (!p) return null;
  const first = Math.floor(parseMonthDay(p.from) / 100);
  const last = Math.floor(parseMonthDay(p.to) / 100);
  const months = [];
  // ⚠️ 同じ月の中で終わりが始まりより前（4/24〜4/10）は、ほぼ1年なので12か月すべて
  if (first === last && parseMonthDay(p.from) > parseMonthDay(p.to)) {
    for (let i = 0; i < 12; i++) months.push(((first - 1 + i) % 12) + 1);
    return months;
  }
  for (let m = first; ; m = (m % 12) + 1) {
    months.push(m);
    if (m === last) break;
  }
  return months;
}

/** "11/15〜4/24" */
function describePeriod(period) {
  const p = normalizePeriod(period);
  if (!p) return "";
  const text = (v) => `${Math.floor(v / 100)}/${v % 100}`;
  return `${text(parseMonthDay(p.from))}〜${text(parseMonthDay(p.to))}`;
}

/**
 * その日時に規制が効いているか。
 *
 * @param {object} restriction { activeDays, includesHoliday, activeHours }
 * @param {Date}   at
 * @param {object} options { isHoliday: boolean } 祝日かどうかは呼び出し側が渡す
 */
function isActiveAt(restriction, at, options = {}) {
  if (restriction.activePeriod
      && !periodContains(restriction.activePeriod, (at.getMonth() + 1) * 100 + at.getDate())) return false;
  const days = normalizeDays(restriction.activeDays);
  if (days) {
    // ⚠️ JavaScript の getDay() は 0=日。1=月〜7=日 に直してから比べる
    const day = at.getDay() === 0 ? 7 : at.getDay();
    const holidayCounts = restriction.includesHoliday && options.isHoliday;
    if (!days.includes(day) && !holidayCounts) return false;
  }

  const hours = normalizeHours(restriction.activeHours);
  if (!hours) return true;                   // 時間の指定が無ければ終日
  const now = at.getHours() * 60 + at.getMinutes();
  const from = parseHm(hours.from);
  const to = parseHm(hours.to);
  // ⚠️ 日をまたぐ指定（22:00〜05:00）。単純な from <= now < to では落とす
  return from < to ? now >= from && now < to
                   : now >= from || now < to;
}

/** 画面や一覧に出す説明。指定が無ければ空 */
function describe(restriction) {
  const parts = [];
  const period = describePeriod(restriction.activePeriod);
  if (period) parts.push(period);
  const days = normalizeDays(restriction.activeDays);
  if (days) {
    const names = ["月", "火", "水", "木", "金", "土", "日"];
    parts.push(days.map((d) => names[d - 1]).join("・"));
  }
  if (restriction.includesHoliday) parts.push("祝");
  const hours = normalizeHours(restriction.activeHours);
  if (hours) parts.push(`${hours.from}〜${hours.to}`);
  return parts.join(" ");
}

module.exports = {
  parseHm, formatHm, normalizeHours, normalizeDays, isActiveAt, describe,
  parseMonthDay, normalizePeriod, periodContains, monthsOfPeriod, describePeriod,
};
