/**
 * roadCrossPrefecture.js
 *
 * おすすめ道路の調整ツールで、**ほかの県に登録済みの道**を扱う。
 *
 * 【なぜ要るか】
 * 調整ツールは開いた1県のデータしか読まない。地図をほかの県まで動かしても、そちらで登録済みの道は線が出ず、
 * 「まだ無い」ように見える。そのまま「＋ 道を足す」で足すと、開いていた県のファイルに入る。
 * 実際に、福島県に蔵王エコーライン（宮城・山形の道。福島県を通らない）、埼玉県に上野原丹波山線（山梨・東京）などが
 * 足されていて、宮城・山形にある同じ道と重なっていた（2026-10-21 利用者の報告「他の県で登録しているが見えていないため余計に追加してしまう」）。
 *
 * そこで次の3つを、ここにまとめる（画面に写しを置かない。判定が食い違わないように）:
 *   1. 全県の登録済みの道の一覧（`buildCatalog`）… 地図に薄く出す・照合に使う
 *   2. 足す道が**どの県を通るか**（`prefectureShares`）… 開いている県をほとんど通らなければ知らせる
 *   3. 足す道が**登録済みの道と重なるか**（`findOverlaps`）… 重なれば止めて選ばせる
 *
 * ⚠️ 点の並びは `lib/polyline.js` と同じ [経度, 緯度]。
 * ⚠️ 県をまたぐ道を生成した結果、各県に自分の県の部分だけがあるのは正常（蔵王エコーラインの宮城部分と山形部分）。
 *    ここで止めるのは「足そうとしている道が、すでにある道と重なる」ときだけ。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { decode } = require("./polyline");
const { distanceMeters } = require("./roadCsv");
const { overrideKey, isValidAdded } = require("./roadOverrides");
const { ROMAJI } = require("./prefectures");

/** 重なりとみなす距離。生成の線は間引いてあるので、点ではなく線分との距離で測る */
const OVERLAP_TOLERANCE_METERS = 60;
/** 重なりを測るときに足す道を刻む間隔 */
const SAMPLE_STEP_METERS = 100;
/** どちらかの道の3割以上が重なれば「同じ道」とみなす */
const OVERLAP_THRESHOLD = 0.3;
/** 重なった長さがこれ未満なら知らせない（交差点で触れただけの道を拾わない） */
const MIN_OVERLAP_METERS = 500;
/** 開いている県を通る割合がこれ未満なら「ほかの県の道」として知らせる */
const OWN_SHARE_MIN = 0.5;

const NAME_OF_ROMAJI = Object.fromEntries(Object.entries(ROMAJI).map(([name, r]) => [r, name]));

