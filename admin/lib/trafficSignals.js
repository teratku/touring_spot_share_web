/**
 * admin/lib/trafficSignals.js
 *
 * **信号のある交差点か**を答える（案内文を「この交差点で〜」に変えるため）。
 *
 * ⚠️ **Valhalla は信号を持っていない。** `trace_attributes` の節点には
 *    `traffic_signal` が無く、節点の種別にも出てこない（実測）。
 *    OSM の `highway=traffic_signals` を自前で持つしかない。
 *
 * 形: `admin/data/traffic-signals.bin`（緯度・経度を 1e6 倍した Int32 の組、緯度順）。
 * 日本全国で 204,697 点・1.56MB。⚠️ 作り方は `admin/buildTrafficSignals.js` を読むこと。
 *
 * ⚠️ **毎回ファイルを読まないこと。** 1回だけ読んで持ち回る（Cloud Run の1インスタンスに1回）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "traffic-signals.bin");
/** 緯度1度あたりの距離（m）。経度は緯度で縮むので、その都度かける */
const METERS_PER_DEGREE = 111320;

let points = null;   // Int32Array（[緯度, 経度, 緯度, 経度, …]）

/** 読み込む（1回だけ）。ファイルが無ければ空で動く（信号を言わないだけ） */
function load(file = FILE) {
  if (points) return points;
  try {
    const buf = fs.readFileSync(file);
    points = new Int32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  } catch (e) {
    console.error(`信号データを読めません（案内は信号なしで出します）: ${e.message}`);
    points = new Int32Array(0);
  }
  return points;
}

/** 読み直す（検査用） */
function reset() { points = null; }

/** 点の数 */
function count(file) { return load(file).length / 2; }

/**
 * その地点に信号があるか。
 *
 * ⚠️ **交差点の中心ではなく停止線に打たれている**ことが多く、向きごとに複数ある。
 *    「この交差点か」を見たいので、少し広めに見る（既定30m。`lib` の呼び元が決める）
 * @param {[number, number]} point [経度, 緯度]
 * @param {number} radiusMeters
 */
function isNear(point, radiusMeters = 30, file) {
  const all = load(file);
  if (!all.length || !Array.isArray(point) || point.length < 2) return false;
  const [lng, lat] = point;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  const dLat = radiusMeters / METERS_PER_DEGREE;
  const lo = search(all, (lat - dLat) * 1e6);
  const cos = Math.cos((lat * Math.PI) / 180);
  const latMax = (lat + dLat) * 1e6;
  for (let i = lo; i < all.length / 2; i++) {
    const sLat = all[i * 2];
    if (sLat > latMax) return false;
    const sLng = all[i * 2 + 1];
    const dy = (sLat / 1e6 - lat) * METERS_PER_DEGREE;
    const dx = (sLng / 1e6 - lng) * METERS_PER_DEGREE * cos;
    if (Math.hypot(dx, dy) <= radiusMeters) return true;
  }
  return false;
}

/** いちばん近い信号までの距離（m）。無ければ Infinity（しきい値を決めるための道具） */
function nearestMeters(point, withinMeters = 200, file) {
  const all = load(file);
  if (!all.length) return Infinity;
  const [lng, lat] = point;
  const dLat = withinMeters / METERS_PER_DEGREE;
  const lo = search(all, (lat - dLat) * 1e6);
  const cos = Math.cos((lat * Math.PI) / 180);
  const latMax = (lat + dLat) * 1e6;
  let best = Infinity;
  for (let i = lo; i < all.length / 2; i++) {
    const sLat = all[i * 2];
    if (sLat > latMax) break;
    const dy = (sLat / 1e6 - lat) * METERS_PER_DEGREE;
    const dx = (all[i * 2 + 1] / 1e6 - lng) * METERS_PER_DEGREE * cos;
    const d = Math.hypot(dx, dy);
    // ⚠️ **緯度の帯だけで決めないこと。** 東西に遠い点まで数えると、
    //    何十kmも離れた信号までの距離を返す
    if (d <= withinMeters && d < best) best = d;
  }
  return best;
}

/**
 * 緯度（1e6倍）が `target` 以上になる最初の点の番号（二分探索）。
 *
 * ⚠️ **これは速さのためであって、正しさのためではない。** `return 0`（全部見る）に
 *    しても答えは同じで、検査にかかる時間が 5秒→9秒 になるだけ（変異テストで確認）。
 * ⚠️ `<` を `<=` にしても検査は落ちない。ずれるのは「真南ちょうど半径mの位置に、
 *    1e6 の格子へぴったり乗る信号がある」ときの1点だけで、その材料を安定して
 *    作れない（浮動小数の丸めで境界が動く）。円の縁1点なので案内は変わらない。
 */
function search(all, target) {
  let lo = 0, hi = all.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid * 2] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

module.exports = { isNear, nearestMeters, count, load, reset, FILE, METERS_PER_DEGREE };
