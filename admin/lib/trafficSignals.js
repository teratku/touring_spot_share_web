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

/**
 * JARTIC の信号（`admin/buildJarticMopedTurns.js` が作る。形は同じ）。
 * ⚠️ OSM より多い（実測: 原付の右折387か所で、OSM に無く JARTIC にある信号が20m以内に21か所）。
 *    いまは原付の二段階右折の判定だけに使う（案内の「信号を〜」は OSM のまま）
 */
const JARTIC_FILE = path.join(__dirname, "..", "data", "jartic-signals.bin");
/** ファイルごとの点（Int32Array。[緯度, 経度, 緯度, 経度, …]）。
 *  ⚠️ **ファイルごとに持つこと。** 1つだけ持つと、2つ目のファイルを頼んでも1つ目を返す */
const cache = new Map();

/** 読み込む（1回だけ）。ファイルが無ければ空で動く（信号を言わないだけ） */
function load(file = FILE) {
  if (cache.has(file)) return cache.get(file);
  let points;
  try {
    const buf = fs.readFileSync(file);
    points = new Int32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  } catch (e) {
    console.error(`信号データを読めません（案内は信号なしで出します）: ${e.message}`);
    points = new Int32Array(0);
  }
  cache.set(file, points);
  return points;
}

/** 読み直す（検査用） */
function reset() { cache.clear(); }

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
 * OSM か JARTIC の**どちらかに**信号があるか。
 *
 * ⚠️ **案内（「信号を右です」「2つ目の信号を右です」）はこちらを使う。** 数えるので、
 *    片方だけだと取りこぼした信号のぶん数え違える。
 *    実測（下道10経路237km の上の信号交差点）: 両方にある376・OSM だけ125・JARTIC だけ36。
 *    曲がり角80のうち信号ありは OSM 55・JARTIC 47・どちらか58（2026-09-26）
 */
function isNearAny(point, radiusMeters = 30, files = [FILE, JARTIC_FILE]) {
  return files.some((f) => isNear(point, radiusMeters, f));
}

/**
 * 曲がる地点の手前 `withinMeters` までに、**経路の上にある信号交差点**までの距離（m・近い順）。
 *
 * アプリは直前の案内で、いまの位置から曲がる地点までにある信号を数え、
 * 「2つ目の信号を右です」「信号を過ぎて、交差点を右です」と言う（利用者の判断 2026-09-26:
 * 直前の案内から交差点名・道路名を外して「信号を右です」にする。手前に別の信号がある曲がり角は
 * 信号のある曲がり角の33%）。
 *
 * ⚠️ **信号は停止線に打たれていて、1つの交差点に向きごとに複数ある。** 経路を5mおきにたどり、
 *    15m以内に信号がある所を拾って、拾った所の切れ目が15mより長ければ別の交差点とする（中心の距離を返す）。
 *    信号1つで30mぶん続けて拾うので、**信号どうしが45m以内なら同じ交差点**になる。
 *    ⚠️ 切れ目を40mにしていたら、60m離れた2つの交差点を1つにまとめていた（検査で分かった）
 * ⚠️ **曲がる地点そのものの信号は数えない**（`atSignal` のとき、曲がる地点から20m以内に掛かるまとまり）。
 *    曲がる地点に信号が無いときは全部返す（手前の信号で曲がらないよう「信号を過ぎて」と言うため）
 * @param {number[][]} points 経路の点（[経度, 緯度]）
 * @param {number} index 曲がる地点の番号
 */
function signalsBefore(points, index, opts = {}) {
  const within = opts.withinMeters ?? 300;
  const files = opts.files || [FILE, JARTIC_FILE];
  if (!Array.isArray(points) || !points[index]) return [];
  const hits = [];
  if (isNearAny(points[index], SIGNAL_HIT_METERS, files)) hits.push(0);
  let back = 0;
  for (let i = index; i > 0 && back < within; i--) {
    const a = points[i], b = points[i - 1];
    const cos = Math.cos((a[1] * Math.PI) / 180);
    const d = Math.hypot((a[0] - b[0]) * METERS_PER_DEGREE * cos, (a[1] - b[1]) * METERS_PER_DEGREE);
    const n = Math.max(1, Math.ceil(d / SAMPLE_METERS));
    for (let k = 1; k <= n; k++) {
      const at = back + (d * k) / n;
      if (at > within) break;
      const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
      if (isNearAny(p, SIGNAL_HIT_METERS, files)) hits.push(at);
    }
    back += d;
  }
  const clusters = [];
  for (const at of hits) {
    const last = clusters[clusters.length - 1];
    if (last && at - last.end <= SAME_JUNCTION_GAP_METERS) last.end = at;
    else clusters.push({ start: at, end: at });
  }
  return clusters
    .filter((c, i) => !(opts.atSignal && i === 0 && c.start <= OWN_SIGNAL_METERS))
    .map((c) => Math.round((c.start + c.end) / 2));
}
/** 経路をたどる刻み（m） */
const SAMPLE_METERS = 5;
/** 経路の点から信号までこの距離なら、その信号の前を通る（m） */
const SIGNAL_HIT_METERS = 15;
/** 拾った所の切れ目がこれより長ければ別の交差点（m）。信号どうしなら45m（大きな交差点は停止線が30〜40m離れる） */
const SAME_JUNCTION_GAP_METERS = 15;
/** 曲がる地点からこの距離までに掛かるまとまりは、曲がる交差点そのものの信号（m。`SIGNAL_RADIUS_METERS` と同じ） */
const OWN_SIGNAL_METERS = 20;

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

module.exports = { isNear, isNearAny, signalsBefore, nearestMeters, count, load, reset, FILE, JARTIC_FILE, METERS_PER_DEGREE };
