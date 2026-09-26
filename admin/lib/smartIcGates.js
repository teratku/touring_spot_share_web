/**
 * smartIcGates.js
 *
 * **ETC車載器の無い乗り手の経路から、スマートIC（ETC専用）を外す**ための純ロジック（通信はしない）。
 *
 * 利用者の要望（2026-09-26）: スマートICは ETC 専用。車載器が無いバイクで入ると通れない。
 * 設定はバイクの設定（既定は「ETCあり」）。アプリは車載器が無いときだけ `etc: false` を送る。
 *
 * 【作り】`restrictionAvoid.js` と同じく**引いてから塞ぐ**。
 *   1. 引いた経路（本命と代替）がスマートICのゲートを通っているか見る（`gatesOnRoute`）
 *   2. 通っていたら、そのゲートを小さい四角で塞いで引き直す（`boxesFor`）
 * ⚠️ **全部のゲートを最初から塞がないこと。** `exclude_polygons` は周囲の合計に上限がある
 *    （Valhalla の `max_exclude_polygons_length`、既定 10,000m）。606か所 × 80m で超える。
 *
 * 実測（2026-09-26・手元の Valhalla・スマートICの外側から60km先へ33本）:
 *   13本がスマートICを通った。13本とも**1回の引き直しで**普通の IC に回った。
 *   遠回りは中央値 +4.3km・+5分、最大 +19.4km・+16分（福島松川）。引けなくなったものは0。
 *
 * ゲートの一覧は `admin/data/smart-ic-gates.json`（作り方は `admin/buildSmartIcGates.py`）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "smart-ic-gates.json");

/**
 * ゲートを通ったとみなす距離（m）。
 * ⚠️ **大きくしないこと。** ゲートは Valhalla の線の頂点そのもの（区切りの節点）なので、
 *    通れば1m以内に点がある。広げると、そばの一般道を走っただけで塞いで遠回りさせる
 */
const HIT_METERS = 5;

/** 引き直しの上限。実測では1回で足りた（塞いだ先で別のスマートICに乗ることがあるので少し余裕） */
const EXCLUDE_TRIES = 3;

//: 索引の升目（度）。約1km
const CELL = 0.01;

let cached = null;

/** ゲートの一覧を読む（1回だけ）。無ければ空（避けない。経路は止めない） */
function load(file = FILE) {
  if (cached && cached.file === file) return cached.data;
  let gates = [];
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    gates = (doc.gates || [])
      .filter((g) => Array.isArray(g) && Number.isFinite(g[0]) && Number.isFinite(g[1]))
      .map(([lat, lon, half, ic]) => ({ lat, lon, half: Number(half) || 10, ic: String(ic || "") }));
  } catch (e) {
    gates = [];
  }
  const data = index(gates);
  cached = { file, data };
  return data;
}

/** 升目の索引をつける */
function index(gates) {
  const cells = new Map();
  for (const g of gates) {
    const key = `${Math.floor(g.lat / CELL)},${Math.floor(g.lon / CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(g);
  }
  return { gates, cells };
}

function meters(lat1, lon1, lat2, lon2) {
  const k = Math.cos((lat1 * Math.PI) / 180) * 111320;
  return Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * k);
}

/**
 * 経路が通ったゲート（通った順・重複なし）。
 * @param points [[lng, lat], ...]（このツールの流儀。`decode6` の形）
 * @param data   `load()` / `index()` の戻り値
 */
function gatesOnRoute(points, data, hitMeters = HIT_METERS) {
  const found = [];
  const seen = new Set();
  if (!Array.isArray(points) || !data || !data.cells || !data.cells.size) return found;
  for (const p of points) {
    if (!Array.isArray(p)) continue;
    const [lon, lat] = p;
    const cy = Math.floor(lat / CELL);
    const cx = Math.floor(lon / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const g of data.cells.get(`${cy + dy},${cx + dx}`) || []) {
          if (seen.has(g)) continue;
          if (meters(lat, lon, g.lat, g.lon) <= hitMeters) {
            seen.add(g);
            found.push(g);
          }
        }
      }
    }
  }
  return found;
}

/**
 * ゲートを塞ぐ四角（`exclude_polygons` の形: [[lng, lat], ...] の閉じた輪）。
 * ⚠️ 大きさはゲートごと（`half`）。**本線に触れない大きさ**に作ってある（本線から11.8mのゲートがある）。
 *    ここで一律に広げると本線ごと塞いで、高速が通れなくなる
 */
function boxesFor(gates) {
  return (gates || []).map((g) => {
    const dLat = g.half / 111320;
    const dLon = g.half / (111320 * Math.cos((g.lat * Math.PI) / 180));
    const [s, n, w, e] = [g.lat - dLat, g.lat + dLat, g.lon - dLon, g.lon + dLon];
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
  });
}

/** 通ったスマートICの名前（重複なし・通った順）。アプリに「避けられなかった」と伝える */
function icNames(gates) {
  return [...new Set((gates || []).map((g) => g.ic).filter(Boolean))];
}

module.exports = { load, index, gatesOnRoute, boxesFor, icNames, HIT_METERS, EXCLUDE_TRIES, FILE };
