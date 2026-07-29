/**
 * restrictionMatcher.js
 *
 * 規制情報（道路名＋住所）から、区間の候補ポリラインを作る。
 *
 * 【流れ】
 *   1. 道路名を手元の道路データに突き合わせる（roadNameMatcher）
 *   2. その道路の断片を連結して1本の線にする（roadStitcher）
 *   3. 始点・終点の住所をジオコーディングして、線のどこからどこまでかを決める
 *   4. その範囲を切り出して候補にする
 *
 * ⚠️ ここが出すのは**候補**であって、そのまま配信してはいけない。
 *    住所は「〇〇町1404番地1」のような粒度で、ジオコーディングの精度は場所によって大きく違う。
 *    最後は開発者が地図で見て確認する（road-builder の規制タブ）。
 *
 * ⚠️ 当てられなかったものを黙って捨てないこと。
 *    「候補なし・要手動」として残し、開発者が手で引けるようにする。
 */
"use strict";

const { distanceMeters } = require("./roadCsv");
const { stitch } = require("./roadStitcher");
const { match } = require("./roadNameMatcher");
const { simplify, encode } = require("./polyline");

/** ジオコーディングの結果が道路からこれ以上離れていたら、当てにしない */
const MAX_SNAP_METERS = 3000;
/** 出力するポリラインの粗さ */
const OUTPUT_TOLERANCE_METERS = 10;

/**
 * 住所から座標を引く。Google Geocoding を使う。
 *
 * ⚠️ Nominatim（既存の /api/geocode）は日本の番地レベルに弱く、
 *    「宇都宮市氷室町2535番地2」のような住所をまず解決できない。ここでは使わない。
 */
async function geocode(address, apiKey, prefecture = "") {
  const query = address.includes(prefecture) ? address : `${prefecture}${address}`;
  const url = "https://maps.googleapis.com/maps/api/geocode/json?language=ja&region=jp&address="
    + encodeURIComponent(query) + "&key=" + apiKey;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== "OK" || !data.results || !data.results.length) return null;
  const best = data.results[0];
  const loc = best.geometry && best.geometry.location;
  if (!loc) return null;
  return {
    lng: loc.lng, lat: loc.lat,
    // ROOFTOP > RANGE_INTERPOLATED > GEOMETRIC_CENTER > APPROXIMATE
    precision: (best.geometry && best.geometry.location_type) || "UNKNOWN",
    formatted: best.formatted_address || "",
  };
}

/** 線の中で、指定した点にいちばん近い頂点の位置 */
function nearestIndex(line, point) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = distanceMeters(line[i], point);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  return { index: best, distance: bestDistance };
}

/**
 * 1件ぶんの候補を作る。
 *
 * @param {Object} entry fetchRestrictions.js が作った1件
 * @param {Object} deps  { index, fragmentsByName, apiKey }
 * @returns {Object} 候補（当てられなくても reason 付きで返す）
 */
async function buildCandidate(entry, deps) {
  const { index, fragmentsByName, apiKey } = deps;
  const names = [entry.road, ...(entry.roadCandidates || [])].filter(Boolean);
  const result = {
    id: entry.id, prefecture: entry.prefecture, city: entry.city,
    sourceRoad: entry.road, from: entry.from, to: entry.to,
    target: entry.target, time: entry.time,
    // 一覧表示用に生の区間テキストも残す（from/to に分解する前の元の表記）
    rawSection: entry.rawSection || null,
    matchedName: null, confidence: null, polyline: null,
    // 道路全体の線。画面で始点・終点をドラッグし直すために要る
    // （候補の切り出しは当てにならないので、必ず直せるようにしておく）
    chainPolyline: null,
    lengthMeters: null, geocode: null, reason: null,
  };

  if (!names.length) { result.reason = "道路名が書かれていない"; return result; }

  const hit = match(index, names);
  if (!hit) { result.reason = `道路名が手元のデータに無い（${names[0]}）`; return result; }
  result.matchedName = hit.name;
  result.confidence = hit.confidence;

  const fragments = fragmentsByName.get(hit.name);
  if (!fragments || !fragments.length) { result.reason = "道路の形が取れない"; return result; }

  // 同じ名前の道が県をまたぐことがあるので、この県のぶんだけ繋ぐ
  const chains = stitch(fragments).sort((a, b) => b.points.length - a.points.length);
  if (!chains.length) { result.reason = "道路を連結できない"; return result; }

  const from = entry.from ? await geocode(entry.from, apiKey, entry.prefecture) : null;
  const to = entry.to ? await geocode(entry.to, apiKey, entry.prefecture) : null;
  result.geocode = { from, to };

  if (!from && !to) {
    result.reason = "住所から場所を割り出せない";
    result.chainPolyline = encode(simplify(chains[0].points, 20));
    return result;
  }

  // 始点・終点の両方に近い線を選ぶ（同名の道が離れて複数あるため）
  let best = null;
  for (const chain of chains) {
    const a = from ? nearestIndex(chain.points, [from.lng, from.lat]) : null;
    const b = to ? nearestIndex(chain.points, [to.lng, to.lat]) : null;
    const score = Math.min(a ? a.distance : Infinity, b ? b.distance : Infinity);
    if (!best || score < best.score) best = { chain, a, b, score };
  }
  if (!best || best.score > MAX_SNAP_METERS) {
    result.reason = `道路と住所が${Math.round((best && best.score) || 0)}m 離れている（別の道の可能性）`;
    // 道路は特定できているので、全体線だけ渡して手で引いてもらう
    if (best) result.chainPolyline = encode(simplify(best.chain.points, 20));
    return result;
  }

  // 片方しか取れなければ、その周り1kmを候補にする（開発者が広げ縮めする前提）
  const points = best.chain.points;
  let start = best.a ? best.a.index : best.b.index;
  let end = best.b ? best.b.index : best.a.index;
  if (start === end) {
    const span = spanIndices(points, start, 500);
    start = span[0]; end = span[1];
    result.reason = "片方の住所しか当たらないので前後500mを仮に置いた";
  }
  if (start > end) [start, end] = [end, start];

  // 道路全体も渡す。画面で区間を引き直すのに使う
  result.chainPolyline = encode(simplify(points, 20));

  const slice = points.slice(start, end + 1);
  if (slice.length < 2) { result.reason = "区間が短すぎる"; return result; }

  let meters = 0;
  for (let i = 1; i < slice.length; i++) meters += distanceMeters(slice[i - 1], slice[i]);
  result.lengthMeters = Math.round(meters);
  result.polyline = encode(simplify(slice, OUTPUT_TOLERANCE_METERS));
  return result;
}

/** index を中心に前後 meters ぶんの範囲 */
function spanIndices(points, index, meters) {
  let lo = index, hi = index, back = 0, forward = 0;
  while (lo > 0 && back < meters) { back += distanceMeters(points[lo - 1], points[lo]); lo--; }
  while (hi < points.length - 1 && forward < meters) { forward += distanceMeters(points[hi], points[hi + 1]); hi++; }
  return [lo, hi];
}

module.exports = { buildCandidate, geocode, nearestIndex, MAX_SNAP_METERS };
