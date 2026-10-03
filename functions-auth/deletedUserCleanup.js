/**
 * functions/deletedUserCleanup.js
 *
 * アカウントが消えたときに、その人だけのデータ（文書の ID が uid のもの）を消す（`cleanupDeletedUser`）。
 *
 * ⚠️ 利用者の判断（2026-10-03）: 利用規約とプライバシーポリシーを今のアプリに合わせるにあたり、退会処理も直す。
 *   - 課金の状態（subscriptions/{uid}）と紹介の記録（referralRewards/{uid}・referralRewardEvents/{uid}）は、
 *     規則（firestore.rules）でアプリから消せない。ここで消す
 *   - それ以外はアプリ（AccountDeletion.swift）が退会のときに消す。ここでは消し損ねを念のため消す
 *   - 公開した投稿（スポット・口コミ・共有ルート）はアプリが消す。ここでは触らない
 *
 * ⚠️ referralRewardEvents/{uid} は「この人を紹介した報酬を付与済み」の印（多重付与の防止）。
 *    消えた uid は二度と使われないので、消しても多重付与は起きない
 */
"use strict";

/** 消す文書（配下のコレクションごと） */
function privateDocPaths(uid) {
  if (typeof uid !== "string" || !uid || uid.includes("/")) throw new Error(`uid が悪い: ${uid}`);
  return [
    `subscriptions/${uid}`,
    `referralRewards/${uid}`,
    `referralRewardEvents/${uid}`,
    `users/${uid}`, // プラン・スタンプ
    `route_backups/${uid}`, // ルート記録のバックアップ（走った軌跡）
    `user_stats/${uid}`,
    `road_completion/${uid}`,
    `micinoEkiBackUp/${uid}`,
    `selectedLocationBackup/${uid}`,
    `userInfo/${uid}`, // プロフィール・バッジ
  ];
}

/** 消す Storage のフォルダ */
function privateStoragePrefixes(uid) {
  privateDocPaths(uid); // uid を確かめる
  return [
    `route_backups/${uid}/`, // ルート記録のバックアップ（走った軌跡・写真）
    `selectedLocationBackup/${uid}.json`, // 選んだスポットの控え
  ];
}

/**
 * 消す。1か所の失敗で止めず、失敗した場所を返す。
 * @param {string} uid
 * @param {{ db: { doc(path: string): unknown, recursiveDelete(ref: unknown): Promise<unknown> },
 *           bucket: { deleteFiles(opts: { prefix: string }): Promise<unknown> } }} deps
 * @returns {Promise<string[]>} 失敗した場所
 */
async function cleanupDeletedUser(uid, { db, bucket }) {
  const failures = [];
  for (const path of privateDocPaths(uid)) {
    try {
      await db.recursiveDelete(db.doc(path));
    } catch (e) {
      failures.push(path);
    }
  }
  for (const prefix of privateStoragePrefixes(uid)) {
    try {
      await bucket.deleteFiles({ prefix });
    } catch (e) {
      failures.push(prefix);
    }
  }
  return failures;
}

module.exports = { privateDocPaths, privateStoragePrefixes, cleanupDeletedUser };
