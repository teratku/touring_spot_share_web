/**
 * functions-auth/index.js
 *
 * アカウントが消えたときに、その人だけのデータを消す（退会。deletedUserCleanup.js）。
 *
 * ⚠️ 課金の状態・紹介の記録は規則でアプリから消せないので、ここで消す。ほかはアプリの消し損ねの念押し
 * ⚠️ **このフォルダを functions/ にまとめないこと。** 「アカウントが消えた」のきっかけは第1世代にしか無く、
 *    第1世代は Node.js 24 で動かない（2026-10-03 の配信で "Runtime nodejs24 is not supported on GCF Gen1"）。
 *    functions/ は Node.js 24 のまま、ここだけ Node.js 22（firebase.json の codebase "auth"）
 */
"use strict";
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const { cleanupDeletedUser } = require("./deletedUserCleanup");

admin.initializeApp();

exports.cleanupDeletedUser = functions.auth.user().onDelete(async (user) => {
  const failures = await cleanupDeletedUser(user.uid, {
    db: admin.firestore(),
    bucket: admin.storage().bucket(),
  });
  if (failures.length) {
    console.warn(`cleanupDeletedUser: uid=${user.uid} 消し損ね ${failures.join(", ")}`);
  } else {
    console.log(`cleanupDeletedUser: uid=${user.uid} 消しました`);
  }
  return null;
});
