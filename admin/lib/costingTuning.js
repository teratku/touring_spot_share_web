/**
 * costingTuning.js
 *
 * 調整ツールの画面で、**排気量ごとの数値を変えて試す**ための値（`tuning`）を受け取る。
 * 利用者の要望（2026-09-27）:「web でルート生成する時に各排気量で設定している数値も表示して
 * 変更できるようにして確認できるようにしたい」。
 *
 *   tuning = {
 *     topSpeed:     30,                    // top_speed（km/h）。null なら渡さない
 *     ferryWeight:  0.35,                  // 船に乗ってよいときの use_ferry
 *     variants: {                          // 案ごとの重み（渡さない鍵は既定のまま・null は渡さない）
 *       shortest: { use_primary: 0.3 },
 *       normal:   { use_primary: 0.05, use_highways: 0.5, maneuver_penalty: 60 },
 *       fun:      { use_primary: 0 },
 *     },
 *     highwayLadder: [0.5, 0.3, 0.15, 0],  // 高速を避けるときに試す use_highways（motorcycle）
 *   }
 *
 * ⚠️ **配信API（アプリ）には通さないこと。** 条件を作る `routeOptionsFromBody` は `tuning` を読まない。
 *    ここで変えた値は画面で試すためだけのもの（本番の数値は `lib/valhallaRoute.js` の表）。
 * ⚠️ **画面の値で法令を緩められないこと。** 125cc以下の高速の禁止と、画面の「高速回避」「有料回避」は
 *    この値より後に重ねる（`costingOptionsFor`）。
 * ⚠️ 範囲の外・知らない鍵は黙って捨てる（Valhalla に変な値を渡して失敗させない）
 */
"use strict";

const VARIANT_KEYS = ["shortest", "normal", "fun"];
/** 案ごとに変えられる重み（0〜1）。⚠️ 増やすなら画面の表と `costingOptionsFor` も一緒に */
const WEIGHT_KEYS = ["use_primary", "use_highways"];
/**
 * 案ごとに変えられる秒数（範囲）。
 *
 * ⚠️ 利用者の要望（2026-09-28）:「126cc以上も生活道路と幹線道路の重みを変えてみたい」。
 *    126cc以上（motorcycle）には `use_primary` が効かない。7区間で測って効いたのは、
 *    最高速度（下げると県道・生活道路寄り）と、曲がる手間（上げると幹線寄り）:
 *      maneuver_penalty 60 … 前橋→草津 幹線 92→99%・新座→愛川 92→98%（既定は5秒。5では1mも変わらない）
 *    `use_distance`・`use_living_streets` は7区間とも1mも変わらなかった（入れない）
 */
const SECONDS_KEYS = { maneuver_penalty: [0, 300] };
/** Valhalla の top_speed の範囲（km/h） */
const TOP_SPEED_MIN = 10;
const TOP_SPEED_MAX = 252;
/** 高速を避けるときに試す段の数の上限（1段ごとに1回引き直すので増やしすぎない） */
const MAX_LADDER_STEPS = 6;

const isWeight = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** @returns 整えた `tuning`。有効な値が1つも無ければ null（＝アプリと同じ条件） */
function sanitizeTuning(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  if (raw.topSpeed === null) out.topSpeed = null;
  else if (typeof raw.topSpeed === "number" && raw.topSpeed >= TOP_SPEED_MIN && raw.topSpeed <= TOP_SPEED_MAX) {
    out.topSpeed = Math.round(raw.topSpeed);
  }
  if (isWeight(raw.ferryWeight)) out.ferryWeight = raw.ferryWeight;
  if (raw.variants && typeof raw.variants === "object") {
    const variants = {};
    for (const v of VARIANT_KEYS) {
      const given = raw.variants[v];
      if (!given || typeof given !== "object") continue;
      const picked = {};
      for (const k of WEIGHT_KEYS) {
        if (given[k] === null || isWeight(given[k])) picked[k] = given[k];
      }
      for (const [k, [min, max]] of Object.entries(SECONDS_KEYS)) {
        const v = given[k];
        if (v === null) picked[k] = null;
        else if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) picked[k] = Math.round(v);
      }
      if (Object.keys(picked).length) variants[v] = picked;
    }
    if (Object.keys(variants).length) out.variants = variants;
  }
  // ⚠️ 段は「緩い方から」。0 は最後に試す値（既に引いてある）なので、並びは大きい順に揃える
  if (Array.isArray(raw.highwayLadder) && raw.highwayLadder.length
      && raw.highwayLadder.length <= MAX_LADDER_STEPS && raw.highwayLadder.every(isWeight)) {
    out.highwayLadder = [...raw.highwayLadder].sort((a, b) => b - a);
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { sanitizeTuning, VARIANT_KEYS, WEIGHT_KEYS, SECONDS_KEYS, TOP_SPEED_MIN, TOP_SPEED_MAX, MAX_LADDER_STEPS };
