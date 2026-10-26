"use strict";

/**
 * おすすめ道路ごとの「走りの速さ」を集計する（road_pace → 公開の road_pace_stats/roads）。
 *
 * ⚠️ 利用者の判断（2026-10-26）:「その道が快走路か、細い道のためゆっくり走行しているかを解析したい」→
 *   - 元: アプリで「走りの速さの解析に協力する」をオンにした人の要約（road_pace/{uid}_{道の鍵}。道ごとの数字だけ）
 *   - 見せ方: 区分と平均の速さ。**3人以上から出す**（少ないと誰の走りか分かる・ばらつきが大きい）
 *   - 出し先: アプリのおすすめ道路（ルート生成にも）・Web の一覧と詳細・調整ツール
 * ⚠️ 1人が何回走っても1人と数える（その人の回の中央値を1票に）。速い人が何度も走った道が「快走路」に寄らないように
 * ⚠️ 原付一種（50cc以下・30km/h制限）の回は数えない
 * ⚠️ 公開する文書には uid を入れない。道ごとの数字だけ
 */

const MIN_USERS = 3;
const MAX_ITEMS = 4000;

/** 区分の決まり（km/h・%）。⚠️ アプリ・Web は key だけ読み、ここで決めた区分を出す */
const LABELS = {
  stopgo: "止まりがち",
  fast: "快走路",
  smooth: "流れがよい",
  slow: "ゆっくり走る道",
};
const STOPGO_PCT = 25;
const FAST_KMH = 45;
const SMOOTH_KMH = 30;

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** 区分を決める（道の値＝人ごとの中央値の中央値） */
function labelOf({ kmh, stopPct }) {
  if (stopPct >= STOPGO_PCT) return "stopgo";
  if (kmh >= FAST_KMH) return "fast";
  if (kmh >= SMOOTH_KMH) return "smooth";
  return "slow";
}

/**
 * road_pace の文書の中身の並びから、道ごとの集計を作る。
 * @returns {Array<{key, name, users, rides, kmh, p85, stopPct, stopsPer10km, label, hist}>} 人数の多い順
 *   hist … 人ごとの平均の速さの分布（10km/h ごと・[0-10, 10-20, … 90+]）。調整ツールで見る
 */
function tallyRoadPace(docs, { minUsers = MIN_USERS, maxItems = MAX_ITEMS } = {}) {
  const byRoad = new Map();
  for (const doc of docs) {
    if (!doc || typeof doc.roadID !== "string" || !doc.roadID || typeof doc.uid !== "string") continue;
    const rides = (Array.isArray(doc.rides) ? doc.rides : [])
      .filter((r) => r && r.cc !== "moped50" && Number.isFinite(r.kmh) && Number.isFinite(r.km) && r.km > 0);
    if (!rides.length) continue;
    // 1人を1票に（その人の回の中央値）
    const person = {
      kmh: median(rides.map((r) => r.kmh)),
      p85: median(rides.map((r) => r.p85)),
      stopPct: median(rides.map((r) => r.stopPct)),
      stopsPer10km: median(rides.map((r) => (Number.isFinite(r.stops) ? r.stops / r.km * 10 : NaN))),
      rides: rides.length,
    };
    const entry = byRoad.get(doc.roadID) || { key: doc.roadID, name: "", people: [] };
    if (typeof doc.roadName === "string" && doc.roadName) entry.name = doc.roadName;
    entry.people.push(person);
    byRoad.set(doc.roadID, entry);
  }
  const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return [...byRoad.values()]
    .filter((e) => e.people.length >= minUsers)
    .map((e) => {
      const value = {
        kmh: Math.round(median(e.people.map((p) => p.kmh))),
        p85: Math.round(median(e.people.map((p) => p.p85)) ?? 0),
        stopPct: Math.round(median(e.people.map((p) => p.stopPct)) ?? 0),
        stopsPer10km: round1(median(e.people.map((p) => p.stopsPer10km))),
      };
      const hist = new Array(10).fill(0);
      for (const p of e.people) hist[Math.min(9, Math.max(0, Math.floor(p.kmh / 10)))] += 1;
      return {
        key: e.key, name: e.name, users: e.people.length,
        rides: e.people.reduce((s, p) => s + p.rides, 0),
        ...value, label: labelOf(value), hist,
      };
    })
    .sort((a, b) => b.users - a.users || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, maxItems);
}

/**
 * 集計して公開の road_pace_stats/roads に書く。
 * 形: { roads: { <道の鍵>: {name, users, rides, kmh, p85, stopPct, stopsPer10km, label, hist} }, labels, updatedAt }
 */
async function refreshRoadPace(db, FieldValue) {
  const snap = await db.collection("road_pace").get();
  const docs = snap.docs.map((d) => d.data());
  const list = tallyRoadPace(docs);
  const roads = {};
  for (const r of list) {
    const { key, ...rest } = r;
    roads[key] = rest;
  }
  await db.collection("road_pace_stats").doc("roads").set({
    roads, labels: LABELS, minUsers: MIN_USERS, updatedAt: FieldValue.serverTimestamp(),
  });
  return { docs: docs.length, roads: list.length };
}

module.exports = { tallyRoadPace, labelOf, median, refreshRoadPace, LABELS, MIN_USERS, FAST_KMH, SMOOTH_KMH, STOPGO_PCT };
