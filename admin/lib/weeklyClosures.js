/**
 * weeklyClosures.js
 *
 * X の毎週の投稿「来週閉まる道」（春は「来週開く道」）に載せる道を選ぶ（純ロジック）。
 *
 * ⚠️ 利用者の要望（2026-10-28）:「今週閉まる道の画像を毎週自動で作る仕組みを作る」。
 *    元は本番の road_restrictions（冬季閉鎖・activePeriod）。読むだけ
 * ⚠️ 日付は毎年の閉鎖期間（"11-11"〜"04-20"）しか持っていない。**今冬の発表が無い道は前の冬の日付**なので、
 *    メモ（note）に「未発表」とある道は「例年」と添えて出す（発表済みの日付と同じ顔で出さない）
 * ⚠️ 時刻はデータに無い。メモの「11/11 13時」を拾えたときだけ添える
 */
"use strict";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** "11-11" → その日付以降で次に来る日（今日なら今日） */
function nextDate(md, from) {
  const [m, d] = md.split("-").map(Number);
  for (const y of [from.getFullYear(), from.getFullYear() + 1]) {
    const t = new Date(y, m - 1, d);
    if (t >= new Date(from.getFullYear(), from.getMonth(), from.getDate())) return t;
  }
  return null;
}

function addDays(date, n) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n); }
function label(date) { return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAYS[date.getDay()]})`; }

/** メモからその日の時刻（"11/11 13時" → "13時"）。拾えなければ "" */
function hourFromNote(note, date) {
  const m = String(note || "").match(new RegExp(`${date.getMonth() + 1}/${date.getDate()}\\s*(\\d{1,2})時(\\d{1,2}分)?`));
  return m ? `${m[1]}時${m[2] || ""}` : "";
}

/**
 * 来週（`from` から `days` 日のうち）に閉まる道・開く道。
 * @param restrictions [{kind, name, prefecture, note, activePeriod: {from: "MM-DD", to: "MM-DD"}}]
 * @returns {{closing: Array, reopening: Array, range: {from, to, label}}}
 *   各行 {name, prefecture, date, dateLabel, hour, usual}（usual = 今冬の発表が無く例年の日付）
 */
function weeklyClosures(restrictions, from, days = 7) {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = addDays(start, days - 1);
  const seen = new Set();
  const closing = [], reopening = [];
  for (const r of restrictions || []) {
    if (!r || r.kind !== "winterClosure" || !r.activePeriod || !r.activePeriod.from || !r.activePeriod.to) continue;
    // ⚠️ 同じ道が区間で何件もある。県・名前・期間で1件に（県境の道は下の mergePrefs で1行に）
    const key = `${r.prefecture}|${r.name}|${r.activePeriod.from}|${r.activePeriod.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const usual = /未発表/.test(r.note || "");
    const closeDay = nextDate(r.activePeriod.from, start);
    if (closeDay && closeDay <= end) {
      closing.push({ name: r.name, prefecture: r.prefecture, date: closeDay, dateLabel: label(closeDay),
                     hour: usual ? "" : hourFromNote(r.note, closeDay), usual });
    }
    // 開通は閉鎖の最終日の翌日
    const lastDay = nextDate(r.activePeriod.to, addDays(start, -1));
    const openDay = lastDay && addDays(lastDay, 1);
    if (openDay && openDay >= start && openDay <= end) {
      reopening.push({ name: r.name, prefecture: r.prefecture, date: openDay, dateLabel: label(openDay),
                       hour: usual ? "" : hourFromNote(r.note, openDay), usual });
    }
  }
  const byDate = (a, b) => a.date - b.date || (a.name < b.name ? -1 : 1);
  closing.sort(byDate);
  reopening.sort(byDate);
  // 県境をまたぐ道は県をまとめる（「宮城県・山形県」）
  const mergePrefs = (list) => {
    const out = [];
    for (const x of list) {
      const same = out.find((y) => y.name === x.name && y.dateLabel === x.dateLabel);
      if (same) { if (!same.prefecture.includes(x.prefecture)) same.prefecture += "・" + x.prefecture; }
      else out.push({ ...x });
    }
    return out;
  };
  return {
    closing: mergePrefs(closing), reopening: mergePrefs(reopening),
    range: { from: start, to: end, label: `${label(start)}〜${label(end)}` },
  };
}

/**
 * X の数え方の長さ（上限 280）。日本語などは2・半角は1・URL は中身に関わらず 23
 * ⚠️ X の twitter-text の近似（U+0000〜U+10FF・U+2000〜U+200D・U+2010〜U+201F・U+2032〜U+2037 を1と数える）
 */
function xLength(text) {
  let n = 0;
  const rest = String(text).replace(/https?:\/\/\S+/g, () => { n += 23; return ""; });
  for (const ch of rest) {
    const c = ch.codePointAt(0);
    n += (c <= 0x10FF || (c >= 0x2000 && c <= 0x200D) || (c >= 0x2010 && c <= 0x201F) || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2;
  }
  return n;
}

/**
 * X の投稿文。1行1本で、X の上限（280）に収まるまで行を減らして「ほか n本」にする。
 * ⚠️ 今冬の発表が無い道は「*」を付けて凡例を添える（1行ごとに「（例年の日付）」を書くと2本しか入らない）
 */
function postText({ closing, reopening, range }, { url = "", limit = 280 } = {}) {
  const row = (x, verb) => `・${x.dateLabel}${x.hour ? " " + x.hour : ""} ${x.name}${x.usual ? "*" : ""}${verb}`;
  const build = (nc, nr) => {
    const lines = [];
    if (closing.length) {
      lines.push(`【今週閉まる道】${range ? range.label : ""}`);
      closing.slice(0, nc).forEach((x) => lines.push(row(x, "")));
      if (closing.length > nc) lines.push(`ほか ${closing.length - nc}本は画像と一覧で`);
    }
    if (reopening.length) {
      lines.push(`【今週開く道】${!closing.length && range ? range.label : ""}`);
      reopening.slice(0, nr).forEach((x) => lines.push(row(x, " 開通")));
      if (reopening.length > nr) lines.push(`ほか ${reopening.length - nr}本は画像と一覧で`);
    }
    if (!lines.length) return "";
    const usual = [...closing.slice(0, nc), ...reopening.slice(0, nr)].some((x) => x.usual);
    if (usual) lines.push("*今季は未発表・例年の日付");
    lines.push(closing.length ? "走りおさめはお早めに。" : "開通直後は夜間通行止めの道もあります。");
    lines.push("#ツーリング #冬季閉鎖" + (url ? "\n" + url : ""));
    return lines.join("\n");
  };
  let nc = closing.length, nr = reopening.length;
  let text = build(nc, nr);
  while (text && xLength(text) > limit && nc + nr > 1) {
    if (nc >= nr) nc--; else nr--;
    text = build(nc, nr);
  }
  return text;
}

module.exports = { weeklyClosures, postText, xLength, hourFromNote, nextDate };
