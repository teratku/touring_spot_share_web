"use strict";

/**
 * 走った道の感想（アプリの RoadFeedback.swift が road_feedback に書く）を、道ごとにまとめる。
 *
 * ⚠️ 利用者の判断（2026-10-08）: 走ったおすすめ道路の評価と札を夜の通知で聞き、**まず調整ツールだけ**に出す。
 *    札は開発者が見て採用する（自動で配信に流さない。road_reviews と同じ考え方）。
 * ⚠️ **誰が書いたかは出さない。** uid は「何人が答えたか」を数えるのに使うだけ
 * ⚠️ 道の鍵は調整ツールの `reviewKey`（`/` を `_` に置き換えた道のまとめキー）と同じ形にする。
 *    ずれると声が1件も当たらない（黙って空になるだけで気付けない）
 */

const VERDICTS = ["good", "ok", "bad"];
const TAGS = ["scenic", "winding", "flowing", "forest"];
const CAUTIONS = ["rough", "narrow", "traffic", "gravel"];
const CAUTION_LABELS = { rough: "路面が荒い", narrow: "狭い", traffic: "交通量が多い", gravel: "砂利" };

/** 道のまとめキーを調整ツールの鍵の形にする（`/` → `_`） */
function keyOf(roadID) {
  return String(roadID || "").replace(/\//g, "_");
}

function toIso(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return null;
}

/**
 * 道ごとの声。{ 鍵: { roadName, good, ok, bad, total, tags:{鍵:人数}, cautions:{鍵:人数}, notes:[{text, at}], lastAt } }
 * ⚠️ 形の崩れた文書（判定が無い・道の鍵が無い）は数えない
 */
function summarizeFeedback(docs, { maxNotes = 5 } = {}) {
  const out = {};
  for (const d of docs || []) {
    if (!d || !d.roadID || !VERDICTS.includes(d.verdict)) continue;
    const k = keyOf(d.roadID);
    const s = out[k] || (out[k] = {
      roadName: d.roadName || "", good: 0, ok: 0, bad: 0, total: 0, tags: {}, cautions: {}, notes: [], lastAt: null,
    });
    s[d.verdict] += 1;
    s.total += 1;
    for (const t of Array.isArray(d.tags) ? d.tags : []) if (TAGS.includes(t)) s.tags[t] = (s.tags[t] || 0) + 1;
    for (const c of Array.isArray(d.cautions) ? d.cautions : []) {
      if (CAUTIONS.includes(c)) s.cautions[c] = (s.cautions[c] || 0) + 1;
    }
    const at = toIso(d.updatedAt) || toIso(d.rodeAt);
    const note = typeof d.note === "string" ? d.note.trim() : "";
    if (note) s.notes.push({ text: note.slice(0, 200), at });
    if (at && (!s.lastAt || at > s.lastAt)) s.lastAt = at;
  }
  for (const s of Object.values(out)) {
    s.notes.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    s.notes = s.notes.slice(0, maxNotes);
  }
  return out;
}

/** 答えてもらえた数（/riders 用）。回答数・答えた人の数・道の数 */
function countFeedback(docs) {
  const valid = (docs || []).filter((d) => d && d.roadID && VERDICTS.includes(d.verdict));
  return {
    answers: valid.length,
    riders: new Set(valid.map((d) => d.uid).filter(Boolean)).size,
    roads: new Set(valid.map((d) => keyOf(d.roadID))).size,
  };
}

module.exports = { summarizeFeedback, countFeedback, keyOf, VERDICTS, TAGS, CAUTIONS, CAUTION_LABELS };
