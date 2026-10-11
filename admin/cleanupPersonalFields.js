#!/usr/bin/env node
/**
 * cleanupPersonalFields.js
 *
 * 誰でも／ログインした人なら誰でも読める場所に残っている個人情報のフィールドを FieldValue.delete() で消す。
 *   - userInfo/{uid}.mailAddress
 *   - user_deleting_scheduled/{id}.mT / pT（と、昔の試験用 user_deleting_scheduled_test）
 *     ※ deletingUserID と delete_type は loginView.swift の checkDeletingUser が読むので残す
 *
 * ⚠️ 既定は dry-run（書き込まない）。本番に書くのは --apply を付けたときだけ。
 * ⚠️ 値（メール・パスワード）は一切表示しない。件数だけ。
 *
 *   cd admin && node cleanupPersonalFields.js            # dry-run（数えるだけ）
 *   cd admin && node cleanupPersonalFields.js --apply    # 本番に書く
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";
const APPLY = process.argv.slice(2).includes("--apply");

const TARGETS = [
  { collection: "userInfo", fields: ["mailAddress"] },
  { collection: "user_deleting_scheduled", fields: ["mT", "pT"] },
  { collection: "user_deleting_scheduled_test", fields: ["mT", "pT"] },
];

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
  console.log(APPLY ? "✍️  --apply: 書き込みます" : "👀 dry-run: 書き込みません（--apply で実行）");
}

async function main() {
  initAdmin();
  const db = admin.firestore();
  const del = admin.firestore.FieldValue.delete();

  for (const { collection, fields } of TARGETS) {
    const snap = await db.collection(collection).select(...fields).get();
    // 値が空でもフィールドがあれば消す（空文字も残す理由がない）
    const hits = snap.docs.filter((d) => fields.some((f) => d.get(f) !== undefined));
    const perField = Object.fromEntries(fields.map((f) => [f, hits.filter((d) => d.get(f) !== undefined).length]));
    console.log(`\n[${collection}] 文書 ${snap.size} 件中、消す対象 ${hits.length} 件 ${JSON.stringify(perField)}`);
    if (!APPLY || hits.length === 0) continue;

    let done = 0;
    for (let i = 0; i < hits.length; i += 400) {
      const batch = db.batch();
      for (const d of hits.slice(i, i + 400)) {
        const update = {};
        for (const f of fields) if (d.get(f) !== undefined) update[f] = del;
        batch.update(d.ref, update);
      }
      await batch.commit();
      done += Math.min(400, hits.length - i);
      console.log(`  ✅ ${done}/${hits.length}`);
    }

    // 消えたかを確かめる
    const after = await db.collection(collection).select(...fields).get();
    const left = after.docs.filter((d) => fields.some((f) => d.get(f) !== undefined)).length;
    console.log(`  確認: 残り ${left} 件`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌ " + (e && e.message ? e.message : e));
  process.exit(1);
});
