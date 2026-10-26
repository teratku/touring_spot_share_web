"use strict";

/**
 * 共有ルートと、解析に同意した人のバックアップから、おすすめ道路ごとの走りの速さを計算する（road_pace_offline）。
 * ページ（/dev/road-pace.html の「解析を始める」→ 関数 runRoadPaceAnalysis）と PC（admin/buildRoadPaceOffline.js）の両方がこれを使う。
 *
 * ⚠️ 利用者の判断（2026-10-26）:
 *   - 共有ルート: ポリシーに書いて使う。本人が「共有したルートを使わない」（user_taste.roadPaceExcludeShared）を選んだ人は除く
 *   - バックアップ: 解析に同意した人（user_taste.roadPaceShare）の分だけ
 *   - 「解析開始は Web ページで実施したい」「前回から更新されているかも確認できるようにしたい」→
 *     実行のたびに road_pace_runs に記録（入力の一覧と結果）を残し、次に開いたとき前回の記録と今の入力を比べる（`pendingSince`）
 * ⚠️ 書くのは道ごとの数字だけ。線・時刻・ルートの名前は書かない。cc は分からないので "unknown"
 */

const R = require("./shared/roads-lib.js");
const { ridesOnRoads, ridePayload, pointsFromRouteJson } = require("./shared/roadPaceCalc.js");

const OUT = "road_pace_offline";
const RUNS = "road_pace_runs";
const MAX_RIDES = 10;

function millis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") return Date.parse(v) || 0;
  return typeof v === "number" ? v : 0;
}

/** 配信中のおすすめ道路（アプリ・Web と同じ道の鍵で） */
async function loadRoads(db, bucket, log) {
  const idx = await db.collection("road_recommend").doc("_index").get();
  const prefs = Object.values((idx.exists && idx.data().prefectures) || {}).filter((e) => e && e.fileName);
  const segments = [];
  for (const e of prefs) {
    try {
      const [buf] = await bucket.file(`Json/road_recommend/${e.fileName}`).download();
      segments.push(...(JSON.parse(buf.toString("utf8")).segments || []));
    } catch (err) {
      log(`⚠️ ${e.prefecture} の配信を読めない: ${err.message}`);
    }
  }
  return R.grouped(segments).map((r) => ({ id: r.id, name: r.name, lines: r.polylines.map(R.decodePolyline) }));
}

/**
 * いまの入力の一覧（何を計算に使うか）。前回の記録と比べて「更新されているか」を出すのに使う。
 * @returns {{consent: string[], exclude: string[], shared: Object<string, {uid, at}>, backups: Object<string, {uid, at, path}>}}
 */
async function collectInputs(db) {
  const taste = await db.collection("user_taste").get();
  const consent = [], exclude = [];
  taste.forEach((d) => {
    const x = d.data() || {};
    if (x.roadPaceShare === true) consent.push(d.id);
    if (x.roadPaceExcludeShared === true) exclude.push(d.id);
  });
  const shared = {};
  const sharedSnap = await db.collection("shared_routes").get();
  sharedSnap.forEach((d) => {
    const x = d.data() || {};
    if (!x.userID || !x.jsonUrl || exclude.includes(x.userID)) return;
    shared[d.id] = { uid: x.userID, at: millis(x.createdAt), url: x.jsonUrl };
  });
  const backups = {};
  for (const uid of consent) {
    const snap = await db.collection("route_backups").doc(uid).collection("routes").get();
    snap.forEach((d) => {
      const x = d.data() || {};
      if (!x.storagePath) return;
      backups[`${uid}/${d.id}`] = { uid, at: millis(x.backedUpAt), path: x.storagePath };
    });
  }
  return { consent: consent.sort(), exclude: exclude.sort(), shared, backups };
}

/** アプリから届いた要約の数と、いちばん新しい時刻（集計は毎朝4:30） */
async function appUploads(db, sinceMs) {
  const snap = await db.collection("road_pace").get();
  let latest = 0, since = 0;
  snap.forEach((d) => {
    const at = millis((d.data() || {}).updatedAt);
    latest = Math.max(latest, at);
    if (at > sinceMs) since += 1;
  });
  return { docs: snap.size, latest, since };
}

/**
 * 前回の解析から変わったもの（ページの「前回から更新」）。
 * @param last 前回の road_pace_runs の中身（無ければ null）
 */
