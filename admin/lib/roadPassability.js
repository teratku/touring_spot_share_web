/**
 * roadPassability.js
 *
 * おすすめ道路を、乗り手の排気量で走れるか（アプリの `RoadPassability.swift` を移したもの）。
 *
 * ⚠️ 利用者の要望（2026-09-28）:「おすすめ道路を選択、選ばれたときはかならずユーザーの排気量によって
 *    走れるか否かを表示、提示したい」「web もルート生成の追加を入れて欲しい」。
 * ⚠️ **アプリと同じ判定にすること。** 重なりはアプリの `RoadRestrictionMatcher`（40m 以内を
 *    300m 以上続けて走る）を移した `appFunRoute.overlapMeters` を使う。片方だけ直すとずれる。
 * ⚠️ **重なりの下限は 300m のまま。** 300m 未満の登録は有料道路の入口の切れ端がほとんどで、
 *    下げると入口に触れるだけの県道75号「湯河原箱根仙石原線」まで「走れない」になる（実データで確認）。
 * ⚠️ 走れなくなる種類は **二輪通行禁止・冬季閉鎖・通行止め**（アプリの `blocksRiding`）。
 *    おすすめから落とす判定（`restrictionOverlap.BLOCKING_KINDS`）とは違い、冬季閉鎖も含む。
 */
"use strict";

const { overlapMeters, MIN_OVERLAP_METERS } = require("./appFunRoute");
const { appliesToRange } = require("./restrictionOverlap");
const { DISPLACEMENT_CC } = require("./restrictionAvoid");
const { decode } = require("./polyline");

/** 走れなくなる種類（アプリの `RoadRestrictionKind.blocksRiding`） */
const BLOCKS_RIDING = new Set(["noMotorcycle", "winterClosure", "closed"]);

/** 種類の呼び名（アプリの `RoadRestrictionKind.label`） */
const KIND_LABEL = { noMotorcycle: "二輪通行禁止", noPassenger: "二人乗り禁止", winterClosure: "冬季閉鎖", closed: "通行止め" };

/** 排気量の短い呼び名（アプリの `BikeDisplacement.shortLabel`） */
const SHORT_LABEL = { moped50: "50cc以下", small125: "125cc以下", medium250: "250cc以下", large: "251cc以上" };

const DAY_NAMES = ["月", "火", "水", "木", "金", "土", "日"];

/** "07:00" → 420。読めなければ null（アプリの `ActiveHours.minutes(of:)`） */
function minutesOf(text) {
  const parts = String(text || "").split(":");
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  const h = Number(parts[0]), m = Number(parts[1]);
  return h <= 23 && m <= 59 ? h * 60 + m : null;
}

/**
 * 効く時期・曜日・時間の文言（「12・1・2・3月」「日 祝」など）。いつでも効くなら空。
 * ⚠️ アプリの `RoadPassability.schedule(of:)`（月 ＋ `scheduleLabel`）と同じ並び
 */
function scheduleOf(r) {
  const parts = [];
  const months = Array.isArray(r.activeMonths) ? r.activeMonths : [];
  if (months.length && months.length < 12) parts.push(`${months.join("・")}月`);
  const days = Array.isArray(r.activeDays) ? r.activeDays : [];
  if (days.length && days.length < 7) {
    parts.push(days.slice().sort((a, b) => a - b).filter((d) => d >= 1 && d <= 7).map((d) => DAY_NAMES[d - 1]).join("・"));
  }
  if (r.includesHoliday === true) parts.push("祝");
  const h = r.activeHours;
  if (h && minutesOf(h.from) !== null && minutesOf(h.to) !== null) parts.push(`${h.from}〜${h.to}`);
  return parts.join(" ");
}

const unique = (list) => list.filter((x, i) => list.indexOf(x) === i);

/**
 * 走れるかを決める。
 * @param geometries 道の形（区間ごと・`[経度, 緯度]` の並び）
 * @param restrictions その辺りの規制（`data/road-restrictions` の形。`polyline` か `points`）
 * @param displacement "moped50" | "small125" | "medium250" | "large"
 * @returns {{verdict: "ok"|"conditional"|"blocked", reasons: string[]}}
 */
function evaluate(geometries, restrictions, displacement) {
  const range = DISPLACEMENT_CC[displacement];
  const target = (restrictions || []).filter((r) => r && BLOCKS_RIDING.has(r.kind)
    // ⚠️ 排気量が分からないときは絞らない（見落とすより避けすぎ側）
    && (!range || appliesToRange(r, range)));
  const blocked = [], conditional = [];
  const seen = new Set();
  for (const geometry of geometries || []) {
    if (!Array.isArray(geometry) || geometry.length < 2) continue;
    // ⚠️ アプリの `RoadRestrictionMatcher.hits` と同じく、重なりの長い順に見る（理由の並びを揃える）
    const hits = [];
    for (const r of target) {
      const points = r.points || (r.polyline ? decode(r.polyline) : null);
      if (!points || points.length < 2) continue;
      const meters = overlapMeters(geometry, points);
      if (meters >= MIN_OVERLAP_METERS) hits.push({ r, meters });
    }
    hits.sort((a, b) => b.meters - a.meters);
    for (const { r } of hits) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const when = scheduleOf(r);
      const label = KIND_LABEL[r.kind] || r.kind;
      if (when) conditional.push(`${when} ${label}`); else blocked.push(label);
    }
  }
  // ⚠️ いつでも走れない規制が1つでもあれば、条件つきの規制は理由に混ぜない
  if (blocked.length) return { verdict: "blocked", reasons: unique(blocked) };
  if (conditional.length) return { verdict: "conditional", reasons: unique(conditional) };
  return { verdict: "ok", reasons: [] };
}

/** 札の文言（アプリの `RoadPassability.label` と同じ） */
function label(result, displacement) {
  const who = SHORT_LABEL[displacement] || displacement;
  const why = result.reasons.join("・");
  if (result.verdict === "blocked") return `${who}は走れません（${why}）`;
  if (result.verdict === "conditional") return `${who}は走れないときがあります（${why}）`;
  return `${who}で走れます`;
}

module.exports = { evaluate, label, scheduleOf, BLOCKS_RIDING, SHORT_LABEL };
