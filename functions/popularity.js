"use strict";

/**
 * みんなの人気（選んだ人数）を数える。
 *
 * ⚠️ 利用者の判断（2026-10-07）:
 *   - 数える元: アプリの「選んだ記録」（user_taste/{uid}。プランに入れた・ルートの行き先にした・おまかせで選んだ）だけ
 *   - 期間: 全期間と直近90日の両方
 *   - **3人以上から出す**（少ないと誰が選んだか推測されやすい）。直近90日の人数も3人未満なら0にする
 * ⚠️ 1人が同じ道を何回選んでも1人と数える（回数で数えると、1人が何度も選んだ道が人気に見える）。
 * ⚠️ 公開する文書には誰が選んだか（uid）を入れない。数と名前だけ
 */

const MIN_USERS = 3;
const RECENT_DAYS = 90;
/** 1つの文書に入れる上限（Firestore の文書は1MBまで。1件およそ150バイト） */
const MAX_ITEMS = 2000;

/** Firestore の Timestamp・Date・数をミリ秒に */
function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : 0;
}

/**
 * 人の記録（user_taste の文書の中身）の並びから、道とスポットの人気を作る。
 * @param {Array<object>} docs user_taste の文書の中身
 * @param {number} nowMs いまの時刻（ミリ秒）
 * @returns {{roads: Array, spots: Array}} 人数の多い順。{key, name, users, recentUsers}
 */
function tallyPopularity(docs, nowMs, { minUsers = MIN_USERS, recentDays = RECENT_DAYS, maxItems = MAX_ITEMS } = {}) {
  const recentFrom = nowMs - recentDays * 24 * 60 * 60 * 1000;
  const tally = (group) => {
    const byKey = new Map();
    for (const doc of docs) {
      const items = (doc && doc[group]) || {};
      for (const item of Object.values(items)) {
        if (!item || typeof item.key !== "string" || !item.key) continue;
        const at = millis(item.lastAt);
        const entry = byKey.get(item.key) || { key: item.key, name: "", nameAt: -1, users: 0, recentUsers: 0 };
        entry.users += 1;
        if (at >= recentFrom) entry.recentUsers += 1;
        // 名前はいちばん最近選ばれたときのもの（配信データの名前が直ることがある）
        if (typeof item.name === "string" && item.name && at > entry.nameAt) {
          entry.name = item.name;
          entry.nameAt = at;
        }
        byKey.set(item.key, entry);
      }
    }
    return [...byKey.values()]
      .filter((e) => e.users >= minUsers)
      .map((e) => ({ key: e.key, name: e.name, users: e.users, recentUsers: e.recentUsers >= minUsers ? e.recentUsers : 0 }))
      .sort((a, b) => b.users - a.users || b.recentUsers - a.recentUsers || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, maxItems);
  };
  return { roads: tally("roads"), spots: tally("spots") };
}

/**
 * 道を走った人の数（走行記録 road_completion/{uid} の riddenRoadNames）。
 *
 * ⚠️ 利用者のメモ（2026-10-07 に実装）:「道路ごとの投稿スポット数・写真の数・行った人の数（ビーナスラインの例）」。
 * ⚠️ **名前はそのまま数える**（揃えるのはアプリの `RoadDexDataManager.normalizeRoadName`。全角・半角の変換などを
 *    ここで真似るとずれる）。アプリは揃えた名前ごとに人数の大きい方を使う（同じ人を二重に数えないため合計しない）
 * ⚠️ 3人以上だけ（人気と同じ。少ないと誰が走ったか推測されやすい）
 * @param {Array<object>} docs road_completion の文書の中身
 * @returns {Array<{name: string, users: number}>} 人数の多い順
 */
function tallyRiders(docs, { minUsers = MIN_USERS, maxItems = MAX_ITEMS * 5 } = {}) {
  const byName = new Map();
  for (const doc of docs) {
    const names = new Set(((doc && doc.riddenRoadNames) || []).filter((n) => typeof n === "string" && n.trim()));
    for (const name of names) byName.set(name, (byName.get(name) || 0) + 1);
  }
  return [...byName.entries()]
    .filter(([, users]) => users >= minUsers)
    .map(([name, users]) => ({ name, users }))
    .sort((a, b) => b.users - a.users || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, maxItems);
}

/**
 * user_taste と road_completion を全部読んで数え、公開の popularity/roads・spots・ridden に書く。
 * ⚠️ 1日1回。読む数は人数ぶん（1人1文書ずつ）
 */
async function refreshPopularity(db, FieldValue, nowMs = Date.now()) {
  const [snapshot, completion] = await Promise.all([
    db.collection("user_taste").select("roads", "spots").get(),
    db.collection("road_completion").select("riddenRoadNames").get(),
  ]);
  const { roads, spots } = tallyPopularity(snapshot.docs.map((d) => d.data()), nowMs);
  const ridden = tallyRiders(completion.docs.map((d) => d.data()));
  const meta = { minUsers: MIN_USERS, recentDays: RECENT_DAYS, updatedAt: FieldValue.serverTimestamp() };
  await db.doc("popularity/roads").set({ ...meta, items: roads });
  await db.doc("popularity/spots").set({ ...meta, items: spots });
  await db.doc("popularity/ridden").set({ minUsers: MIN_USERS, updatedAt: FieldValue.serverTimestamp(), items: ridden });
  return { people: snapshot.size, roads: roads.length, spots: spots.length, riders: completion.size, ridden: ridden.length };
}

module.exports = { tallyPopularity, tallyRiders, refreshPopularity, MIN_USERS, RECENT_DAYS, MAX_ITEMS };
