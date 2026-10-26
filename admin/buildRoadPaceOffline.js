#!/usr/bin/env node
/**
 * buildRoadPaceOffline.js
 *
 * 共有（公開）されたルートと、解析に同意した人のバックアップから、おすすめ道路ごとの走りの速さを PC で計算し、
 * 本番の road_pace_offline/{uid} に書く（関数 roadPaceStats がアプリから届いた road_pace と合わせて集計する）。
 *
 * ⚠️ 利用者の判断（2026-10-26）:
 *   - 共有ルート: **ポリシーに書いて使う**。ただし本人が設定で「共有したルートを使わない」を選んだ人
 *     （user_taste/{uid}.roadPaceExcludeShared == true）は使わない
 *   - バックアップ: **解析に同意した人の分だけ**（user_taste/{uid}.roadPaceShare == true。アプリの設定をオンにすると書かれる）
 * ⚠️ 計算はアプリと同じ（lib/roadPaceCalc.js）。道の鍵も同じ（public/roads-lib.js の grouped）。配信中の道で当てる
 * ⚠️ 書くのは道ごとの数字だけ（年-月・長さ・速さ・止まり）。線・時刻・ルートの名前は書かない
 * ⚠️ 排気量は分からないので cc は "unknown"（集計は原付一種だけを外すので、そのまま数える）
 *
 * 使い方:
 *   node buildRoadPaceOffline.js            # 計算して結果を見るだけ（書かない）
 *   node buildRoadPaceOffline.js --commit   # 本番の road_pace_offline に書く（毎回まるごと作り直す）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const R = require("../public/roads-lib.js");
const { ridesOnRoads, ridePayload, pointsFromRouteJson } = require("./lib/roadPaceCalc");

const COMMIT = process.argv.includes("--commit");
const PROJECT_ID = "biketeilen";
const BUCKET = "biketeilen.appspot.com";
const OUT = "road_pace_offline";
/** 1本の道に残す回数（アプリと同じ） */
const MAX_RIDES = 10;

function init() {
  if (!admin.apps.length) {
    const keyPath = path.join(__dirname, "serviceAccount.json");
    admin.initializeApp({
      projectId: PROJECT_ID, storageBucket: BUCKET,
      credential: fs.existsSync(keyPath) ? admin.credential.cert(require(keyPath)) : admin.credential.applicationDefault(),
    });
  }
  return { db: admin.firestore(), bucket: admin.storage().bucket() };
}

/** 配信中のおすすめ道路（アプリ・Web と同じ道の鍵で） */
async function loadRoads(db, bucket) {
  const idx = await db.collection("road_recommend").doc("_index").get();
  const prefs = Object.values((idx.exists && idx.data().prefectures) || {}).filter((e) => e && e.fileName);
  const segments = [];
  for (const e of prefs) {
    try {
      const [buf] = await bucket.file(`Json/road_recommend/${e.fileName}`).download();
      segments.push(...(JSON.parse(buf.toString("utf8")).segments || []));
    } catch (err) {
      console.warn(`  ⚠️ ${e.prefecture} の配信を読めない: ${err.message}`);
    }
  }
  return R.grouped(segments).map((r) => ({ id: r.id, name: r.name, lines: r.polylines.map(R.decodePolyline) }));
}

/** 本人の選んだこと（user_taste の印） */
async function loadConsent(db) {
  const snap = await db.collection("user_taste").get();
  const share = new Set(), excludeShared = new Set();
  snap.forEach((d) => {
    const x = d.data() || {};
    if (x.roadPaceShare === true) share.add(d.id);
    if (x.roadPaceExcludeShared === true) excludeShared.add(d.id);
  });
  return { share, excludeShared };
}

/** uid → 道の鍵 → {name, rides} に足す */
function add(store, uid, found, atMs, source) {
  const roads = store.get(uid) || {};
  for (const [key, { name, ride }] of Object.entries(found)) {
    const entry = roads[key] || { name, rides: [] };
    entry.rides.push(ridePayload(ride, "unknown", atMs, source));
    roads[key] = entry;
  }
  store.set(uid, roads);
}