/** 点の並びの長さ（m） */
function lengthOf(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

/**
 * 線を一定の間隔で刻んだ点（両端を含む）と、1点が受け持つ長さ。
 * ⚠️ 元の頂点のまま数えないこと。生成の線は曲がり角に点が多く直線に少ないので、頂点の数で割合を出すと偏る
 */
function resample(points, step = SAMPLE_STEP_METERS) {
  if (points.length < 2) return { samples: points.slice(), weight: 0 };
  const total = lengthOf(points);
  if (total === 0) return { samples: [points[0]], weight: 0 };
  const count = Math.max(2, Math.ceil(total / step) + 1);
  const gap = total / (count - 1);
  const samples = [points[0]];
  let seg = 1, segStart = 0;
  for (let k = 1; k < count - 1; k++) {
    const target = k * gap;
    while (seg < points.length - 1 && segStart + distanceMeters(points[seg - 1], points[seg]) < target) {
      segStart += distanceMeters(points[seg - 1], points[seg]);
      seg++;
    }
    const a = points[seg - 1], b = points[seg];
    const len = distanceMeters(a, b) || 1;
    const t = Math.max(0, Math.min(1, (target - segStart) / len));
    samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  samples.push(points[points.length - 1]);
  return { samples, weight: total / samples.length };
}

/** 点と線分の距離（m）。近い範囲なので平面で近似する */
function pointToSegmentMeters(p, a, b) {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 111320;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/** 点が線のそばにあるか */
function nearLine(p, line, tolerance) {
  if (line.length === 1) return distanceMeters(p, line[0]) <= tolerance;
  for (let i = 1; i < line.length; i++) {
    if (pointToSegmentMeters(p, line[i - 1], line[i]) <= tolerance) return true;
  }
  return false;
}

/** 線の外枠（[西, 南, 東, 北]）。`margin` は度 */
function boundsOf(points, margin = 0) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of points) {
    if (lng < w) w = lng; if (lng > e) e = lng;
    if (lat < s) s = lat; if (lat > n) n = lat;
  }
  return [w - margin, s - margin, e + margin, n + margin];
}

const boxesTouch = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * `line` の長さのうち、`other` のそばを通る割合と長さ。
 * @returns {{ fraction: number, meters: number }}
 */
function coverage(line, other, tolerance = OVERLAP_TOLERANCE_METERS) {
  const { samples, weight } = resample(line);
  if (!samples.length || weight === 0) return { fraction: 0, meters: 0 };
  const box = boundsOf(other, tolerance / 90000);
  let hit = 0;
  for (const p of samples) {
    if (p[0] < box[0] || p[0] > box[2] || p[1] < box[1] || p[1] > box[3]) continue;
    if (nearLine(p, other, tolerance)) hit++;
  }
  return { fraction: hit / samples.length, meters: hit * weight };
}

/**
 * 線がどの県を何割通るか（長さで割る）。
 * @param {Array<[number, number]>} points [経度, 緯度]
 * @param {(lng: number, lat: number) => string|null} locate `PrefectureLocator#locate`
 * @returns {Array<{ name: string, romaji: string|null, share: number }>} 多い順
 */
function prefectureShares(points, locate) {
  const { samples } = resample(points);
  const counts = new Map();
  for (const [lng, lat] of samples) {
    const name = locate(lng, lat) || "?";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, c]) => ({ name, romaji: ROMAJI[name] || null, share: c / samples.length }))
    .sort((a, b) => b.share - a.share);
}

/**
 * 開いている県をほとんど通らない道なら、通る割合のいちばん多い県を返す（無ければ null）。
 * ⚠️ 県境の道は半々になることがある。開いている県を半分以上通るなら知らせない（その県で足してよい）
 */
function suggestedPrefecture(shares, romaji) {
  const own = shares.find((s) => s.romaji === romaji);
  if (own && own.share >= OWN_SHARE_MIN) return null;
  const top = shares.find((s) => s.romaji && s.romaji !== romaji);
  return top ? { name: top.name, romaji: top.romaji, share: top.share, ownShare: own ? own.share : 0 } : null;
}

/**
 * 足そうとしている道と重なる、登録済みの道。
 * どちらかの道の `OVERLAP_THRESHOLD` 以上が重なり、重なった長さが `MIN_OVERLAP_METERS` 以上のもの。
 * @param {Array<[number, number]>} points 足す道
 * @param {Array<object>} catalog `buildCatalog` の roads
 * @returns {Array<object>} 重なりの大きい順
 */
function findOverlaps(points, catalog, { threshold = OVERLAP_THRESHOLD, minMeters = MIN_OVERLAP_METERS } = {}) {
  const box = boundsOf(points, OVERLAP_TOLERANCE_METERS / 90000);
  const out = [];
  for (const road of catalog) {
    if (!boxesTouch(box, road.bounds)) continue;
    const mine = coverage(points, road.points);
    if (mine.meters === 0) continue;
    const theirs = coverage(road.points, points);
    const fraction = Math.max(mine.fraction, theirs.fraction);
    if (fraction < threshold || Math.max(mine.meters, theirs.meters) < minMeters) continue;
    out.push({
      romaji: road.romaji, prefecture: road.prefecture, key: road.key, name: road.name, title: road.title,
      source: road.source, hidden: road.hidden,
      /** 足す道のうち重なる割合 */
      newCovered: Number(mine.fraction.toFixed(3)),
      /** 登録済みの道のうち重なる割合 */
      existingCovered: Number(theirs.fraction.toFixed(3)),
      fraction: Number(fraction.toFixed(3)),
    });
  }
  return out.sort((a, b) => b.fraction - a.fraction);
}

