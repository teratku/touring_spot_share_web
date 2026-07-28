#!/usr/bin/env node
/**
 * importRoadRecommend.js
 *
 * buildRoadRecommend.js が作った data/road-recommend/<romaji>.json を配信する。
 *
 * 道の駅と同じ「Firestore に索引・Storage に本体」の形にする。
 * 区間ポリラインを含むぶん本体が数十KBあり、Firestore に直接置くと
 * 読むたびに課金対象になるため。
 *
 *   Storage   Json/road_recommend/<romaji>_v<generation>.json   本体
 *   Firestore road_recommend/_index                             全県ぶんの世代表（アプリはこれ1件だけ読む）
 *   Firestore road_recommend/<romaji>                           県ごとの明細（運用の確認用）
 *
 * 使い方:
 *   cd admin && npm install
 *   # 認証（どちらか）
 *   #  a) gcloud auth application-default login
 *   #  b) admin/serviceAccount.json を置く（.gitignore 済み）
 *   node importRoadRecommend.js --all --dry-run        # 検証のみ（既定・書込みなし）
 *   node importRoadRecommend.js --all --commit         # 全県を投入
 *   node importRoadRecommend.js --prefecture 栃木県 --commit
 *   node importRoadRecommend.js --all --index-only --commit  # 索引だけ作り直す（本体は上げ直さない）
 *   node importRoadRecommend.js --prefecture 長野県 --bump --commit  # 世代を強制的に上げて配り直す
 *
 * ⚠️ 本番の Firestore と Storage に書き込みます。まず --dry-run で確認してください。
 *    generation を上げるとアプリのキャッシュが失効して再ダウンロードが走ります。
 *    47県ぶん一斉に上げるとユーザー全員が落とし直すので、更新は必要な県だけにしてください。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";
const BUCKET = "biketeilen.appspot.com";
const COLLECTION = "road_recommend";
const STORAGE_PREFIX = "Json/road_recommend";
const DATA_DIR = path.join(__dirname, "data", "road-recommend");

// ---- 引数 ----
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
// ⚠️ 既定は必ず dry-run。--commit を明示しない限り書き込まない
const COMMIT = args.includes("--commit");
const ALL = args.includes("--all");
/** 本体を上げ直さず、Firestore の索引だけ作り直す */
const INDEX_ONLY = args.includes("--index-only");
/**
 * 世代を強制的に1つ上げる。
 * 配信済みと手元で中身が違うのに、どちらにも contentHash が無くて
 * 自動判定できないときの逃げ道（hash を入れる前に配信したぶん）。
 */
const BUMP = args.includes("--bump");
const ONLY = argVal("--prefecture");

