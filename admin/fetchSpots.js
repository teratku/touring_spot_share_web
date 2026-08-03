#!/usr/bin/env node
/**
 * fetchSpots.js
 *
 * 投稿スポットの座標を Firestore から落として `data/spots.json` に置く。
 * おすすめ道路の「景色の加点」（lib/scenerySpots.js）が使う。
 *
 * 【なぜ生成と分けるのか】
 * buildRoadRecommend.js は手元のCSVだけで完結する（オフラインで何度でも回せる）。
 * そこに Firestore アクセスを混ぜると、通信が落ちただけで生成が止まる。
 * 取得はこちらに切り出し、生成側は「あれば使う」に留める。
 *
 * 【使い方】
 *   node fetchSpots.js              # data/spots.json を作り直す
 *   node fetchSpots.js --dry-run    # 件数だけ見る（書き込まない）
 *
 * 認証は importRoadRecommend.js と同じ:
 *   a) gcloud auth application-default login
 *   b) admin/serviceAccount.json を置く（.gitignore 済み）
 *
 * ⚠️ 読み取り専用。ここから Firestore へ書き込むことはない。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";
const COLLECTION = "imagedownload";
const OUT = path.join(__dirname, "data", "spots.json");
const DRY_RUN = process.argv.includes("--dry-run");

/** 日本の緯度経度のおおよその範囲。桁を間違えた座標を弾く */
const SANE_LAT = [20, 46];
const SANE_LON = [122, 154];

async function main() {
  if (!admin.apps.length) {
    const keyPath = path.join(__dirname, "serviceAccount.json");
    admin.initializeApp({
      projectId: PROJECT_ID,
      credential: fs.existsSync(keyPath)
        ? admin.credential.cert(require(keyPath))
        : admin.credential.applicationDefault(),
    });
  }
  const db = admin.firestore();

  console.log(`${COLLECTION} を読み込んでいます…`);
  const snapshot = await db.collection(COLLECTION).get();

  const spots = [];
  let missing = 0;
  let outOfRange = 0;
  for (const doc of snapshot.docs) {
    const d = doc.data();
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      missing++;
      continue;
    }
    // ⚠️ 桁違い・緯度経度の取り違えが混ざると、遠く離れた道に加点が付く。
    //    静かに間違えるより、落として件数を報告する。
    if (lat < SANE_LAT[0] || lat > SANE_LAT[1] || lng < SANE_LON[0] || lng > SANE_LON[1]) {
      outOfRange++;
      continue;
    }
    // roadCsv と同じ [lon, lat] の並びに揃える（取り違え事故を防ぐ）
    spots.push([Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
  }

  console.log(`  取得 ${snapshot.size}件 → 使える座標 ${spots.length}件`);
  if (missing) console.log(`  座標なし: ${missing}件`);
  if (outOfRange) console.log(`  ⚠️ 範囲外で除外: ${outOfRange}件`);

  if (DRY_RUN) {
    console.log("\n--dry-run のため書き込みません");
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    count: spots.length,
    spots,
  }, null, 0));
  console.log(`\n${path.relative(process.cwd(), OUT)} に書きました`);
  console.log("次: node buildRoadRecommend.js --all で再生成すると景色が反映されます");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