/**
 * 全県の登録済みの道。
 *   source: "generated" … 生成データ（`data/road-recommend`。手で足して生成済みの道も入る）
 *   source: "added"     … 手で足して保存したが、まだ生成していない道（`data/road-overrides` の added）
 * ⚠️ 生成データに同じ鍵がある足した道は数えない（生成で混ぜた後なので二重になる。`applyOverrides` と同じ規則）
 * ⚠️ 非表示にした道も入れる（印 hidden を付ける）。登録はされているので、足し直すと二重になる
 * @param {string} dataDir `admin/data`
 */
function buildCatalog(dataDir) {
  const roads = [];
  const recDir = path.join(dataDir, "road-recommend");
  const ovDir = path.join(dataDir, "road-overrides");
  const romajis = fs.existsSync(recDir)
    ? fs.readdirSync(recDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  for (const romaji of new Set([...romajis, ...listOverrides(ovDir)])) {
    const prefecture = NAME_OF_ROMAJI[romaji] || romaji;
    const generated = readJson(path.join(recDir, `${romaji}.json`));
    const overridesFile = readJson(path.join(ovDir, `${romaji}.json`)) || {};
    const overrides = overridesFile.overrides || {};
    const keys = new Set();
    for (const seg of (generated && generated.segments) || []) {
      const key = overrideKey(seg);
      keys.add(key);
      const o = overrides[key] || {};
      const points = decode(o.shape || seg.polyline);
      if (points.length < 2) continue;
      roads.push({ romaji, prefecture, key, name: seg.name, title: seg.title || o.title || null,
                   source: "generated", hidden: !!(seg.hidden || o.hidden),
                   polyline: o.shape || seg.polyline, points, bounds: boundsOf(points) });
    }
    for (const [key, a] of Object.entries(overridesFile.added || {})) {
      if (keys.has(key) || !a || !a.shape) continue;
      const points = decode(a.shape);
      if (points.length < 2) continue;
      roads.push({ romaji, prefecture, key, name: a.name, title: a.title || null, source: "added",
                   hidden: a.hidden === true, polyline: a.shape, points, bounds: boundsOf(points) });
    }
  }
  return roads;
}

function listOverrides(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** 画面に返す形（点の配列と外枠は重いので落とす） */
function publicRoad(road) {
  const { points, bounds, ...rest } = road;
  void points; void bounds;
  return rest;
}

/** 地図の範囲に掛かる道。`exclude` の県は除く（開いている県は画面が自分で描く） */
function roadsInBounds(catalog, box, { exclude = null, limit = 800 } = {}) {
  const out = [];
  for (const road of catalog) {
    if (exclude && road.romaji === exclude) continue;
    if (!boxesTouch(box, road.bounds)) continue;
    out.push(publicRoad(road));
    if (out.length >= limit) return { roads: out, truncated: true };
  }
  return { roads: out, truncated: false };
}

/**
 * 足した道を別の県のファイルへ足す（その県の調整・ほかの足した道には触れない）。
 * ⚠️ 同じ鍵がすでにあれば足さない（上書きすると、その県で直した中身が消える）
 * @returns {{ ok: boolean, reason?: string }}
 */
function appendAdded(ovDir, romaji, key, added) {
  if (!ROMAJI[NAME_OF_ROMAJI[romaji]]) return { ok: false, reason: "県が分かりません" };
  if (!isValidAdded(added)) return { ok: false, reason: "名前か線が足りません" };
  const file = path.join(ovDir, `${romaji}.json`);
  const raw = readJson(file) || { romaji, overrides: {}, added: {} };
  raw.overrides = raw.overrides || {};
  raw.added = raw.added || {};
  if (raw.added[key]) return { ok: false, reason: "同じ名前・同じ場所の道がその県にすでにあります" };
  raw.added[key] = { ...added, updatedAt: new Date().toISOString() };
  raw.romaji = romaji;
  raw.updatedAt = new Date().toISOString();
  fs.mkdirSync(ovDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 1) + "\n");
  return { ok: true };
}

module.exports = {
  prefectureShares, suggestedPrefecture, findOverlaps, buildCatalog, roadsInBounds, appendAdded,
  coverage, resample, boundsOf,
  OVERLAP_TOLERANCE_METERS, OVERLAP_THRESHOLD, MIN_OVERLAP_METERS, OWN_SHARE_MIN,
};

/**
 * 別の県に入ってしまっている足した道を、正しい県へ移す計画（`moveMisplacedAdded.js`）。
 *
 * 2026-10-21 利用者の判断「正しい都道府県にする」。開いている県のファイルに入ってしまった道（福島県の蔵王エコーラインなど）を、
 * 線が多く通る県へ移す。判定は足すときと同じ（`suggestedPrefecture`。開いていた県を半分以上通るなら動かさない）。
 * ⚠️ 移す先に同じ鍵の道がすでにあれば（足した道・生成データとも）、移さずに元の県から外すだけにする（上書きしない）
 * @param {string} dataDir `admin/data`
 * @param {(lng: number, lat: number) => string|null} locate
 * @returns {Array<{ from, to, toName, key, name, share, action: "move"|"drop", overlapsAfter }>}
 */
function planMisplaced(dataDir, locate) {
  const ovDir = path.join(dataDir, "road-overrides");
  const catalog = buildCatalog(dataDir);
  const plan = [];
  for (const romaji of listOverrides(ovDir)) {
    const raw = readJson(path.join(ovDir, `${romaji}.json`)) || {};
    for (const [key, added] of Object.entries(raw.added || {})) {
      if (!added || !added.shape) continue;
      const points = decode(added.shape);
      if (points.length < 2) continue;
      const suggested = suggestedPrefecture(prefectureShares(points, locate), romaji);
      if (!suggested) continue;
      const target = readJson(path.join(ovDir, `${suggested.romaji}.json`)) || {};
      // ⚠️ 生成データに同じ鍵がある場合も「ある」とみなす（足しても生成で落とされる。`applyOverrides`）
      const exists = !!(target.added && target.added[key])
        || catalog.some((r) => r.romaji === suggested.romaji && r.key === key && r.source === "generated");
      // 移した先で生成済みの道と重なるか（人が調整ツールで確かめるために知らせる）
      const overlapsAfter = findOverlaps(points, catalog.filter((r) => r.romaji === suggested.romaji && r.key !== key));
      plan.push({ from: romaji, to: suggested.romaji, toName: suggested.name, key, name: added.name,
                  share: suggested.share, action: exists ? "drop" : "move", overlapsAfter });
    }
  }
  return plan;
}

/** 計画どおりに移す。元の県のファイルからは消し、移す先へ足す（同じ鍵があれば消すだけ） */
function applyMisplaced(dataDir, plan) {
  const ovDir = path.join(dataDir, "road-overrides");
  const done = [];
  for (const item of plan) {
    const fromFile = path.join(ovDir, `${item.from}.json`);
    const raw = readJson(fromFile);
    if (!raw || !raw.added || !raw.added[item.key]) continue;
    const added = raw.added[item.key];
    if (item.action === "move") {
      const { updatedAt, ...rest } = added;
      void updatedAt;
      const r = appendAdded(ovDir, item.to, item.key, rest);
      if (!r.ok) { done.push({ ...item, ok: false, reason: r.reason }); continue; }
    }
    delete raw.added[item.key];
    raw.updatedAt = new Date().toISOString();
    fs.writeFileSync(fromFile, JSON.stringify(raw, null, 1) + "\n");
    done.push({ ...item, ok: true });
  }
  return done;
}

module.exports.planMisplaced = planMisplaced;
module.exports.applyMisplaced = applyMisplaced;