/** 出力の妥当性を確かめる。おかしなものを配信してしまうと全ユーザーに出る */
function validate(file, data) {
  const problems = [];
  if (!data.prefecture) problems.push("prefecture が無い");
  if (!data.romaji) problems.push("romaji が無い");
  if (!Number.isInteger(data.generation) || data.generation < 1) problems.push("generation が不正");
  if (!Array.isArray(data.segments) || data.segments.length === 0) problems.push("segments が空");
  for (const [i, s] of (data.segments || []).entries()) {
    if (!s.id || !s.name) { problems.push(`segments[${i}] に id/name が無い`); break; }
    if (!s.polyline) { problems.push(`segments[${i}] にポリラインが無い`); break; }
    if (!(s.lengthKm > 0)) { problems.push(`segments[${i}] の長さが 0`); break; }
    if (!Array.isArray(s.start) || s.start.length !== 2) { problems.push(`segments[${i}] の始点が不正`); break; }
    // 日本の範囲に収まっているか（座標の順序を間違えるとここで出る）
    const [lat, lng] = s.start;
    if (lat < 20 || lat > 46 || lng < 122 || lng > 154) {
      problems.push(`segments[${i}] の始点が日本の外: ${lat},${lng}`);
      break;
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (bytes > 500 * 1024) problems.push(`本体が大きすぎる: ${(bytes / 1024).toFixed(0)}KB`);
  return { problems, bytes };
}

async function main() {
  if (!ALL && !ONLY) {
    console.error("--all か --prefecture <県名> を指定してください");
    process.exit(1);
  }
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`生成物が無い: ${DATA_DIR}\n  先に node buildRoadRecommend.js --build を実行してください`);
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
  for (const t of targets) {
    const { problems, bytes } = validate(t.file, t.data);
    totalBytes += bytes;
    if (problems.length) {
      bad++;
      console.log(`  ❌ ${t.data.prefecture}: ${problems.join(" / ")}`);
    } else {
      console.log(`  ✅ ${t.data.prefecture.padEnd(6)} ${String(t.data.count).padStart(4)}区間` +
                  ` ${(bytes / 1024).toFixed(0).padStart(4)}KB  世代${t.data.generation}`);
    }
  }
  console.log(`\n合計 ${(totalBytes / 1024 / 1024).toFixed(1)}MB`);
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

  // ⚠️ 配信済みの中身と手元の中身が違うのに世代が同じだと、アプリは落とし直さない。
  //    「調整したのに端末に届かない」という分かりにくい形で出るので、
  //    投入の直前に配信済みの hash と突き合わせて、必要なら世代を上げる。
  //    （手元の world-generation.json だけでは、配信済みが何だったかを知りようがない）
  const bumped = [];
  for (const t of targets) {
    const snapshot = await db.collection(COLLECTION).doc(t.data.romaji).get();
    const deployed = snapshot.exists ? snapshot.data() : null;
    if (!deployed) continue;
    const sameGeneration = deployed.generation >= t.data.generation;
    // どちらにも hash が無いと差が分からない。--bump で明示的に上げてもらう
    const bothUnknown = !deployed.contentHash && !t.data.contentHash;
    const differentContent = deployed.contentHash !== t.data.contentHash;
    if (BUMP || (sameGeneration && differentContent && !bothUnknown)) {
      const next = (deployed.generation || 0) + 1;
      console.log(`  ↑ ${t.data.prefecture}: ${BUMP ? "--bump 指定" : "配信済みと中身が違う"}ので世代を v${t.data.generation} → v${next} へ`);
      t.data.generation = next;
      bumped.push(t);
    }
  }
  if (bumped.length) {
    // 手元のファイルにも書き戻す（次の --build で世代が巻き戻らないように）
    const genFile = path.join(__dirname, "data", "road-generation.json");
    let generations = {};
    try { generations = JSON.parse(fs.readFileSync(genFile, "utf8")); } catch { /* まだ無い */ }
    for (const t of bumped) {
      const file = path.join(DATA_DIR, t.file);
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      raw.generation = t.data.generation;
      fs.writeFileSync(file, JSON.stringify(raw, null, 1) + "\n");
      generations[t.data.romaji] = {
        generation: t.data.generation, hash: t.data.contentHash, updatedAt: new Date().toISOString(),
      };
    }
    fs.writeFileSync(genFile, JSON.stringify(generations, null, 1) + "\n");
  }

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

    // ⚠️ 索引には updatedAt を入れないこと。
    //    以前 `{ ...entry, updatedAt: undefined }` としていたら、Firestore の Node SDK が
    //    undefined を値として受け付けず例外を投げ、_index だけが書かれないまま終わった。
    //    県ごとの書き込みが全部終わった後に落ちるので、47県ぶん成功したように見えて
    //    アプリからは何も見えない、という分かりにくい壊れ方をする。
    const entry = {
      prefecture: data.prefecture,
      romaji: data.romaji,
      generation: data.generation,
      // 次に配信するとき「中身が変わったか」を判定する材料
      contentHash: data.contentHash || null,
      fileName,
      count: data.count,
      // 一覧に出すときの見出し。索引だけで「何が入っているか」が分かるように
      topNames: data.segments.slice(0, 5).map((s) => s.name),
    };
    index[data.romaji] = entry;
    await db.collection(COLLECTION).doc(data.romaji).set(
      { ...entry, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`  ${INDEX_ONLY ? "📇" : "⬆️ "} ${data.prefecture}${INDEX_ONLY ? "" : " → " + destination}`);
  }

  // アプリはこの1件だけ読む（47件を個別に読むと毎回47リードになる）
  await db.collection(COLLECTION).doc("_index").set({
    prefectures: index,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log(`\n完了。索引 ${COLLECTION}/_index を更新しました（${Object.keys(index).length}県）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
