/**
 * deliveredRoads.js
 *
 * **本番に配信中のおすすめ道路**を読む（調整ツールの画面で「本番（配信中）」を選んだとき）。
 * 利用者の要望（2026-09-28）: 手元のデータだけでは、アプリが実際にどの道から選んでいるか分からない。
 *
 * 読み方はアプリの `RoadRecommendStore` と同じ:
 *   Firestore road_recommend/_index  … { prefectures: { <romaji>: { generation, fileName, contentHash, ... } } }
 *   Storage   Json/road_recommend/<fileName> … 本体（区間ポリライン込み）
 *
 * ⚠️ **読むだけ。書き込まないこと。** 配信は `importRoadRecommend.js`（調整ツールの「本番に配信する」）の仕事。
 * ⚠️ 本体はファイル名に世代が入っていて中身が変わらないので、一度読んだら取っておく。
 *    索引は配信で変わるので、少し経ったら読み直す
 */
"use strict";

const fs = require("fs");
const path = require("path");

const COLLECTION = "road_recommend";
const STORAGE_PREFIX = "Json/road_recommend";
/** 索引を読み直すまでの時間 */
const INDEX_TTL_MS = 5 * 60 * 1000;
const LOCAL_DIR = path.join(__dirname, "..", "data", "road-recommend");

/** 手元のデータの世代と中身の印（見比べる用） */
function localVersion(romaji, dir = LOCAL_DIR) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, `${romaji}.json`), "utf8"));
    return { generation: d.generation ?? null, contentHash: d.contentHash ?? null };
  } catch (e) {
    return null;
  }
}

/**
 * @param deps.db     Firestore（firebase-admin）
 * @param deps.bucket Storage のバケット（firebase-admin）
 */
function createDeliveredRoads({ db, bucket, now = () => Date.now(), localDir = LOCAL_DIR }) {
  let index = null;
  let loadedAt = 0;
  const bodies = new Map();

  async function loadIndex() {
    if (index && now() - loadedAt < INDEX_TTL_MS) return index;
    const snap = await db.collection(COLLECTION).doc("_index").get();
    const data = snap.exists ? snap.data() : null;
    index = (data && data.prefectures) || {};
    loadedAt = now();
    return index;
  }

  async function loadBody(fileName) {
    if (bodies.has(fileName)) return bodies.get(fileName);
    const [buf] = await bucket.file(`${STORAGE_PREFIX}/${fileName}`).download();
    const data = JSON.parse(buf.toString("utf8"));
    bodies.set(fileName, data);
    return data;
  }

  /**
   * 県（ローマ字）ごとに本番の区間を集める。
   * @returns {{segments, versions, missing}}
   *   versions: 県ごとの本番の世代と、手元と中身が同じか（`sameAsLocal`。どちらかに印が無ければ null）
   *   missing:  本番に無い県（配信していない）
   */
  async function segmentsFor(romajis) {
    const idx = await loadIndex();
    const segments = [];
    const versions = [];
    const missing = [];
    for (const romaji of romajis) {
      const entry = idx[romaji];
      if (!entry || !entry.fileName) { missing.push(romaji); continue; }
      const body = await loadBody(entry.fileName);
      for (const s of body.segments || []) segments.push(s);
      const local = localVersion(romaji, localDir);
      versions.push({
        romaji, prefecture: entry.prefecture || romaji, generation: entry.generation ?? null,
        count: (body.segments || []).length,
        localGeneration: local ? local.generation : null,
        sameAsLocal: entry.contentHash && local && local.contentHash ? entry.contentHash === local.contentHash : null,
      });
    }
    return { segments, versions, missing };
  }

  return { segmentsFor, loadIndex };
}

module.exports = { createDeliveredRoads, localVersion, COLLECTION, STORAGE_PREFIX, INDEX_TTL_MS };
