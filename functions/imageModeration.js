"use strict";

/**
 * 投稿画像のセーフサーチ（Cloud Vision）。
 *
 * ⚠️ 利用者のメモ（2026-10-07 に実装）:「投稿画像のセーフサーチ（Cloud Vision API）」。
 *    利用者の判断: **引っかかった画像は開発者が判断する**（画像はそのまま。開発者の画面に印を付けて知らせ、人が消すか決める。
 *    誤判定で普通の写真が消えないように）。
 * ⚠️ 見るのは投稿の写真（images/）とプロフィール画像（userIcon/）だけ。一覧用の小さい写真（iconImage/）は
 *    同じ写真なので二重に数えない。ルートやバックアップは画像ではない
 * ⚠️ 費用: 1か月 1,000枚まで無料、その先は 1,000枚ごとに約1.5ドル（2026-10 時点）
 */

const LEVELS = ["UNKNOWN", "VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY"];

/**
 * どこから印を付けるか。
 * ⚠️ racy（きわどい）は VERY_LIKELY だけ。海辺や水着の写真が LIKELY になりやすく、バイクの写真で印だらけになる
 */
const THRESHOLDS = { adult: "LIKELY", violence: "LIKELY", racy: "VERY_LIKELY", medical: "VERY_LIKELY" };

/** 見る置き場（先頭）→ 種類 */
const TARGETS = { "images/": "post", "userIcon/": "userIcon" };

const levelOf = (value) => {
  if (typeof value === "number") return LEVELS[value] || "UNKNOWN";
  return LEVELS.includes(value) ? value : "UNKNOWN";
};

/**
 * セーフサーチの結果から、印を付けるかを決める。
 * @param {object} annotation Vision の safeSearchAnnotation（{adult: "LIKELY", ...}。数で来ることもある）
 * @returns {{flagged: boolean, reasons: string[], levels: object}}
 */
function judgeSafeSearch(annotation) {
  const levels = {};
  const reasons = [];
  for (const [key, threshold] of Object.entries(THRESHOLDS)) {
    const level = levelOf(annotation && annotation[key]);
    levels[key] = level;
    if (LEVELS.indexOf(level) >= LEVELS.indexOf(threshold)) reasons.push(`${key}:${level}`);
  }
  return { flagged: reasons.length > 0, reasons, levels };
}

/** 見る画像か。見るなら種類（post / userIcon）、見ないなら null */
function targetKind(name, contentType) {
  if (typeof name !== "string" || !(contentType || "").startsWith("image/")) return null;
  const prefix = Object.keys(TARGETS).find((p) => name.startsWith(p));
  return prefix ? TARGETS[prefix] : null;
}

/**
 * 上がった画像を調べ、引っかかったら image_moderation に控える（開発者だけが読める）。
 * ⚠️ 引っかからなかった画像は何も書かない（数が増えるだけで役に立たない）
 * @param {{bucket: string, name: string, contentType: string}} object Storage のオブジェクト
 * @param {{annotate: (uri: string) => Promise<object>, db: object, FieldValue: object}} deps
 */
async function moderateImage(object, { annotate, db, FieldValue }) {
  const kind = targetKind(object && object.name, object && object.contentType);
  if (!kind) return { skipped: true };
  const verdict = judgeSafeSearch(await annotate(`gs://${object.bucket}/${object.name}`));
  if (!verdict.flagged) return { flagged: false };
  await db.collection("image_moderation").doc(encodeURIComponent(object.name)).set({
    path: object.name,
    bucket: object.bucket,
    kind,
    reasons: verdict.reasons,
    levels: verdict.levels,
    status: "pending",
    flaggedAt: FieldValue.serverTimestamp(),
  });
  return { flagged: true, reasons: verdict.reasons };
}

module.exports = { LEVELS, THRESHOLDS, judgeSafeSearch, targetKind, moderateImage };
