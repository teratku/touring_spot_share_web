/**
 * backfillSharedRouteSpots.js
 *
 * 共有ルート（shared_routes）に spotCount（共有する範囲に登録されたスポットの数）を付ける。一覧（Web・アプリ）の「📷 スポット n」に使う。
 *
 * ⚠️ 利用者の要望（2026-10-29）:「Web の一覧でもスポット付きのルートがわかるようにしたい」「アプリの一覧でも同じく」。
 *    10/29 以降はアプリが共有のときに書く。それより前の共有ルートにはこれで付ける
 * ⚠️ 数え方は public/route-spots.js（アプリの SharedRouteShareText.spotMarkers の写し）。共有 JSON の印から数える
 * ⚠️ 10/29 より前の共有 JSON には印が無い（アプリが落としていた）ので、ほとんどは 0 のまま。0 は書かない
 *
 *   node backfillSharedRouteSpots.js           # 試すだけ（本番を読むだけ）
 *   node backfillSharedRouteSpots.js --commit  # spotCount だけを書く（ほかの項目には触れない）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { spotMarkers } = require("../public/route-spots.js");

const COMMIT = process.argv.includes("--commit");

async function main() {
  const keyPath = path.join(__dirname, "serviceAccount.json");
  admin.initializeApp({
    projectId: "biketeilen", storageBucket: "biketeilen.appspot.com",
    credential: fs.existsSync(keyPath) ? admin.credential.cert(require(keyPath)) : admin.credential.applicationDefault(),
  });
  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const snap = await db.collection("shared_routes").get();
  let withSpots = 0, written = 0, failed = 0;
  for (const doc of snap.docs) {
    const x = doc.data();
    if (!x.jsonFileName) continue;
    let count;
    try {
      const [buf] = await bucket.file(`routes/JSON/${x.jsonFileName}`).download();
      count = spotMarkers(JSON.parse(buf)).length;
    } catch (e) {
      failed++;
      console.log(`  ⚠️ ${doc.id} ${x.title || ""}: JSON を読めない（${e.message.slice(0, 60)}）`);
      continue;
    }
    if (!count) continue;
    withSpots++;
    const same = x.spotCount === count;
    console.log(`  ${same ? "＝" : "✏️ "} ${doc.id} ${x.title || ""}: スポット ${count}${same ? "（書き込み済み）" : ""}`);
    if (COMMIT && !same) {
      await doc.ref.update({ spotCount: count });
      written++;
    }
  }
  console.log(`\n共有ルート ${snap.size}件・スポット付き ${withSpots}件・読めない ${failed}件` +
    (COMMIT ? `・書いた ${written}件` : "（試すだけ。書くなら --commit）"));
}

main().catch((e) => { console.error(e); process.exit(1); });
