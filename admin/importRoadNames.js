#!/usr/bin/env node
/**
 * importRoadNames.js
 *
 * buildRoadNames.js が作った data/road-names/<romaji>.json を配信する。
 *
 * おすすめ道路（importRoadRecommend.js）と同じ「Firestore に索引・Storage に本体」の形。
 *
 *   Storage   Json/road_names/<romaji>_v<generation>.json   本体
 *   Firestore road_names/_index                             全県ぶんの世代表（アプリはこれ1件だけ読む）
 *   Firestore road_names/<romaji>                           県ごとの明細（運用の確認用）
 *
 * 【これは何のためのデータか】
 * 走破率とロードデックスの分母は道路名だけで作れる（ジオメトリ不要）。
 * グリッドを持っていない端末（海外・未ダウンロード）でも走破率を出せるようにする。
 * 全国で1.8MBしかない（グリッド212MBの0.85%）。
 *
 * 使い方:
 *   cd admin && npm install
 *   # 認証（どちらか）
 *   #  a) gcloud auth application-default login
 *   #  b) admin/serviceAccount.json を置く（.gitignore 済み）
 *   node importRoadNames.js --all --dry-run       # 検証のみ（既定・書込みなし）
 *   node importRoadNames.js --all --commit        # 全県を投入
 *   node importRoadNames.js --prefecture 栃木県 --commit
 *
 * ⚠️ 本番の Firestore と Storage に書き込みます。まず --dry-run で確認してください。
 *    generation を上げるとアプリのキャッシュが失効して再ダウンロードが走ります。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";
const BUCKET = "biketeilen.appspot.com";
const COLLECTION = "road_names";
const STORAGE_PREFIX = "Json/road_names";
const DATA_DIR = path.join(__dirname, "data", "road-names");

// ---- 引数 ----
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
// ⚠️ 既定は必ず dry-run。--commit を明示しない限り書き込まない
const COMMIT = args.includes("--commit");
const ALL = args.includes("--all");
const INDEX_ONLY = args.includes("--index-only");
const ONLY = argVal("--prefecture");

/**
 * アプリ側（RoadCompletionCalculator.swift）が数える道路種別。
 * ⚠️ ここに無い種別を配ると、アプリが黙って捨てるので分母が合わなくなる。
 */
const VALID_HIGHWAYS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);

/** 出力の妥当性を確かめる。おかしなものを配信してしまうと全ユーザーに出る */
function validate(data) {
  const problems = [];
  if (!data.prefecture) problems.push("prefecture が無い");
  if (!data.romaji) problems.push("romaji が無い");
  if (!Number.isInteger(data.generation) || data.generation < 1) problems.push("generation が不正");
  if (!Array.isArray(data.roads) || data.roads.length === 0) problems.push("roads が空");
  if (data.count !== (data.roads || []).length) problems.push("count と roads の件数が合わない");

  for (const [i, r] of (data.roads || []).entries()) {
    if (!r.n) { problems.push(`roads[${i}] に名前が無い`); break; }
    if (!VALID_HIGHWAYS.has(r.h)) {
      // _link が残っていると、アプリ側のグループ化と食い違う
      problems.push(`roads[${i}] の種別が想定外: ${r.h}（_link は親に統合しておくこと）`);
      break;
    }
    if (r.n === "Unnamed Road" || r.n === "Unknown Road") {
      problems.push(`roads[${i}] に名無し道路が混ざっている: ${r.n}`);
      break;
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(data));
  // ジオメトリを持たないので本来かなり小さい。大きいならジオメトリが混ざった疑い
  if (bytes > 400 * 1024) problems.push(`本体が大きすぎる: ${(bytes / 1024).toFixed(0)}KB（ジオメトリが混ざっていないか）`);
  return { problems, bytes };
}

async function main() {
  if (!ALL && !ONLY) {
    console.error("--all か --prefecture <県名> を指定してください");
    process.exit(1);
  }
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`生成物が無い: ${DATA_DIR}\n  先に node buildRoadNames.js を実行してください`);
    process.exit(1);
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).sort();
  const targets = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
    if (ONLY && data.prefecture !== ONLY) continue;
    targets.push({ file, data });
  }
  if (targets.length === 0) {
    console.error(ONLY ? `${ONLY} の生成物が見つかりません` : "生成物が見つかりません");
    process.exit(1);
  }

  console.log(`${COMMIT ? "投入" : "検証（--dry-run 相当・書き込みません）"}: ${targets.length}県\n`);

  // --- 検証 ---
  let bad = 0;
  let totalBytes = 0;
  let totalRoads = 0;
  for (const t of targets) {
    const { problems, bytes } = validate(t.data);
    totalBytes += bytes;
    totalRoads += t.data.count;
    if (problems.length) {
      bad++;
      console.log(`  ❌ ${t.data.prefecture}: ${problems.join(" / ")}`);
    } else {
      console.log(`  ✅ ${t.data.prefecture.padEnd(6)} ${String(t.data.count).padStart(5)}件` +
                  ` ${(bytes / 1024).toFixed(0).padStart(4)}KB  世代${t.data.generation}`);
    }
  }
  console.log(`\n合計 ${totalRoads.toLocaleString()}件 / ${(totalBytes / 1024 / 1024).toFixed(2)}MB`);
  if (bad > 0) {
    console.error(`\n${bad}県に問題があります。投入を中止しました`);
    process.exit(1);
  }
  if (!COMMIT) {
    console.log("\n書き込むには --commit を付けてください");
    return;
  }

  // --- 投入 ---
  if (!admin.apps.length) {
    const keyPath = path.join(__dirname, "serviceAccount.json");
    admin.initializeApp({
      projectId: PROJECT_ID,
      storageBucket: BUCKET,
      credential: fs.existsSync(keyPath)
        ? admin.credential.cert(require(keyPath))
        : admin.credential.applicationDefault(),
    });
  }
  const db = admin.firestore();
  const bucket = admin.storage().bucket();

  const index = {};
  for (const t of targets) {
    const { data } = t;
    const fileName = `${data.romaji}_v${data.generation}.json`;
    const destination = `${STORAGE_PREFIX}/${fileName}`;

    if (!INDEX_ONLY) {
      await bucket.upload(path.join(DATA_DIR, t.file), {
        destination,
        metadata: { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=86400" },
      });
    }

    // ⚠️ 索引に undefined を混ぜないこと。Firestore の Node SDK が例外を投げ、
    //    県ごとの書き込みが全部終わった後に _index だけ書かれずに落ちる。
    //    成功したように見えてアプリからは何も見えない、という壊れ方をする。
    const entry = {
      prefecture: data.prefecture,
      romaji: data.romaji,
      generation: data.generation,
      fileName,
      count: data.count,
    };
    index[data.romaji] = entry;
    await db.collection(COLLECTION).doc(data.romaji).set(
      { ...entry, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`  ↑ ${data.prefecture} → ${destination}`);
  }

  await db.collection(COLLECTION).doc("_index").set({
    prefectures: index,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`\n✅ ${targets.length}県を投入し、索引を更新しました`);
}

main().catch((e) => {
  console.error("❌ 失敗:", e);
  process.exit(1);
});
