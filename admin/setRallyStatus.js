#!/usr/bin/env node
/**
 * setRallyStatus.js
 *
 * スタンプラリーの公開状態（status）を変更する運用スクリプト。
 * 「停止・再開・終了・削除（論理）」をユーザーデータ無損失で行う。
 *
 * status の意味（アプリの StampRally.isActive() と対応）:
 *   active   … 通常公開（一覧表示・スタンプ獲得可能）
 *   paused   … 一時停止（一覧から除外・獲得不可・あとで再開可）
 *   ended    … 終了（一覧から除外・履歴には残る）
 *   archived … 論理削除（アプリ面から除外。マスタ文書は保持＝履歴の名前解決は可能）
 *
 * 使い方:
 *   cd admin && npm install                 # 初回のみ（firebase-admin）
 *   # 認証は importRallies.js と同じ（serviceAccount.json か gcloud ADC）
 *
 *   node setRallyStatus.js --list                         # 全ラリーの状態を一覧
 *   node setRallyStatus.js --list --year 2026
 *   node setRallyStatus.js --rally shimanami-2026 --status paused        # 一時停止
 *   node setRallyStatus.js --rally shimanami-2026 --status active        # 再開
 *   node setRallyStatus.js --rally shimanami-2026 --status ended --end-now
 *   node setRallyStatus.js --rally shimanami-2026 --status archived      # 論理削除（=削除）
 *   node setRallyStatus.js --year 2026 --status paused                   # 年度一括で停止
 *   node setRallyStatus.js --year 2025 --status archived                 # 年度一括で論理削除
 *   ...どの操作も --dry-run を付けると書込みせず確認だけ
 *
 * ⚠️ ユーザーの獲得スタンプ（users/{uid}/stamps）・バッジ・称号は一切変更しません（剥奪しません）。
 * ⚠️ 物理削除は行いません。「削除」は --status archived（論理削除）を使ってください。
 *    再インポート（importRallies.js は merge かつ status を書きません）でも status は保持されます。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";
const ALLOWED = ["active", "paused", "ended", "archived"];

// ---- 引数 ----
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const DRY_RUN = args.includes("--dry-run");
const LIST = args.includes("--list");
const END_NOW = args.includes("--end-now");
const RALLY = argVal("--rally");
const STATUS = argVal("--status");
const YEAR = argVal("--year");

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

// ---- 認証（importRallies.js と同じ） ----
function initAdmin() {
  const saPath = path.join(__dirname, "serviceAccount.json");
  if (fs.existsSync(saPath)) {
    admin.initializeApp({
      credential: admin.credential.cert(require(saPath)),
      projectId: PROJECT_ID,
    });
    console.log("🔑 認証: serviceAccount.json");
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: PROJECT_ID,
    });
    console.log("🔑 認証: applicationDefault（gcloud ADC）");
  }
}

// ---- 一覧 ----
async function runList(db) {
  let q = db.collection("stampRallies");
  if (YEAR) q = q.where("fiscalYear", "==", Number(YEAR));
  const snap = await q.get();
  if (snap.empty) {
    console.log("（該当ラリーなし）");
    return;
  }
  const rows = snap.docs
    .map((d) => {
      const x = d.data() || {};
      return { id: d.id, name: x.name || "", status: x.status || "active", fy: x.fiscalYear };
    })
    .sort((a, b) => b.fy - a.fy || a.id.localeCompare(b.id));

  console.log("fiscalYear  status      rallyId  (name)");
  for (const r of rows) {
    console.log(`  ${String(r.fy).padEnd(8)} ${String(r.status).padEnd(10)} ${r.id}  (${r.name})`);
  }
}

function ensureStatus() {
  if (!STATUS) fail(`--status <${ALLOWED.join("|")}> を指定してください`);
  if (!ALLOWED.includes(STATUS)) {
    fail(`--status は ${ALLOWED.join(" / ")} のいずれかです（指定: ${STATUS}）`);
  }
}

// ---- 年度一括 ----
async function runBulkYear(db) {
  ensureStatus();
  const snap = await db
    .collection("stampRallies")
    .where("fiscalYear", "==", Number(YEAR))
    .get();
  if (snap.empty) {
    console.log(`（${YEAR}年度のラリーはありません）`);
    return;
  }
  console.log(`年度 ${YEAR}: ${snap.size} 件 → status=${STATUS}${END_NOW ? "  + endAt=now" : ""}`);
  for (const d of snap.docs) {
    const x = d.data() || {};
    console.log(`  - ${d.id}  (${x.name || ""})  [現在: ${x.status || "active"}]`);
  }
  if (DRY_RUN) {
    console.log("🧪 DRY-RUN（書込みなし）");
    return;
  }
  const update = {
    status: STATUS,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (END_NOW) update.endAt = admin.firestore.Timestamp.fromDate(new Date());
  const batch = db.batch();
  snap.docs.forEach((d) => batch.set(d.ref, update, { merge: true }));
  await batch.commit();
  console.log(`✅ ${snap.size} 件を status=${STATUS} に更新しました`);
  console.log("ℹ️ ユーザーの獲得スタンプ・バッジ・称号は変更していません。");
}

// ---- 本体 ----
async function main() {
  initAdmin();
  const db = admin.firestore();

  if (LIST) {
    await runList(db);
    return;
  }

  // 単発(--rally) か 年度一括(--year) か
  if (!RALLY) {
    if (YEAR) {
      await runBulkYear(db);
      return;
    }
    fail("--rally <rallyId>（単発）か --year <年度>（年度一括）と --status を指定してください（一覧は --list）");
  }
  ensureStatus();

  const ref = db.collection("stampRallies").doc(RALLY);
  const cur = await ref.get();
  if (!cur.exists) fail(`stampRallies/${RALLY} が存在しません`);
  const before = cur.data() || {};

  console.log(`対象: ${RALLY}  (${before.name || ""})`);
  console.log(`  現在: status=${before.status || "active"}  fiscalYear=${before.fiscalYear}`);
  console.log(`  変更: status=${STATUS}${END_NOW ? "  + endAt=now" : ""}`);

  const update = {
    status: STATUS,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (END_NOW) update.endAt = admin.firestore.Timestamp.fromDate(new Date());

  if (DRY_RUN) {
    console.log("🧪 DRY-RUN（書込みなし）");
    return;
  }

  await ref.set(update, { merge: true });
  console.log(`✅ 反映: stampRallies/${RALLY} → status=${STATUS}`);
  console.log("ℹ️ ユーザーの獲得スタンプ・バッジ・称号は変更していません。");
}

main().catch((e) => {
  console.error("❌ エラー:", e.message);
  process.exit(1);
});
