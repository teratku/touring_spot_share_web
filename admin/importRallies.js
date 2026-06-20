#!/usr/bin/env node
/**
 * importRallies.js
 *
 * スタンプラリーのマスタ（admin/rallies/<年度>/*.json）を検証して
 * Firestore の stampRallies/{rallyId} に merge upsert する運用スクリプト。
 *
 * 使い方:
 *   cd admin && npm install            # 初回のみ
 *   # 認証（どちらか）
 *   #  a) gcloud auth application-default login
 *   #  b) admin/serviceAccount.json を置く（.gitignore 済み）
 *   node importRallies.js --year 2025 --dry-run   # 検証のみ（書込みなし）
 *   node importRallies.js --year 2025             # 投入（本番Firestore書込み）
 *   node importRallies.js --file rallies/2025/michinoeki-tohoku-2025.json
 *
 * ⚠️ 本番Firestoreに書き込みます。まず --dry-run で検証してください。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";

// ---- 引数 ----
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const DRY_RUN = args.includes("--dry-run");
const YEAR = argVal("--year");
const FILE = argVal("--file");

// ---- 認証 ----
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

// ---- 検証 ----
function fail(msg) {
  throw new Error(msg);
}
function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** 1ラリーJSONを検証して、書込み用に正規化したオブジェクトを返す */
function validateRally(json, fileLabel, expectedYear) {
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

  return { rallyId, doc, targetCount: normTargets.length };
}

// ---- 対象ファイル収集 ----
function collectFiles() {
  if (FILE) {
    const p = path.isAbsolute(FILE) ? FILE : path.join(__dirname, FILE);
    return [p];
  }
  if (!YEAR) fail("--year <年度> または --file <path> を指定してください");
  const dir = path.join(__dirname, "rallies", String(YEAR));
  if (!fs.existsSync(dir)) fail(`ディレクトリがありません: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));
}

// ---- 本体 ----
async function main() {
  const files = collectFiles();
  if (files.length === 0) {
    console.log("⚠️ 対象JSONがありません");
    return;
  }
  console.log(`📂 対象 ${files.length} 件 / mode=${DRY_RUN ? "DRY-RUN(検証のみ)" : "WRITE(本番書込み)"}`);

  // まず全件検証（1件でも不正なら中断＝部分投入を避ける）
  const validated = [];
  for (const file of files) {
    const label = path.relative(__dirname, file);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      fail(`${label}: JSON パース失敗 - ${e.message}`);
    }
    const expectedYear = YEAR ?? json.fiscalYear;
    const v = validateRally(json, label, expectedYear);
    validated.push(v);
    console.log(`  ✅ 検証OK: ${v.rallyId}（targets ${v.targetCount}）`);
  }

  if (DRY_RUN) {
    console.log("🧪 DRY-RUN 完了（書込みなし）");
    return;
  }

  initAdmin();
  const db = admin.firestore();
  for (const v of validated) {
    await db.collection("stampRallies").doc(v.rallyId).set(v.doc, { merge: true });
    console.log(`  ⬆️  upsert: stampRallies/${v.rallyId}`);
  }
  console.log(`🎉 投入完了: ${validated.length} 件`);
}

main().catch((e) => {
  console.error("❌ エラー:", e.message);
  process.exit(1);
});