function pendingSince(last, inputs, app) {
  const prevShared = (last && last.inputs && last.inputs.shared) || {};
  const prevBackups = (last && last.inputs && last.inputs.backups) || {};
  const prevConsent = new Set((last && last.inputs && last.inputs.consent) || []);
  const prevExclude = new Set((last && last.inputs && last.inputs.exclude) || []);
  const ranAt = (last && millis(last.ranAt)) || 0;
  const newShared = Object.keys(inputs.shared).filter((id) => !(id in prevShared));
  const goneShared = Object.keys(prevShared).filter((id) => !(id in inputs.shared));
  const newBackups = Object.keys(inputs.backups).filter((id) => !(id in prevBackups) || inputs.backups[id].at > (prevBackups[id] || 0));
  const goneBackups = Object.keys(prevBackups).filter((id) => !(id in inputs.backups));
  const consentAdded = inputs.consent.filter((u) => !prevConsent.has(u)).length;
  const consentRemoved = [...prevConsent].filter((u) => !inputs.consent.includes(u)).length;
  const excludeAdded = inputs.exclude.filter((u) => !prevExclude.has(u)).length;
  const excludeRemoved = [...prevExclude].filter((u) => !inputs.exclude.includes(u)).length;
  const changed = newShared.length + goneShared.length + newBackups.length + goneBackups.length +
    consentAdded + consentRemoved + excludeAdded + excludeRemoved;
  return {
    lastRunAt: ranAt || null,
    needsRun: !last || changed > 0,
    newShared: newShared.length, goneShared: goneShared.length,
    newBackups: newBackups.length, goneBackups: goneBackups.length,
    consentAdded, consentRemoved, excludeAdded, excludeRemoved,
    sharedTotal: Object.keys(inputs.shared).length, backupTotal: Object.keys(inputs.backups).length,
    consentUsers: inputs.consent.length,
    appDocs: app.docs, appSince: ranAt ? app.since : app.docs, appLatest: app.latest || null,
  };
}

/** 前回の解析の記録 */
async function lastRun(db) {
  const snap = await db.collection(RUNS).orderBy("ranAt", "desc").limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}

/**
 * 計算する（書かない）。
 * @returns {{store: Map<uid, roads>, stat, lines: string[]}}
 */
async function computeOffline({ db, bucket, inputs, fetchImpl = fetch, log = () => {} }) {
  const roads = await loadRoads(db, bucket, log);
  log(`配信中のおすすめ道路 ${roads.length}本`);
  const store = new Map();
  const stat = { shared: 0, sharedUsed: 0, backup: 0, backupUsed: 0, failed: 0 };
  const add = (uid, found, atMs, source) => {
    const roadsOf = store.get(uid) || {};
    for (const [key, { name, ride }] of Object.entries(found)) {
      const entry = roadsOf[key] || { name, rides: [] };
      entry.rides.push(ridePayload(ride, "unknown", atMs, source));
      roadsOf[key] = entry;
    }
    store.set(uid, roadsOf);
  };
  for (const [id, s] of Object.entries(inputs.shared)) {
    stat.shared += 1;
    try {
      const res = await fetchImpl(s.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const points = pointsFromRouteJson(await res.json());
      const found = ridesOnRoads(points, roads);
      if (Object.keys(found).length) { add(s.uid, found, points[0].t, "shared"); stat.sharedUsed += 1; }
      log(`共有 ${id.slice(0, 6)}… ${points.length}点 → 道 ${Object.keys(found).length}本`);
    } catch (e) {
      stat.failed += 1;
      log(`⚠️ 共有 ${id} を読めない: ${e.message}`);
    }
  }
  for (const [id, b] of Object.entries(inputs.backups)) {
    stat.backup += 1;
    try {
      const [buf] = await bucket.file(b.path).download();
      const points = pointsFromRouteJson(JSON.parse(buf.toString("utf8")));
      const found = ridesOnRoads(points, roads);
      if (Object.keys(found).length) { add(b.uid, found, points[0].t, "backup"); stat.backupUsed += 1; }
    } catch (e) {
      stat.failed += 1;
      log(`⚠️ バックアップ ${id} を読めない: ${e.message}`);
    }
  }
  for (const roadsOf of store.values()) {
    for (const e of Object.values(roadsOf)) e.rides = e.rides.sort((a, b) => (a.ym < b.ym ? 1 : -1)).slice(0, MAX_RIDES);
  }
  const roadKeys = new Set();
  let rides = 0;
  for (const roadsOf of store.values()) for (const [k, e] of Object.entries(roadsOf)) { roadKeys.add(k); rides += e.rides.length; }
  stat.riders = store.size;
  stat.roads = roadKeys.size;
  stat.rides = rides;
  return { store, stat };
}

/** road_pace_offline をまるごと作り直す（使わないと選んだ人・共有をやめた人の分を残さない） */
async function writeOffline(db, store, FieldValue) {
  const old = await db.collection(OUT).get();
  const batch = db.batch();
  for (const d of old.docs) if (!store.has(d.id)) batch.delete(d.ref);
  for (const [uid, roads] of store) batch.set(db.collection(OUT).doc(uid), { uid, roads, updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
}

/** 解析の記録を残す（開発者だけ読める）。入力の一覧は、次に「前回から更新されているか」を比べるのに使う */
async function recordRun(db, FieldValue, { by, via, inputs, stat, before, after }) {
  const shared = {}, backups = {};
  for (const [id, s] of Object.entries(inputs.shared)) shared[id] = s.at;
  for (const [id, b] of Object.entries(inputs.backups)) backups[id] = b.at;
  await db.collection(RUNS).add({
    ranAt: FieldValue.serverTimestamp(), by: by || "", via,
    inputs: { shared, backups, consent: inputs.consent, exclude: inputs.exclude },
    stat, before: before || null, after: after || null,
  });
}

module.exports = { collectInputs, appUploads, pendingSince, lastRun, computeOffline, writeOffline, recordRun, millis, OUT, RUNS };
