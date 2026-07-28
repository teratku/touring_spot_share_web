/**
 * polyline.js
 *
 * 点列の間引き・エンコード・角度計算。
 * 点は [lng, lat] の順で扱う（WKT / GeoJSON と同じ並び）。
 *
 * ⚠️ エンコードだけは lat,lng の順。Google Encoded Polyline の仕様がその順で、
 *    アプリ側の NavPolylineCodec もその順で読む
 *    （touringSpotShare/saveRoute/nav/NavPolylineCodec.swift）。
 */
"use strict";

const { distanceMeters } = require("./roadCsv");

/** a から b への方位（度、北が0、東が90） */
function bearing(a, b) {
  const lngScale = Math.cos((a[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * lngScale;
  const dy = b[1] - a[1];
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/** 2つの方位の差を -180〜180 に畳む */
function angleDelta(from, to) {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * 点の揺れを落としてから、頂点ごとの曲がり角と累積距離を出す。
 *
 * ⚠️ 揺れを落とさずに角度を足すと、まっすぐな道が峠に化ける。
 *    実際、1m間隔で 0.5m 横に振れているだけの直線が 200m で 79度、
 *    率にして 395度/km（＝ヘアピン並み）と出た。
 *
 * ⚠️ 「短いセグメントを畳む」方式（アプリの RoadCurvinessScorer.metrics）では足りない。
 *    8m まで畳んでも 0.5m の横ずれは atan(0.5/8) ≒ 3.6度 として残り、
 *    それが頂点ごとに積み上がる。
 *
 * そこで Douglas–Peucker で「元の線から noiseMeters 以上離れない範囲で」間引く。
 * 揺れ幅がそれ未満の点は消え、本物のカーブは残る
 * （半径150mのヘアピンは100mの弦に対して 8.6m ふくらむので消えない）。
 * 副産物として、OSM のまちまちな点密度にも左右されなくなる。
 *
 * @returns {{ points, turns, cumulative, totalMeters, totalTurnDegrees }}
 *   turns[i] は points[i] での曲がり角（絶対値・度）。両端は 0。
 */
function profile(points, noiseMeters = 3) {
  const denoised = simplify(points, noiseMeters);
  // 同一点が残っていると方位が出せないので落とす
  const kept = [];
  for (const p of denoised) {
    if (kept.length === 0 || distanceMeters(kept[kept.length - 1], p) > 0.1) kept.push(p);
  }

  const cumulative = [0];
  for (let i = 1; i < kept.length; i++) {
    cumulative.push(cumulative[i - 1] + distanceMeters(kept[i - 1], kept[i]));
  }
  const turns = new Array(kept.length).fill(0);
  let totalTurn = 0;
  for (let i = 1; i < kept.length - 1; i++) {
    const t = Math.abs(angleDelta(bearing(kept[i - 1], kept[i]), bearing(kept[i], kept[i + 1])));
    turns[i] = t;
    totalTurn += t;
  }
  return {
    points: kept,
    turns,
    cumulative,
    totalMeters: cumulative[cumulative.length - 1] || 0,
    totalTurnDegrees: totalTurn,
  };
}

/**
 * Douglas–Peucker で間引く。両端は必ず残る。
 * 再帰だと長い線でスタックを使い切るので、明示的なスタックで回す。
 */
function simplify(points, toleranceMeters) {
  if (points.length <= 2 || toleranceMeters <= 0) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > toleranceMeters && index > 0) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** 点から線分への距離（m） */
function perpendicularDistance(point, start, end) {
  const lngScale = Math.cos((point[1] * Math.PI) / 180);
  const px = (point[0] - start[0]) * lngScale * 111320;
  const py = (point[1] - start[1]) * 111320;
  const ex = (end[0] - start[0]) * lngScale * 111320;
  const ey = (end[1] - start[1]) * 111320;
  const lenSq = ex * ex + ey * ey;
  if (lenSq === 0) return Math.hypot(px, py);
  let t = (px * ex + py * ey) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * ex, py - t * ey);
}

/** Google Encoded Polyline。座標は [lng, lat] で渡す（中で lat,lng に直す） */
function encode(points) {
  let lastLat = 0;
  let lastLng = 0;
  let out = "";
  for (const [lng, lat] of points) {
    const la = Math.round(lat * 1e5);
    const ln = Math.round(lng * 1e5);
    out += encodeValue(la - lastLat) + encodeValue(ln - lastLng);
    lastLat = la;
    lastLng = ln;
  }
  return out;
}

function encodeValue(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/** 検証用のデコード（アプリ側と往復が合うかを確かめる） */
function decode(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const isLat of [true, false]) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (isLat) lat += delta; else lng += delta;
    }
    points.push([lng / 1e5, lat / 1e5]);
  }
  return points;
}

module.exports = { bearing, angleDelta, profile, simplify, perpendicularDistance, encode, decode };
