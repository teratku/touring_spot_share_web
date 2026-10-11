#!/usr/bin/env node
/**
 * auditPersonalFields.js
 *
 * 誰でも／ログインした人なら誰でも読める場所に残っている個人情報の「件数だけ」を数える（読むだけ）。
 *   - userInfo/{uid}.mailAddress           … ログインのメールアドレス（userInfo は read: if true）
 *   - user_deleting_scheduled/{id}.mT / pT  … 古い退会予約のメール／平文パスワード（read: if signedIn()）
 *
 * ⚠️ 値（メール・パスワード）は一切表示しない。件数だけ。
 *
 *   cd admin && node auditPersonalFields.js     # 認証は importRallies.js と同じ（serviceAccount.json か gcloud ADC）
 *
 * 消すのは cleanupPersonalFields.js（既定は dry-run）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";

function initAdmin() {
  const saPath = path.join(__dirname, "serviceAccount.json");
  if (fs.existsSync(saPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(saPath)), projectId: PROJECT_ID });
    console.log("🔑 認証: serviceAccount.json");
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
    console.log("🔑 認証: applicationDefault（gcloud ADC）");
  }
  console.log(process.env.FIRESTORE_EMULATOR_HOST
    ? `🧪 対象: エミュレータ（${process.env.FIRESTORE_EMULATOR_HOST}）`
    : `🌐 対象: 本番（${PROJECT_ID}）`);
}

function nonEmpty(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true; // 文字列以外でも何か入っていれば数える
}

async function main() {
  initAdmin();
  const db = admin.firestore();

  // userInfo: mailAddress だけを取り寄せる
  const ui = await db.collection("userInfo").select("mailAddress").get();
  let uiHas = 0, uiFieldButEmpty = 0;
  for (const d of ui.docs) {
    const v = d.get("mailAddress");
    if (nonEmpty(v)) uiHas++;
    else if (v !== undefined) uiFieldButEmpty++;
  }
  console.log("\n[userInfo]");
  console.log(`  文書の数                       : ${ui.size}`);
  console.log(`  mailAddress が入っている        : ${uiHas}`);
  console.log(`  mailAddress はあるが空          : ${uiFieldButEmpty}`);

  // user_deleting_scheduled
  const ds = await db.collection("user_deleting_scheduled")
    .select("mT", "pT", "delete_type", "deletingUserID").get();
  let hasMT = 0, hasPT = 0, hasEither = 0;
  const ptUsers = new Set();
  const byType = {};
  for (const d of ds.docs) {
    const m = nonEmpty(d.get("mT"));
    const p = nonEmpty(d.get("pT"));
    if (m) hasMT++;
    if (p) {
      hasPT++;
      ptUsers.add(String(d.get("deletingUserID") || d.id));
      const t = String(d.get("delete_type") || "(なし)");
      byType[t] = (byType[t] || 0) + 1;
    }
    if (m || p) hasEither++;
  }
  console.log("\n[user_deleting_scheduled]");
  console.log(`  文書の数                       : ${ds.size}`);
  console.log(`  mT（メール）が入っている        : ${hasMT}`);
  console.log(`  pT（平文パスワード）が入っている: ${hasPT}`);
  console.log(`  mT か pT のどちらかが入っている : ${hasEither}`);
  console.log(`  pT が入っている利用者の数（重複除く）: ${ptUsers.size}`);
  console.log(`  pT ありの delete_type 内訳      : ${JSON.stringify(byType)}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌ " + (e && e.message ? e.message : e));
  process.exit(1);
});