async function main() {
  const { db, bucket } = init();
  console.log(`${COMMIT ? "計算して書く" : "計算だけ（書きません）"}\n`);
  const roads = await loadRoads(db, bucket);
  console.log(`配信中のおすすめ道路 ${roads.length}本`);
  const { share, excludeShared } = await loadConsent(db);
  console.log(`解析に同意した人 ${share.size}人・共有ルートを使わない人 ${excludeShared.size}人\n`);

  const store = new Map();
  const stat = { shared: 0, sharedUsed: 0, backup: 0, backupUsed: 0, skipped: 0 };

  // ---- 共有（公開）されたルート ----
  const shared = await db.collection("shared_routes").get();
  for (const doc of shared.docs) {
    const x = doc.data() || {};
    stat.shared += 1;
    if (!x.userID || !x.jsonUrl || excludeShared.has(x.userID)) { stat.skipped += 1; continue; }
    try {
      const res = await fetch(x.jsonUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const points = pointsFromRouteJson(await res.json());
      const found = ridesOnRoads(points, roads);
      if (Object.keys(found).length) { add(store, x.userID, found, points[0].t, "shared"); stat.sharedUsed += 1; }
      console.log(`  共有 ${String(doc.id).slice(0, 6)}… ${points.length}点 → ${Object.values(found).map((f) => `${f.name} ${f.ride.kmh}km/h`).join("・") || "おすすめ道路なし"}`);
    } catch (e) {
      console.warn(`  ⚠️ 共有 ${doc.id} を読めない: ${e.message}`);
    }
  }

  // ---- 同意した人のバックアップ ----
  for (const uid of share) {
    const routes = await db.collection("route_backups").doc(uid).collection("routes").get();
    for (const doc of routes.docs) {
      const x = doc.data() || {};
      stat.backup += 1;
      if (!x.storagePath) continue;
      try {
        const [buf] = await bucket.file(x.storagePath).download();
        const points = pointsFromRouteJson(JSON.parse(buf.toString("utf8")));
        const found = ridesOnRoads(points, roads);
        if (Object.keys(found).length) { add(store, uid, found, points[0].t, "backup"); stat.backupUsed += 1; }
      } catch (e) {
        console.warn(`  ⚠️ バックアップ ${doc.id} を読めない: ${e.message}`);
      }
    }
  }

  // ---- まとめ ----
  const roadCount = new Map();
  for (const roadsOf of store.values()) {
    for (const [key, e] of Object.entries(roadsOf)) {
      e.rides = e.rides.sort((a, b) => (a.ym < b.ym ? 1 : -1)).slice(0, MAX_RIDES);
      roadCount.set(key, (roadCount.get(key) || { name: e.name, users: 0 }));
      roadCount.get(key).users += 1;
    }
  }
  console.log(`\n共有ルート ${stat.shared}本（使った ${stat.sharedUsed}・使わない ${stat.skipped}）・バックアップ ${stat.backup}本（使った ${stat.backupUsed}）`);
  console.log(`走った人 ${store.size}人・道 ${roadCount.size}本`);
  for (const [key, v] of [...roadCount.entries()].sort((a, b) => b[1].users - a[1].users).slice(0, 15)) {
    console.log(`  ${v.name}（${key}） ${v.users}人`);
  }

  if (!COMMIT) { console.log("\n書くには --commit を付けてください"); return; }
  // ⚠️ 毎回まるごと作り直す（使わないと選んだ人・共有をやめた人の分を残さない）
  const old = await db.collection(OUT).get();
  const batch = db.batch();
  for (const d of old.docs) if (!store.has(d.id)) batch.delete(d.ref);
  for (const [uid, roadsOf] of store) {
    batch.set(db.collection(OUT).doc(uid), { uid, roads: roadsOf, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  await batch.commit();
  console.log(`\n⬆️  ${OUT} に ${store.size}人分を書きました（翌朝の roadPaceStats で集計に入ります）`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { add };
