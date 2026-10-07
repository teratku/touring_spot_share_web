"use strict";

/**
 * セーフサーチで印が付いた画像を、開発者が見て判断する（管理ツール /moderation）。
 *
 * ⚠️ 利用者の判断（2026-10-07）: 引っかかった画像は開発者が判断する（画像は消さない）。
 *    印は関数 moderateUploadedImage（functions/imageModeration.js）が image_moderation に書く。
 * ⚠️ ここで書くのは「問題なし」（status: ok）だけ。投稿を消すときは今までの手順で消す
 */

/** 置き場のパス（images/abc.jpg）からファイル名（abc.jpg） */
const fileNameOf = (path) => String(path || "").split("/").pop();

/** Storage の公開の URL（images/・userIcon/ は誰でも読めるルール） */
const publicUrl = (bucket, path) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;

/**
 * まだ判断していない印（status: pending）と、その写真を使っている投稿。
 * ⚠️ 投稿は imagedownload の imageName（代表の写真）か locationImageNames（写真の一覧）で探す
 */
async function loadPendingFlags(db) {
  const snap = await db.collection("image_moderation").where("status", "==", "pending").get();
  const items = [];
  for (const d of snap.docs) {
    const x = d.data();
    const name = fileNameOf(x.path);
    let spot = null;
    if (x.kind === "post" && name) {
      const [byList, byMain] = await Promise.all([
        db.collection("imagedownload").where("locationImageNames", "array-contains", name).limit(1).get(),
        db.collection("imagedownload").where("imageName", "==", name).limit(1).get(),
      ]);
      const hit = byList.docs[0] || byMain.docs[0];
      if (hit) {
        const s = hit.data();
        spot = { id: hit.id, name: s.location_name || "", place: [s.administrative, s.locality].filter(Boolean).join("") };
      }
    }
    items.push({
      id: d.id, path: x.path, kind: x.kind, reasons: x.reasons || [],
      flaggedAt: x.flaggedAt && x.flaggedAt.toDate ? x.flaggedAt.toDate().toISOString() : null,
      url: publicUrl(x.bucket, x.path), spot,
    });
  }
  return items.sort((a, b) => String(b.flaggedAt).localeCompare(String(a.flaggedAt)));
}

module.exports = { fileNameOf, publicUrl, loadPendingFlags };
