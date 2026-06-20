"use strict";
/**
 * rallyValidation.js
 * スタンプラリーJSONの検証＋書込み用ドキュメント正規化。
 * server.js（ローカル管理UIのupsert）で使用。
 * ※検証規則は importRallies.js のインライン版と同一に保つこと（仕様変更時は両方を更新）。
 */

// 季節キーワード → 稼働月(1-12)。空配列=通年。JSON は activeMonths を直接指定してもよい。
const SEASON_MONTHS = {
  all: [], 通年: [],
  spring: [3, 4, 5], 春: [3, 4, 5],
  summer: [6, 7, 8], 夏: [6, 7, 8], 夏季: [6, 7, 8],
  autumn: [9, 10, 11], fall: [9, 10, 11], 秋: [9, 10, 11],
  winter: [12, 1, 2], 冬: [12, 1, 2], 冬季: [12, 1, 2],
};

function fail(msg) {
  throw new Error(msg);
}
function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 1ラリーJSONを検証して、書込み用に正規化したオブジェクトを返す。
 * @param {object} json     ラリー定義
 * @param {string} fileLabel エラー表示用ラベル
 * @param {number|string|null} expectedYear --year 指定（任意。整合チェック）
 * @param {object} admin    firebase-admin（Timestamp / FieldValue 用）
 * @returns {{rallyId:string, doc:object, targetCount:number}}
 */
function validateRally(json, fileLabel, expectedYear, admin) {
  const where = (m) => `${fileLabel}: ${m}`;

  if (!json || typeof json !== "object") fail(where("JSONがオブジェクトではありません"));
  const { rallyId, name, theme, fiscalYear, startAt, endAt, targets } = json;

  if (typeof rallyId !== "string" || !rallyId.trim()) fail(where("rallyId が必要です"));
  if (typeof name !== "string" || !name.trim()) fail(where("name が必要です"));
  if (typeof theme !== "string" || !theme.trim()) fail(where("theme が必要です"));
  if (!Number.isInteger(fiscalYear)) fail(where("fiscalYear（整数）が必要です"));
  if (expectedYear != null && fiscalYear !== Number(expectedYear)) {
    fail(where(`fiscalYear(${fiscalYear}) が --year(${expectedYear}) と不一致`));
  }

  const start = new Date(startAt);
  const end = new Date(endAt);
  if (isNaN(start.getTime())) fail(where("startAt が日付として不正です"));
  if (isNaN(end.getTime())) fail(where("endAt が日付として不正です"));
  if (start >= end) fail(where("startAt は endAt より前である必要があります"));

  if (!Array.isArray(targets) || targets.length === 0) fail(where("targets（1件以上）が必要です"));

  const seenTargetIds = new Set();
  const normTargets = targets.map((t, idx) => {
    const lbl = where(`targets[${idx}]`);
    if (!t || typeof t !== "object") fail(`${lbl} がオブジェクトではありません`);
    if (typeof t.targetId !== "string" || !t.targetId.trim()) fail(`${lbl}.targetId が必要です`);
    if (seenTargetIds.has(t.targetId)) fail(`${lbl}.targetId が重複: ${t.targetId}`);
    seenTargetIds.add(t.targetId);
    if (typeof t.name !== "string" || !t.name.trim()) fail(`${lbl}.name が必要です`);
    if (!isFiniteNum(t.lat) || t.lat < -90 || t.lat > 90) fail(`${lbl}.lat が不正（-90..90）`);
    if (!isFiniteNum(t.lng) || t.lng < -180 || t.lng > 180) fail(`${lbl}.lng が不正（-180..180）`);

    const out = {
      targetId: t.targetId,
      name: t.name,
      lat: t.lat,
      lng: t.lng,
      order: Number.isInteger(t.order) ? t.order : idx + 1,
    };
    if (t.spotId) out.spotId = String(t.spotId);
    if (t.address) out.address = String(t.address);
    if (t.imageURL) out.imageURL = String(t.imageURL);
    return out;
  });

  // 書込み用ドキュメント（_note 等のアンダースコア始まりキーは捨てる）
  const doc = {
    rallyId,
    name,
    theme,
    fiscalYear,
    startAt: admin.firestore.Timestamp.fromDate(start),
    endAt: admin.firestore.Timestamp.fromDate(end),
    targets: normTargets,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (json.region) doc.region = String(json.region);
  if (json.description) doc.description = String(json.description);
  if (json.coverImageURL) doc.coverImageURL = String(json.coverImageURL);
  if (json.rewardBadgeId) doc.rewardBadgeId = String(json.rewardBadgeId);
  if (json.completionTitle) doc.completionTitle = String(json.completionTitle);

  // 季節限定（任意）。activeMonths を優先、無ければ season キーワードを展開。空=通年。
  let activeMonths = null;
  if (json.activeMonths != null) {
    if (!Array.isArray(json.activeMonths)) fail(where("activeMonths は月(1-12)の配列で指定してください"));
    activeMonths = json.activeMonths;
  } else if (json.season != null) {
    const raw = String(json.season);
    const months = SEASON_MONTHS[raw.toLowerCase()] ?? SEASON_MONTHS[raw];
    if (months === undefined) {
      fail(where(`season が不明: ${raw}（all/spring/summer/autumn/winter または 通年/春/夏/秋/冬）`));
    }
    activeMonths = months;
  }
  if (activeMonths) {
    for (const m of activeMonths) {
      if (!Number.isInteger(m) || m < 1 || m > 12) fail(where(`activeMonths に不正な月: ${m}（1-12）`));
    }
    doc.activeMonths = [...new Set(activeMonths)].sort((a, b) => a - b);
  }

  return { rallyId, doc, targetCount: normTargets.length };
}

module.exports = { SEASON_MONTHS, fail, isFiniteNum, validateRally };
