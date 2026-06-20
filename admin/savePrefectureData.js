#!/usr/bin/env node
/**
 * savePrefectureData.js
 * アプリの保存スポット（imagedownload）を都道府県別にまとめて保存する。
 * → ビルダー（/api/prefecture-spots/:romaji）で県別ラリー作成に読み込む。
 *
 * 県の判定: スポットの administrative / locality / address に都道府県名が含まれるか。
 * 出力: data/prefecture-spots/<romaji>.json（各県の spots 配列）＋ _index.json
 *
 * 使い方:
 *   cd admin && npm install        # 初回（firebase-admin）
 *   node savePrefectureData.js     # 認証は importRallies.js と同じ（ADC / serviceAccount.json）
 *
 * ※ ルートは点チェックイン型ラリーに直接対応せず、県への帰属も曖昧なため対象外（スポットのみ）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { ROMAJI } = require("./lib/prefectures");

const PROJECT_ID = "biketeilen";
const OUT_DIR = path.join(__dirname, "data", "prefecture-spots");
const PREF_NAMES = Object.keys(ROMAJI); // 47
const PER_PREF_CAP = 800;
const FETCH_LIMIT = 30000;

function initAdmin() {
  const saPath = path.join(__dirname, "serviceAccount.json");
  if (fs.existsSync(saPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(saPath)), projectId: PROJECT_ID });
    console.log("🔑 認証: serviceAccount.json");
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
    console.log("🔑 認証: applicationDefault（gcloud ADC）");
  }
}

function detectPref(x) {
  const cands = [x.administrative, x.locality, x.address].map((v) => String(v || ""));
  for (const a of cands) {
    if (!a) continue;
    for (const p of PREF_NAMES) {
      if (a.includes(p)) return p;
    }
  }
  return null;
}

async function main() {
  initAdmin();
  const db = admin.firestore();
  console.log(`imagedownload 取得中…（最大 ${FETCH_LIMIT} 件）`);
  const snap = await db.collection("imagedownload").limit(FETCH_LIMIT).get();

  const buckets = {};
  let used = 0, skipped = 0;
  snap.forEach((d) => {
    const x = d.data() || {};
    const lat = Number(x.lat), lng = Number(x.lng);
    if (!isFinite(lat) || !isFinite(lng)) { skipped++; return; }
    const pref = detectPref(x);
    if (!pref) { skipped++; return; }
    (buckets[pref] = buckets[pref] || []).push({
      spotId: d.id,
      name: x.location_name || x.locality || x.administrative || "スポット",
      lat,
      lng,
      address: x.administrative || x.locality || null,
      imageURL: (Array.isArray(x.locationImageURLs) && x.locationImageURLs[0]) || x.iconImageURL || null,
    });
    used++;
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = {};
  for (const pref of PREF_NAMES) {
    const romaji = ROMAJI[pref];
    let spots = buckets[pref] || [];
    const seen = new Set();
    spots = spots.filter((s) => (seen.has(s.spotId) ? false : (seen.add(s.spotId), true)));
    spots.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
    const capped = spots.slice(0, PER_PREF_CAP);
    fs.writeFileSync(
      path.join(OUT_DIR, `${romaji}.json`),
      JSON.stringify({ prefecture: pref, romaji, count: capped.length, total: spots.length, spots: capped }, null, 2) + "\n"
    );
    index[romaji] = { prefecture: pref, count: capped.length, total: spots.length };
  }
  fs.writeFileSync(path.join(OUT_DIR, "_index.json"), JSON.stringify(index, null, 2) + "\n");

  console.log(`✅ 保存: ${PREF_NAMES.length} 県 → ${path.relative(__dirname, OUT_DIR)}/`);
  console.log(`   採用 ${used} 件 / 県不明・無座標スキップ ${skipped} 件`);
  const top = Object.values(index).sort((a, b) => b.total - a.total).slice(0, 8);
  console.log("   多い県:", top.map((v) => `${v.prefecture}:${v.total}`).join(" "));
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
