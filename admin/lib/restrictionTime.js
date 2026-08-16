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

/**
 * その日時に規制が効いているか。
 *
 * @param {object} restriction { activeDays, includesHoliday, activeHours }
 * @param {Date}   at
 * @param {object} options { isHoliday: boolean } 祝日かどうかは呼び出し側が渡す
 */
function isActiveAt(restriction, at, options = {}) {
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

module.exports = { parseHm, formatHm, normalizeHours, normalizeDays, isActiveAt, describe };
