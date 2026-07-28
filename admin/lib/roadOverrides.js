/**
 * roadOverrides.js
 *
 * 自動生成した区間に、開発者の判断を上書きする層。
 *
 * 【なぜ要るのか】
 * 自動判定は曲率と長さしか見ていない。標高も景観もデータに無いので、
 * ビーナスライン（29.9km・曲率435）は118位にしかならない。
 * あの道の価値は見晴らしで、数字には表れない。
 * 逆に、曲がってはいるが走って面白くない道も上位に来る。
 * そこを手で直せるようにする。
 *
 * 【再生成しても消えないこと】
 * ⚠️ 区間の id（"栃木県:12" のような並び順）を鍵にしてはいけない。
 *    重みを変えるだけで順番が動き、別の道に調整が付いてしまう。
 *    道路名と場所で照合する。区間の切り出しが多少ずれても追随できるよう、
 *    完全一致で当たらなければ「同じ名前・近い場所」で拾い直す。
 */
"use strict";

const { distanceMeters } = require("./roadCsv");

/** 場所を丸める粗さ（度）。0.01度 ≒ 1.1km */
const KEY_PRECISION = 0.01;
/** 完全一致しなかったときに、同じ名前で拾い直す距離 */
const FUZZY_MATCH_METERS = 3000;

/**
 * 調整を紐づける鍵。道路名＋始点をおおまかに丸めたもの。
 * @param {{name: string, start: [number, number]}} segment start は [緯度, 経度]
 */
function overrideKey(segment) {
  const round = (v) => (Math.round(v / KEY_PRECISION) * KEY_PRECISION).toFixed(2);
  return `${segment.name}@${round(segment.start[0])},${round(segment.start[1])}`;
}

/** 調整1件の既定値 */
function normalizeOverride(raw = {}) {
  return {
    /** 一覧から外す */
    hidden: raw.hidden === true,
    /** 点数への加算（0〜100 の点数に足す）。マイナスで下げる */
    boost: Number.isFinite(raw.boost) ? Math.max(-100, Math.min(100, raw.boost)) : 0,
    /** 表示名の上書き。OSM の名前が実感と違うとき（例: 湯河原箱根線 → 椿ライン） */
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null,
    /** ひとこと説明 */
    note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null,
    /** 「絶景」「ワインディング」などの札 */
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string" && t.trim()) : [],
    /** 誰がいつ触ったかの控え（運用の手がかり。配信には載せない） */
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

/** 何も指定していない調整か（空の調整はファイルに残さない） */
function isEmptyOverride(o) {
  const n = normalizeOverride(o);
  return !n.hidden && n.boost === 0 && !n.title && !n.note && n.tags.length === 0;
}

/**
 * 区間に調整を当てる。
 *
 * @param {Array} segments score 降順である必要はない（この関数の中で並べ直す）
 * @param {Object} overrides 鍵 → 調整
 * @returns {{ segments, applied, unmatched }}
 *   applied   … 実際に当たった鍵
 *   unmatched … どの区間にも当たらなかった鍵（道が消えた・名前が変わった等。UIで知らせる）
 */
function applyOverrides(segments, overrides = {}) {
  const entries = Object.entries(overrides).map(([key, value]) => ({
    key,
    override: normalizeOverride(value),
    // 鍵から名前と座標を戻す（あいまい照合に使う）
    parsed: parseKey(key),
  }));

  const byKey = new Map(entries.map((e) => [e.key, e]));
  const used = new Set();
  const result = [];

  for (const segment of segments) {
    const key = overrideKey(segment);
    let hit = byKey.get(key);
    if (!hit) hit = fuzzyMatch(segment, entries, used);
    if (!hit) { result.push({ ...segment }); continue; }

    used.add(hit.key);
    const o = hit.override;
    if (o.hidden) continue;   // 一覧から外す

    const next = { ...segment };
    if (o.boost !== 0) {
      next.score = Number(Math.max(0, Math.min(100, segment.score + o.boost)).toFixed(1));
      next.boost = o.boost;
    }
    if (o.title) next.title = o.title;
    if (o.note) next.note = o.note;
    if (o.tags.length) next.tags = o.tags;
    result.push(next);
  }

  result.sort((a, b) => b.score - a.score);
  return {
    segments: result,
    applied: [...used],
    unmatched: entries.filter((e) => !used.has(e.key)).map((e) => e.key),
  };
}

/** "国道120号@36.75,139.60" → { name, lat, lng } */
function parseKey(key) {
  const at = key.lastIndexOf("@");
  if (at < 0) return null;
  const [lat, lng] = key.slice(at + 1).split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { name: key.slice(0, at), lat, lng };
}

/**
 * 完全一致しなかったときの拾い直し。
 * 同じ道路名で、始点が FUZZY_MATCH_METERS 以内なら同じ区間とみなす。
 * 区間の切り出しが少し動いただけで調整が外れるのを防ぐ。
 */
function fuzzyMatch(segment, entries, used) {
  let best = null;
  let bestDistance = Infinity;
  for (const entry of entries) {
    if (used.has(entry.key) || !entry.parsed) continue;
    if (entry.parsed.name !== segment.name) continue;
    const d = distanceMeters(
      [entry.parsed.lng, entry.parsed.lat],
      [segment.start[1], segment.start[0]]
    );
    if (d <= FUZZY_MATCH_METERS && d < bestDistance) { bestDistance = d; best = entry; }
  }
  return best;
}

module.exports = {
  overrideKey, applyOverrides, normalizeOverride, isEmptyOverride,
  KEY_PRECISION, FUZZY_MATCH_METERS,
};
