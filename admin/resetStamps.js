#!/usr/bin/env node
/**
 * resetStamps.js — テスト用: ユーザーの獲得スタンプを削除（admin SDK・Firestoreルール非依存で確実）。
 *
 * 使い方:
 *   node resetStamps.js --uid <uid>                 # そのユーザーの全スタンプ削除
 *   node resetStamps.js --uid <uid> --rally <id>    # 特定ラリーのみ
 *   node resetStamps.js --uid <uid> --dry-run       # 対象確認のみ（削除しない）
 *
 * 認証は importRallies.js と同じ（serviceAccount.json か gcloud ADC）。
 * ※ 完了バッジ(userInfo/{uid}/badges/{rewardBadgeId})は触りません。必要なら別途削除。
 */
"use strict";
const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";
function initAdmin() {
  const sa = path.join(__dirname, "serviceAccount.json");
  if (fs.existsSync(sa)) admin.initializeApp({ credential: admin.credential.cert(require(sa)), projectId: PROJECT_ID });
  else admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
}
function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }

const UID = argVal("--uid");
const RALLY = argVal("--rally");
const DRY = process.argv.includes("--dry-run");

async function main() {
  if (!UID) { console.error("使い方: node resetStamps.js --uid <uid> [--rally <id>] [--dry-run]"); process.exit(1); }
  initAdmin();
  const db = admin.firestore();

  let q = db.collection("users").doc(UID).collection("stamps");
  if (RALLY) q = q.where("rallyId", "==", RALLY);
  const snap = await q.get();

  console.log(`対象スタンプ: ${snap.size} 件${RALLY ? `（rally=${RALLY}）` : "（全ラリー）"} / mode=${DRY ? "DRY-RUN(確認のみ)" : "DELETE(削除)"}`);
  snap.forEach((d) => console.log("  -", d.id, "| rallyId=", d.data().rallyId, "| fy=", d.data().fiscalYear));

  if (DRY) { console.log("🧪 DRY-RUN 完了（削除なし）"); return; }
  if (snap.empty) { console.log("削除対象なし"); return; }

  const batch = db.batch();
  snap.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  console.log(`✅ ${snap.size} 件のスタンプを削除しました`);
}
main().catch((e) => { console.error("❌", e.message); process.exit(1); });
