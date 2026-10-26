#!/usr/bin/env node
/**
 * buildRoadPaceOffline.js
 *
 * 共有（公開）されたルートと、解析に同意した人のバックアップから、おすすめ道路ごとの走りの速さを PC で計算する。
 * 本体は関数と同じ functions/roadPaceOffline.js（ページの「解析を始める」＝関数 runRoadPaceAnalysis と同じ答え）。
 *
 * ⚠️ 利用者の判断（2026-10-26）: 共有ルートはポリシーに書いて使う（本人が外せる）・バックアップは同意した人だけ。
 *    ふだんはページ（/dev/road-pace.html）から始める。これは手元で中身を見たいとき用
 * ⚠️ --commit で書いたときも解析の記録（road_pace_runs・via "pc"）を残す（ページの「前回から更新」に効く）。
 *    公開の集計（road_pace_stats）は作り直さない（翌朝の roadPaceStats か、ページから）
 *
 * 使い方:
 *   node buildRoadPaceOffline.js            # 計算して結果を見るだけ（書かない）
 *   node buildRoadPaceOffline.js --commit   # 本番の road_pace_offline をまるごと作り直す
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const paceOffline = require("../functions/roadPaceOffline");
const { loadPaceDocs, tallyRoadPace, MIN_USERS } = require("../functions/roadPace");

const COMMIT = process.argv.includes("--commit");

function init() {
  if (!admin.apps.length) {
    const keyPath = path.join(__dirname, "serviceAccount.json");
    admin.initializeApp({
      projectId: "biketeilen", storageBucket: "biketeilen.appspot.com",
      credential: fs.existsSync(keyPath) ? admin.credential.cert(require(keyPath)) : admin.credential.applicationDefault(),
    });
  }
  return { db: admin.firestore(), bucket: admin.storage().bucket() };
}

async function summary(db) {
  const docs = await loadPaceDocs(db);
  const all = tallyRoadPace(docs, { minUsers: 1 });
  return { roads: all.length, publicRoads: all.filter((r) => r.users >= MIN_USERS).length, riders: new Set(docs.map((d) => d.uid)).size };
}

async function main() {
  const { db, bucket } = init();
  console.log(`${COMMIT ? "計算して書く" : "計算だけ（書きません）"}\n`);
  const [inputs, last] = await Promise.all([paceOffline.collectInputs(db), paceOffline.lastRun(db)]);
  const app = await paceOffline.appUploads(db, last ? paceOffline.millis(last.ranAt) : 0);
  const p = paceOffline.pendingSince(last, inputs, app);
  console.log(`前回の解析: ${p.lastRunAt ? new Date(p.lastRunAt).toLocaleString("ja-JP") : "まだ"}` +
    `　増えた共有ルート ${p.newShared}・消えた ${p.goneShared}・更新されたバックアップ ${p.newBackups}・同意 +${p.consentAdded}/-${p.consentRemoved}`);
  console.log(`同意した人 ${inputs.consent.length}人・共有ルートを使わない人 ${inputs.exclude.length}人\n`);

  const before = await summary(db);
  const { store, stat } = await paceOffline.computeOffline({ db, bucket, inputs, log: (m) => console.log("  " + m) });
  console.log(`\n共有ルート ${stat.shared}本（使った ${stat.sharedUsed}）・バックアップ ${stat.backup}本（使った ${stat.backupUsed}）・読めない ${stat.failed}`);
  console.log(`走った人 ${stat.riders}人・道 ${stat.roads}本・回 ${stat.rides}`);

  if (!COMMIT) { console.log("\n書くには --commit を付けてください（ふだんは /dev/road-pace.html の「解析を始める」）"); return; }
  await paceOffline.writeOffline(db, store, admin.firestore.FieldValue);
  const after = await summary(db);
  await paceOffline.recordRun(db, admin.firestore.FieldValue, { by: "pc", via: "pc", inputs, stat, before, after });
  console.log(`\n⬆️  road_pace_offline に ${store.size}人分を書きました（公開の集計は翌朝4:30 か、ページから）`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
