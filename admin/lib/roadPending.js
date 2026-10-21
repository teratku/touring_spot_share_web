/**
 * roadPending.js
 *
 * おすすめ道路の「配信待ち」— 手元で直した・足したのに、まだ本番に配信していない県を見分ける。
 *
 * 【なぜ要るか】利用者の要望（2026-10-21）「修正/追加した都道府県がわかるようにしたい。配信する目安にしたい」。
 *   福島県を配信したら、狙った5本だけでなく 10/07 の配信のあとで非表示にした道もまとめて出て、150本 → 121本になった。
 *   どの県にどれだけ配信していない変更が溜まっているかが、配信する前に見えなかった。
 *
 * 見分けるのは2段:
 *   1. 再生成が要る … 調整（`data/road-overrides`）を保存したあと、まだ生成（`buildRoadRecommend.js`）していない
 *        生成物に「どの調整で作ったか」の指紋（overridesHash）を残し、いまの調整の指紋と比べる。
 *        指紋の無い古い生成物は、調整ファイルの更新時刻と生成した時刻で比べる
 *   2. 配信待ち   … 生成物の中身の指紋（contentHash）が、本番（Firestore `road_recommend/<県>`）と違う
 * ⚠️ 調整を保存するたびに全部の項目の updatedAt が書き直される（`PUT /api/roads/overrides`）。
 *    updatedAt を指紋に入れると、何も変えずに保存しただけで「再生成が要る」になるので外す
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { overrideKey } = require("./roadOverrides");

/**
 * 本番と手元を見比べる鍵（道路名＋始点）。
 * ⚠️ 調整の鍵（seg.overrideKey）は使わない。本番の古い配信には付いていないので、形を直した道が
 *    「消える1本・増える1本」に見えてしまう。どちらにもある名前と始点で比べる
 */
const positionKey = (s) => overrideKey({ name: s.name, start: s.start });

/** 値の並びを決めた JSON（鍵の順で指紋が変わらないように）。updatedAt は外す */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => k !== "updatedAt").sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** 調整の指紋。生成（`buildRoadRecommend.js`）と画面の判定で同じものを使う */
function overridesSignature(raw) {
  const body = { overrides: (raw && raw.overrides) || {}, added: (raw && raw.added) || {} };
  return crypto.createHash("sha1").update(stable(body)).digest("hex").slice(0, 12);
}

/** 調整ファイルの指紋（無ければ空の調整の指紋） */
function overridesSignatureOfFile(file) {
  try { return overridesSignature(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch { return overridesSignature(null); }
}

/**
 * 1県の状態。
 * @param {object} p
 * @param {object|null} p.local     生成物（`data/road-recommend/<県>.json`）
 * @param {object|null} p.overrides 調整ファイルの中身（無ければ null）
 * @param {number|null} p.overridesMtimeMs 調整ファイルの更新時刻（指紋の無い古い生成物と比べる）
 * @param {object|null} p.deployed  本番の `road_recommend/<県>`（count・contentHash・updatedAt）
 * @returns {{ state: "unbuilt"|"rebuild"|"publish"|"same", rebuildNeeded: boolean, publishNeeded: boolean }}
 *   state は画面に出す1つ（再生成が要るなら再生成を先に言う。再生成しないと配信の中身が決まらないため）
 */
function pendingStatus({ local, overrides, overridesMtimeMs = null, deployed }) {
  if (!local) return { state: "unbuilt", rebuildNeeded: true, publishNeeded: !!deployed };
  const rebuildNeeded = local.overridesHash
    ? local.overridesHash !== overridesSignature(overrides)
    : (overridesMtimeMs != null && local.builtAt && overridesMtimeMs > Date.parse(local.builtAt));
  const publishNeeded = !deployed || !deployed.contentHash || deployed.contentHash !== local.contentHash;
  return {
    state: rebuildNeeded ? "rebuild" : publishNeeded ? "publish" : "same",
    rebuildNeeded: !!rebuildNeeded, publishNeeded,
  };
}

/** 道の見出し（表示名があればそちら） */
const labelOf = (s) => s.title || s.name;

/**
 * 本番と手元の配信データの差（道ごと）。鍵は調整と同じ（道路名＋始点）。
 * @returns {{ added: object[], removed: object[], changed: object[] }}
 *   changed[].what … "札" / "表示名" / "説明" / "形" / "有料"（点数だけの変化は数えない。重みで全部動くため）
 */
function diffDelivered(deployedSegments = [], localSegments = []) {
  const before = new Map(deployedSegments.map((s) => [positionKey(s), s]));
  const after = new Map(localSegments.map((s) => [positionKey(s), s]));
  const added = [], removed = [], changed = [];
  for (const [key, s] of after) {
    const old = before.get(key);
    if (!old) { added.push({ key, name: labelOf(s) }); continue; }
    const what = [];
    if ((old.tags || []).join("|") !== (s.tags || []).join("|")) what.push("札");
    if ((old.title || "") !== (s.title || "")) what.push("表示名");
    if ((old.note || "") !== (s.note || "")) what.push("説明");
    if (old.polyline !== s.polyline) what.push("形");
    if ((old.toll || "") !== (s.toll || "")) what.push("有料");
    if (what.length) changed.push({ key, name: labelOf(s), what });
  }
  for (const [key, s] of before) if (!after.has(key)) removed.push({ key, name: labelOf(s) });
  return { added, removed, changed };
}

module.exports = { overridesSignature, overridesSignatureOfFile, pendingStatus, diffDelivered };
