/*
 * route-maker-fun.js — 生成物。⚠️ 直接直さないこと（node admin/buildRouteMakerFun.js で作り直す）。
 * 中身は admin/lib の roadCsv, polyline, navGeometry, restrictionOverlap, restrictionTime, restrictionAvoid, roadTags, appFunRoute, roadFeedback, riderInsights。
 * Web のルート作成の「楽しい道・距離ガバ」が使う（アプリの FunRouteBuilder と答え合わせ済みの選び方）。
 * ブラウザでは window.TSSFun、テスト（node）では module.exports
 */
(function (root) {
  var defs = {
  // ---- admin/lib/roadCsv.js ----
  "roadCsv": function (require, module, exports) {
/**
 * roadCsv.js
 *
 * 道路グリッドCSVの読み取り。
 *
 * CSV の geometry 列は WKT の LINESTRING で、中に「, 」が入っている。
 * 引用符の中のカンマを区切りと誤認しないよう、素朴な split ではなく状態機械で読む。
 *
 * 対象データ: ~/Downloads/python/roads_grid_<lat>_<lon>.csv
 *   列: road_category, highway, network, ref, name,
 *       start_lon, start_lat, end_lon, end_lat, longitude, latitude,
 *       geometry, prefecture, city
 *
 * ⚠️ 同じ0.1度グリッドでも、~/Documents/grid_csvs_japan_empty/ の方は
 *    列が osm_id,name,highway,ref,geometry の5つしかなく prefecture を持たない。
 *    グリッドIDの採番も違う（新 = 旧 + 1100 / 3020）。混ぜないこと。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

/** 引用符を考慮して1行を列に分ける */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // "" はエスケープされた引用符
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current); current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** "LINESTRING (139.75 35.64, 139.76 35.63)" → [[lng, lat], ...] */
function parseWkt(wkt) {
  if (!wkt) return null;
  const open = wkt.indexOf("(");
  const close = wkt.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const body = wkt.slice(open + 1, close);
  const points = [];
  for (const pair of body.split(",")) {
    const parts = pair.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    points.push([lng, lat]);
  }
  return points.length >= 2 ? points : null;
}

/** 平面近似の距離（m）。日本の緯度なら十分な精度 */
function distanceMeters(a, b) {
  const dLat = (a[1] - b[1]) * 111320;
  const dLng = (a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

/** グリッドCSVのファイル一覧 */
function listGridFiles(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith("roads_grid_") && f.endsWith(".csv"))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * 1ファイルを1行ずつ読み、行オブジェクトを渡す。
 * メモリに全部載せない（全国で212MB あり、ジオメトリを展開すると数GBになる）。
 */
async function readGridFile(filePath, onRow) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let index = null;
  for await (const raw of lines) {
    // BOM を落とす
    const line = header === null ? raw.replace(/^﻿/, "") : raw;
    if (!line.trim()) continue;
    if (header === null) {
      header = parseCsvLine(line).map((h) => h.trim());
      index = {};
      header.forEach((h, i) => { index[h] = i; });
      continue;
    }
    const fields = parseCsvLine(line);
    const get = (key) => {
      const i = index[key];
      return i === undefined || i >= fields.length ? "" : fields[i].trim();
    };
    onRow({ get, header });
  }
  return header;
}

module.exports = { parseCsvLine, parseWkt, distanceMeters, polylineLength, listGridFiles, readGridFile };

  },
  // ---- admin/lib/polyline.js ----
  "polyline": function (require, module, exports) {
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

  },
  // ---- admin/lib/navGeometry.js ----
  "navGeometry": function (require, module, exports) {
/**
 * navGeometry.js
 *
 * 返ってきた経路の**形そのもの**から、「余計に走らされる形」を見つける。
 *
 * 【なぜ要るか】
 * ⚠️ **経路案内が返す maneuver では検出できない。** 経由地を through にすると、
 *    Uターンを含む経路でも `uturn` の maneuver が1件も返らない
 *    （アプリ側の実測: 3区間 / uturn 0件。Valhalla でも同じで、
 *    実機で「Uターン0回」と出ているのに大山まで下りて戻る経路が出た）。
 *
 * 【どこから来た処理か】
 * iOS の `NavGeometry.swift`（`backtracks` と `alongWherePassedDestination`）を移したもの。
 * **定数は向こうの実測値をそのまま使う。** 勝手に変えると、アプリと管理ツールで
 * 違う判定になり、どちらが正しいか分からなくなる。
 *
 * ⚠️ **点は `[経度, 緯度]`。** Swift 側は `CLLocationCoordinate2D`（緯度が先）なので、
 *    移すときに入れ替わっている。ここでは このツールの流儀に合わせてある。
 */
"use strict";

const { decode } = require("./polyline");

// MARK: 定数（NavGeometry.swift の実測値。⚠️ 勝手に変えないこと）

/**
 * 折り返しとみなす、空間的な離隔の上限（m）。
 *
 * ⚠️ **判別の本質はここ。** 本物の折り返しは同じ道の**同じ中心線**をそのまま戻るので
 *    離隔が 0〜8m しかないのに対し、峠のヘアピンは曲がり半径ぶん離れる。
 *    実測:
 *      本物のUターン   0.0m（三井相模湖線）／ 4.7m（奥牧野相模湖線）
 *      ヘアピン        22〜25m
 *    25 にすると 100〜180m 規模のヘアピンを拾ってしまい、それを抑えるために
 *    `MIN_ALONG_GAP` を 1,000m まで上げるしかなくなり、小さいUターンを見逃す。
 */
const MAX_SPATIAL_GAP_METERS = 8;

/**
 * 折り返しとみなす、沿線距離の下限（m）。
 *
 * ⚠️ 片道100mの往復から拾う値。`MAX_SPATIAL_GAP` を 8m に絞った結果、
 *    対照10経路すべてで 60m でも誤検出0だったので、ここまで下げる余地ができた。
 */
const MIN_ALONG_GAP_METERS = 200;

/**
 * 「同じ道を二度走っている割合」の下限。これ未満なら往復ではなく**周回**。
 *
 * ⚠️ **「同じ場所に戻ってくる」だけでは往復と周回を区別できない。**
 *    周回ルート（出発地＝目的地）はまさに同じ場所へ戻るので、
 *    そのままでは丸ごと折り返しと誤判定する。実測:
 *      往復（Uターン）  0.93〜0.99
 *      周回ルート(92km) 0.02
 */
const MIN_RETRACED_RATIO = 0.5;

/** ゴールに近づいたとみなす距離（m） */
const APPROACH_METERS = 1_500;

/**
 * ゴールの近くを通ってから、さらにこれ以上走るなら「回り込み」とみなす（m）。
 *
 * ⚠️ 実測: 素直な経路は 2.1〜2.3km（最後の詰めのぶん）／
 *    ゴールを通り過ぎて戻る経路は 18.3km・30.1km。
 */
const MIN_TRAVEL_AFTER_METERS = 5_000;

// MARK: 幾何

const M_PER_LAT = 111_320;
const rad = (d) => (d * Math.PI) / 180;

/** 2点の距離（m）。平面近似（数km規模では十分な精度・速い） */
function distance(a, b) {
  const latMid = rad((a[1] + b[1]) * 0.5);
  const dLat = (b[1] - a[1]) * M_PER_LAT;
  const dLon = (b[0] - a[0]) * M_PER_LAT * Math.cos(latMid);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/** 先頭からの沿線距離の表 */
function cumulativeLengths(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + distance(points[i - 1], points[i]));
  }
  return out;
}

/** ポリラインの総延長（m） */
function lengthOf(points) {
  if (!points || points.length < 2) return 0;
  const c = cumulativeLengths(points);
  return c[c.length - 1];
}

/**
 * 点を線に射影する。`{ point, lateralDistance, along }`。
 * ⚠️ 「原因の区間はどこから先か」を切り分けるのに使う。
 */
function project(point, points) {
  if (!points || !points.length) return null;
  if (points.length === 1) {
    return { point: points[0], lateralDistance: distance(point, points[0]), along: 0 };
  }
  const mPerLon = M_PER_LAT * Math.cos(rad(point[1]));
  const toXY = (c) => [(c[0] - point[0]) * mPerLon, (c[1] - point[1]) * M_PER_LAT];

  let best = null;
  let cumulative = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const [ax, ay] = toXY(a), [bx, by] = toXY(b);
    const vx = bx - ax, vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    const segLen = Math.sqrt(lenSq);
    // 原点（＝対象点）から線分への最近傍
    let t = lenSq === 0 ? 0 : (-(ax * vx + ay * vy)) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const nx = ax + vx * t, ny = ay + vy * t;
    const lateral = Math.sqrt(nx * nx + ny * ny);
    if (!best || lateral < best.lateralDistance) {
      best = {
        point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        lateralDistance: lateral,
        along: cumulative + segLen * t,
      };
    }
    cumulative += segLen;
  }
  return best;
}

// MARK: 往復（同じ道を戻る）

/**
 * 経路上で「沿線では `minAlongGap` 以上進んでいるのに、空間的には
 * `maxSpatialGap` 以内に戻ってきている」箇所を探す。
 *
 * ⚠️ **格子に配って近い点だけ比べること。** 総当たりは実測 2,062ms、格子で 19ms。
 *    変種ごとに毎回かけるので、総当たりでは重すぎる。
 *
 * @returns {Array<{location, apex, alongGapMeters}>}
 *   - `location` 経路から逸れ始める地点（往路と復路が合流する交差点）
 *   - `apex` 折り返しの先端。**原因の特定にはこちらを使うこと**
 */
function backtracks(points, opts = {}) {
  const minAlongGap = opts.minAlongGap ?? MIN_ALONG_GAP_METERS;
  const maxSpatialGap = opts.maxSpatialGap ?? MAX_SPATIAL_GAP_METERS;
  const minRetracedRatio = opts.minRetracedRatio ?? MIN_RETRACED_RATIO;
  if (!points || points.length < 2) return [];

  const cumulative = cumulativeLengths(points);
  const cell = Math.max(maxSpatialGap, 1);
  const mPerLon = M_PER_LAT * Math.cos(rad(points[0][1]));
  const xs = new Array(points.length);
  const ys = new Array(points.length);
  const buckets = new Map();
  const key = (x, y) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  for (let k = 0; k < points.length; k++) {
    xs[k] = (points[k][0] - points[0][0]) * mPerLon;
    ys[k] = (points[k][1] - points[0][1]) * M_PER_LAT;
    const bk = key(xs[k], ys[k]);
    if (!buckets.has(bk)) buckets.set(bk, []);
    buckets.get(bk).push(k);
  }
  /** 点 k の近くを、沿線では minAlongGap 以上離れて通っているか */
  function hasRetracedPartner(k, lo, hi) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(key(xs[k] + dx * cell, ys[k] + dy * cell)) || []) {
          if (j < lo || j > hi) continue;
          if (Math.abs(cumulative[j] - cumulative[k]) < minAlongGap) continue;
          if (distance(points[k], points[j]) <= maxSpatialGap) return true;
        }
      }
    }
    return false;
  }

  const found = [];
  for (let i = 0; i < points.length; i++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(key(xs[i] + dx * cell, ys[i] + dy * cell)) || []) {
          if (j <= i) continue;
          const gap = cumulative[j] - cumulative[i];
          if (gap < minAlongGap) continue;
          if (distance(points[i], points[j]) <= maxSpatialGap) found.push({ i, j, gap });
        }
      }
    }
  }
  found.sort((a, b) => (a.i === b.i ? a.j - b.j : a.i - b.i));

  // 重なる検出区間はまとめ、沿線距離が最大のものを代表として残す
  const merged = [];
  for (const c of found) {
    const last = merged[merged.length - 1];
    if (last && c.i <= last.j) {
      if (c.gap > last.gap) merged[merged.length - 1] = c;
    } else {
      merged.push(c);
    }
  }

  const out = [];
  for (const range of merged) {
    // 同じ道を二度走っている割合。低ければ往復ではなく周回
    let retraced = 0;
    for (let k = range.i; k < range.j; k++) {
      if (hasRetracedPartner(k, range.i, range.j)) {
        retraced += cumulative[k + 1] - cumulative[k];
      }
    }
    if (!(range.gap > 0) || retraced / range.gap < minRetracedRatio) continue;

    // 往復のちょうど中間が折り返しの先端（＝往復を強いた経由地）
    const apexAlong = cumulative[range.i] + range.gap / 2;
    let apexIndex = range.i;
    for (let k = range.i; k <= range.j; k++) {
      if (Math.abs(cumulative[k] - apexAlong) < Math.abs(cumulative[apexIndex] - apexAlong)) {
        apexIndex = k;
      }
    }
    out.push({
      location: points[range.i],
      apex: points[apexIndex],
      alongGapMeters: range.gap,
    });
  }
  return out;
}

/** 往復している距離の合計（m）。画面に出す用 */
const retracedMeters = (points, opts) =>
  backtracks(points, opts).reduce((a, b) => a + b.alongGapMeters, 0);

// MARK: ゴールの回り込み

/**
 * 経路がゴールのすぐ近くを通ってから、そこで終わらずに大きく走り回って戻る場合、
 * **最初にゴールの近くを通った地点の沿線距離**を返す。そうでなければ null。
 *
 * ⚠️ **`backtracks` では捕まらない。** 行きと帰りが別の道を通ると同じ道を二度走らない。
 *    利用者からは「Uターンと同じ迷惑」として報告された形。
 */
function alongWherePassedDestination(points, destination, opts = {}) {
  const approachMeters = opts.approachMeters ?? APPROACH_METERS;
  const minTravelAfter = opts.minTravelAfterMeters ?? MIN_TRAVEL_AFTER_METERS;
  if (!points || points.length < 2) return null;

  let cumulative = 0;
  let passedAlong = null;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) cumulative += distance(points[i - 1], points[i]);
    if (passedAlong === null && distance(points[i], destination) <= approachMeters) {
      passedAlong = cumulative;
    }
  }
  if (passedAlong === null) return null;
  return cumulative - passedAlong >= minTravelAfter ? passedAlong : null;
}

// MARK: 原因の区間を探す

/**
 * その地点にいちばん近い区間を返す。
 *
 * ⚠️ **折り返しの先端（`apex`）を渡すこと。** 往復の入口（`location`）では
 *    特定できない。実測: 奥牧野相模湖線への 4,537m の往復で、入口は区間から
 *    **1,416m 離れており 500m 以内で見つからなかった**。先端は同じ区間から 0m。
 */
/**
 * 折り返しの先端から、原因の区間までの距離の上限（m）。
 *
 * ⚠️ **アプリは 500m だが、こちらは広い。** 向こうはコリドーを広げないので
 *    先端が区間の上（0m）に乗る。こちらは「回り込みの広さ ×5」まで許すため、
 *    枝の奥にある区間を通すときに先端がその手前に来る。
 *
 * 【実測（3区間・13箇所の折り返し）】
 *   最寄りまでの距離   2 / 2 / 8 / 9 / 9 / 91 / 91 / 115 / 267 / 530 / 1750 / 2237 / 3584 m
 *   次に近い区間まで   707 / 949 / 1085 / 1571 / 4075 / 5329 / 8971 / 9998 …
 *   **4,000m なら13箇所すべてで正しい区間だけを拾う**（次点は最小4,075m）。
 *
 * ⚠️ 500m のままだと、新座→愛川の 66.7km の往復（先端3,584m）を
 *    特定できず、そのまま残っていた。
 */
const BLAME_WITHIN_METERS = 4_000;

function segmentNearest(location, segments, maxDistanceMeters = BLAME_WITHIN_METERS) {
  let best = null;
  for (const seg of segments || []) {
    let dist = Infinity;
    // ⚠️ **道の線そのもので測ること。端点だけでは当たらない。**
    //    実測: 秦野清川線（187点・約5.6km）の折り返しの先端まで、
    //    端点だと3,571m だが**線までなら20m**。端点で見ていたため原因を
    //    特定できず、66.7km の往復がそのまま残っていた。
    const line = decodeSegmentLine(seg);
    if (line) {
      const proj = project(location, line);
      if (proj) dist = proj.lateralDistance;
    } else if (Array.isArray(seg.start) && Array.isArray(seg.end)) {
      // ⚠️ start / end は [緯度, 経度] で来る（配信データの形）
      dist = Math.min(distance(location, [seg.start[1], seg.start[0]]),
                      distance(location, [seg.end[1], seg.end[0]]));
    } else {
      continue;
    }
    if (!best || dist < best.dist) best = { seg, dist };
  }
  return best && best.dist <= maxDistanceMeters ? best.seg : null;
}

/**
 * 区間の線を取り出す。`points` を持っていればそれ、無ければ `polyline` を解く。
 * ⚠️ 配信データの `polyline` は**5桁**（`lib/polyline.js` の流儀）。
 *    Valhalla の6桁と混ぜないこと。
 */
function decodeSegmentLine(seg) {
  if (Array.isArray(seg.points) && seg.points.length >= 2) return seg.points;
  if (typeof seg.polyline !== "string" || !seg.polyline) return null;
  if (!seg.__line) {
    try { seg.__line = decode(seg.polyline); } catch (e) { seg.__line = null; }
  }
  return seg.__line && seg.__line.length >= 2 ? seg.__line : null;
}

module.exports = {
  backtracks, retracedMeters, alongWherePassedDestination,
  segmentNearest, decodeSegmentLine, project, distance, lengthOf, cumulativeLengths,
  MAX_SPATIAL_GAP_METERS, MIN_ALONG_GAP_METERS, MIN_RETRACED_RATIO,
  APPROACH_METERS, MIN_TRAVEL_AFTER_METERS, BLAME_WITHIN_METERS,
};

  },
  // ---- admin/lib/restrictionOverlap.js ----
  "restrictionOverlap": function (require, module, exports) {
/**
 * restrictionOverlap.js
 *
 * 通行規制の区間と、おすすめ道路の区間が重なっていないかを調べる。
 *
 * 【なぜ必要か】
 * 生成もアプリも**規制をまったく見ていない**。二輪通行禁止の道がおすすめとして
 * 配信され、ルート生成が自分でそれを選ぶことがあり得る。走れない道へ案内する
 * ことになるので、配信する前に気付けるようにする。
 *
 * 【重なりの測り方】
 * 規制の線を一定間隔で打ち直し、その点が道の線の `nearMeters` 以内に何割あるかを見る。
 * 「近い点が1つでもあれば重なり」にはしない。交差するだけの道（交差点で1点だけ近い）
 * まで拾ってしまい、無関係な道が軒並み引っかかる。
 */
"use strict";

/** 点が線の上にあるとみなす距離（m）。GPS ではなく地図データ同士なので厳しめでよい */
const NEAR_METERS = 25;

/** 規制の線を打ち直す間隔（m） */
const STEP_METERS = 20;

/** これ以上の割合が重なっていたら「同じ道」とみなす */
const MIN_RATIO = 0.3;

/**
 * **経路が**規制線の上を連続して走った距離（m）。これを超えたら「通っている」。
 *
 * ⚠️ **割合（`MIN_RATIO`）では経路を測れない。** あれは「この道とこの道は同じ道か」
 *    を見る物差しで、おすすめ道路を一覧から落とすのに使う。経路は**1mでも走れば
 *    通行禁止違反**なので、長い規制線をかすめただけでも拾わなければならない。
 *    実測（2026-09-20・朝日峠展望公園への経路。実機で報告された形）:
 *      フルーツライン(八郷広域農道) … 重なり100%・連続3,228m → 割合でも拾えた
 *      表筑波スカイライン            … 重なり 17%・連続  763m → **割合では見逃す**
 *      フルーツライン(八郷広域農道) … 重なり  2%・連続   67m → **割合では見逃す**
 *
 * ⚠️ **交差点で横切るだけを拾わないための下限。** 実測（打ち直したあとの値）:
 *      90度で横切る … 連続 50m
 *      45度        … 連続 71m
 *      30度        … 連続100m
 *      20度        … 連続146m
 *    浅い角度で交わる道まで含めて外すため、**150m** を下限にする。
 * ⚠️ これを下回る「短く走った」ぶんは見逃す。同じ道の別区間で長く走っていれば
 *    そちらで拾えるので、警告そのものは出る（実測: フルーツライン(八郷広域農道)は
 *    67m の区間を見逃すが、3,228m の区間で拾える）。
 * ⚠️ もっと厳しく見たくなったら、距離ではなく**経路と規制線の向き**
 *    （並行か直交か）で見分けること。距離だけでは浅い角度の横切りと区別できない。
 */
const ROUTE_RUN_METERS = 150;

function distanceMeters(a, b) {
  const R = 6371000;
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 一定間隔で打ち直す。点の粗密で判定がぶれないように */
function resample(points, step = STEP_METERS) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = distanceMeters(points[i - 1], points[i]);
    if (seg <= 0) continue;
    let t = step - carry;
    while (t <= seg) {
      const f = t / seg;
      out.push([
        points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f,
        points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f,
      ]);
      t += step;
    }
    carry = (carry + seg) % step;
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * 点の並びを囲む箱（余白つき）。⚠️ 点は **[経度, 緯度]**。
 *
 * ⚠️ **長い経路では、これで弾かないと終わらない。** 規制1件ごとに経路の全点を
 *    測っていたため、1,509kmの経路×199件で **67秒**かかっていた
 *    （実機で報告 2026-09-21: 50ccで鹿児島まで引くとタイムアウトする）。
 */
function boundsOf(points, marginMeters = 0) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of points) {
    if (!p) continue;
    if (p[0] < minLon) minLon = p[0];
    if (p[0] > maxLon) maxLon = p[0];
    if (p[1] < minLat) minLat = p[1];
    if (p[1] > maxLat) maxLat = p[1];
  }
  if (!Number.isFinite(minLon)) return null;
  const dLat = marginMeters / 111_320;
  // ⚠️ 経度の余白は緯度で変わる。高緯度ほど1度が短いので、余白は広く取る
  const cos = Math.max(0.1, Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));
  const dLon = marginMeters / (111_320 * cos);
  return { minLon: minLon - dLon, maxLon: maxLon + dLon,
           minLat: minLat - dLat, maxLat: maxLat + dLat };
}

const inBounds = (p, b) => p[0] >= b.minLon && p[0] <= b.maxLon
  && p[1] >= b.minLat && p[1] <= b.maxLat;

const boundsOverlap = (a, b) => !(a.maxLon < b.minLon || a.minLon > b.maxLon
  || a.maxLat < b.minLat || a.minLat > b.maxLat);

/** 格子の一辺（度）。約2km。⚠️ `NEAR_METERS`(25m) より十分大きいこと */
const CELL_DEG = 0.02;
const cellKey = (lon, lat) => `${Math.floor(lon / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;

/**
 * 長い線を格子に入れて、近くの点だけ測れるようにする。
 *
 * ⚠️ **打ち直してから入れること。** 格子には線の「点」しか入らないので、
 *    点の間隔が格子（約2km）より広い区間があると、その真ん中を問われたときに
 *    近傍のセルが空になり**取りこぼす**。打ち直せば間隔が `STEP_METERS` に
 *    揃うので、この穴が塞がる（中点を足す小細工では塞ぎきれない）。
 * ⚠️ 打ち直した点の番号は**返さない**。ここは距離を測るためだけの道具で、
 *    範囲の番号は `spansOnLine` が元の線で出す
 */
function indexLine(line) {
  const pts = resample(line, STEP_METERS);
  const cells = new Map();
  for (let i = 0; i < pts.length; i++) {
    const k = cellKey(pts[i][0], pts[i][1]);
    const at = cells.get(k);
    if (at) at.push(i); else cells.set(k, [i]);
  }
  return { line: pts, cells, bounds: boundsOf(pts, 0) };
}

/** 格子を使って点と線の距離を測る。⚠️ 近く（数km）でなければ Infinity でよい */
function distanceToIndexed(point, index) {
  const cx = Math.floor(point[0] / CELL_DEG), cy = Math.floor(point[1] / CELL_DEG);
  let best = Infinity;
  const line = index.line;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const at = index.cells.get(`${cx + dx}:${cy + dy}`);
      if (!at) continue;
      for (const i of at) {
        const d = distanceMeters(point, line[i]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** 点から線までの最短距離。辺の途中も見る */
function distanceToLine(point, line) {
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    best = Math.min(best, distanceMeters(point, line[i]));
    if (i + 1 < line.length) {
      const mid = [(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2];
      best = Math.min(best, distanceMeters(point, mid));
    }
  }
  return best;
}

/**
 * 規制の線が、道の線とどれだけ重なっているか（0〜1）。
 *
 * ⚠️ **規制の側を基準にすること。** 道の側を基準にすると、長い道の一部だけに
 *    掛かった規制を「ほとんど重なっていない」と見誤る。規制されている区間が
 *    その道の上にあるかどうかが知りたい。
 */
function overlapRatio(restrictionLine, roadLine, nearMeters = NEAR_METERS, index = null) {
  const points = resample(restrictionLine);
  if (!points.length || roadLine.length < 2) return 0;
  // ⚠️ **長い線は格子で測ること。** 総当たりだと1,509kmの経路で待たされる
  //    （`boundsOf` の説明を読むこと）。格子は呼ぶ側が使い回す
  const idx = index || (roadLine.length > 2_000 ? indexLine(roadLine) : null);
  let hit = 0;
  for (const p of points) {
    const d = idx ? distanceToIndexed(p, idx) : distanceToLine(p, roadLine);
    if (d <= nearMeters) hit++;
  }
  return hit / points.length;
}

/**
 * 規制に重なっているおすすめ道路を探す。
 *
 * @param {Array} restrictions [{ id, name, kind, points }]
 * @param {Array} roads        [{ id, name, points }]
 * @returns {Map} 道のid → [{ restrictionId, name, kind, ratio }]
 */
function findOverlaps(restrictions, roads, options = {}) {
  const nearMeters = options.nearMeters ?? NEAR_METERS;
  const minRatio = options.minRatio ?? MIN_RATIO;
  const found = new Map();
  for (const road of roads) {
    if (!road.points || road.points.length < 2) continue;
    // ⚠️ **道ごとに1回だけ作ること。** 規制1件ごとに作り直すと元の木阿弥
    const idx = road.points.length > 2_000 ? indexLine(road.points) : null;
    const roadBox = boundsOf(road.points, 5000);
    for (const restriction of restrictions) {
      if (!restriction.points || restriction.points.length < 2) continue;
      // ⚠️ 先に大づかみで弾く。全部の点を測ると、県内150本×規制数で待たされる。
      //    ⚠️ **まず箱で弾く**（O(1)）。距離での足切りは経路の全点を測るので、
      //    長い経路では1件ごとに数十msかかる（実測: 1,509kmで11.5秒）
      const rBox = boundsOf(restriction.points, 0);
      if (!rBox || !roadBox || !boundsOverlap(rBox, roadBox)) continue;
      if (!idx && distanceToLine(restriction.points[0], road.points) > 5000) continue;
      const ratio = overlapRatio(restriction.points, road.points, nearMeters, idx);
      if (ratio < minRatio) continue;
      if (!found.has(road.id)) found.set(road.id, []);
      found.get(road.id).push({
        restrictionId: restriction.id,
        name: restriction.name,
        kind: restriction.kind,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  }
  return found;
}

/** 「そもそも通れない」規制の種別。二人乗り禁止・冬季閉鎖は条件次第で走れる */
const BLOCKING_KINDS = new Set(["noMotorcycle", "closed"]);

/**
 * 排気量の区切り。アプリの `BikeDisplacement.ccRange` と同じ
 * （`touringSpotShare/saveRoute/nav/BikeProfile.swift`）。
 * ⚠️ 片方だけ変えると、生成で落とす道とアプリが避ける道が食い違う
 */
const DISPLACEMENT_RANGES = [[0, 50], [51, 125], [126, 250], [251, 99_999]];

/** その規制が、この排気量の乗り手に当たるか。範囲が重なっていれば当たり */
function appliesToRange(restriction, [low, high]) {
  const min = Number.isFinite(restriction.minCc) ? restriction.minCc : 0;
  const max = Number.isFinite(restriction.maxCc) ? restriction.maxCc : 99_999;
  return low <= max && high >= min;
}

/**
 * どの排気量の乗り手でも通れない規制か。
 *
 * ⚠️ **おすすめ道路は排気量ごとに作り分けていない。** 1県につき1本の同じ一覧を
 *    全員に配る。だから生成の段で落としてよいのは「全員が通れない」規制だけ。
 *    原付だけ通れない道（小田原厚木道路・ターンパイク箱根・芦ノ湖スカイラインなど、
 *    神奈川県だけで324本）をここで落とすと、251ccの人のおすすめからも消える。
 *    排気量ごとの出し分けはアプリ側の仕事
 *    （`FunRoadRestrictionFilter` が `RoadRestriction.applies(to:)` で乗り手を見る）。
 */
function blocksEveryone(restriction) {
  return DISPLACEMENT_RANGES.every((range) => appliesToRange(restriction, range));
}

/**
 * いつでも効いている規制か（時間・曜日・月の指定が無い）。
 *
 * ⚠️ **時間限定の規制をおすすめから落としてはいけない。** 落とすと、
 *    1日23時間走れる道が丸ごと消える。実測: JARTIC の候補1,442件のうち
 *    **全員が通れないもの235件、そのうち90件が時間・曜日つき**
 *    （千葉の通学路規制「07:00〜08:00」など）。
 *    いま登録済みの時間つきは48件しかないので表面化していなかったが、
 *    JARTIC を入れると388件になる。
 *
 * ⚠️ **「効いている時間帯だけ避ける」のは経路を引くときの仕事**
 *    （`excludePolygons`）。おすすめ道路の一覧は時刻を持たないので、
 *    ここでは「いつ行っても通れない」ものだけを落とす。
 */
function blocksAlways(restriction) {
  if (!restriction) return false;
  if (restriction.activeHours) return false;
  if (Array.isArray(restriction.activeDays) && restriction.activeDays.length
      && restriction.activeDays.length < 7) return false;
  if (restriction.includesHoliday) return false;
  if (Array.isArray(restriction.activeMonths) && restriction.activeMonths.length
      && restriction.activeMonths.length < 12) return false;
  return true;
}

/**
 * 二輪が通れない規制と重なる、おすすめ道路の番号を返す。
 *
 * ⚠️ **おすすめ道路の区間は `points` を持っていない。** 持っているのは
 *    `polyline`（符号化した文字列）で、`points` は生成の途中でしか存在しない。
 *    そこを取り違えて `seg.points` を渡していたため、この除外は
 *    **一度も働いていなかった**（栃木で「0本除外」と出ていたのは、規制が
 *    重ならなかったのではなく空振りしていたから）。エラーは出ない。
 *    だからここで受け取って、この中で復号する。
 *
 * ⚠️ 落とすのは**全員が通れない**規制だけ（`blocksEveryone`）。理由はそちらに書いた。
 *
 * @param {Array} saved    data/road-restrictions/<romaji>.json の `restrictions`
 * @param {Array} segments おすすめ道路の区間（`polyline` を持つ形）
 * @returns {Map} 区間の番号 → [{ restrictionId, name, kind, ratio }]
 */
function blockedSegments(saved, segments) {
  const { decode } = require("./polyline");
  const restrictions = (saved || [])
    // ⚠️ **全員が・いつでも通れないものだけ落とす**（`blocksAlways` の説明を読むこと）
    .filter((r) => r && BLOCKING_KINDS.has(r.kind) && r.polyline
                     && blocksEveryone(r) && blocksAlways(r))
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, points: decode(r.polyline) }))
    .filter((r) => r.points.length >= 2);
  if (!restrictions.length) return new Map();

  const roads = (segments || []).map((seg, index) => ({
    id: index,
    name: seg.name,
    // 生成の途中では `points`、書き出したあとは `polyline`。どちらでも受ける
    points: seg.points || (seg.polyline ? decode(seg.polyline) : null),
  }));
  return findOverlaps(restrictions, roads);
}

/**
 * 経路が規制線の上を**連続して走った**距離のうち、いちばん長いもの（m）。
 *
 * ⚠️ 合計ではなく連続を見る。交差点で何度も横切る道と、一度まとまって走る道を
 *    同じ扱いにしないため。
 */
function longestRunOnLine(routePoints, linePoints, nearMeters = NEAR_METERS) {
  // ⚠️ **打ち直してから測ること。** 経路の点は間隔がまちまちで、粗いところでは
  //    1区間まるごとが「近い」と数えられて**実際の3倍**になる
  //    （実測: 同じ直角の横切りが、点の間隔22mで67m・222mで222m）。
  const pts = resample(routePoints, STEP_METERS);
  // ⚠️ **規制線の近くだけ測ること。** 経路の全点×規制の全点を測ると、
  //    1,509kmの経路で1件あたり90msかかる（実測）。
  //    箱の外は「近くない」と決まっているので測らなくてよい
  const box = boundsOf(linePoints, nearMeters + STEP_METERS * 2);
  let best = 0, run = 0;
  for (let i = 1; i < pts.length; i++) {
    if (box && !inBounds(pts[i], box)) { run = 0; continue; }
    if (distanceToLine(pts[i], linePoints) <= nearMeters) {
      run += distanceMeters(pts[i - 1], pts[i]);
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * 経路のうち、規制線の上を走っている範囲（**元の経路の添字**）。
 *
 * ⚠️ **添字は打ち直す前のものを返すこと。** 画面はこの範囲で線を塗り分けるので、
 *    打ち直した点の番号を返すと**別の場所に赤が出る**。
 *    測るとき（`longestRunOnLine`）だけ打ち直す。
 */
function spansOnLine(routePoints, linePoints, nearMeters = NEAR_METERS) {
  const spans = [];
  let begin = -1;
  for (let i = 0; i < routePoints.length; i++) {
    const on = distanceToLine(routePoints[i], linePoints) <= nearMeters;
    if (on && begin < 0) begin = i;
    if (!on && begin >= 0) { spans.push({ begin, end: i - 1 }); begin = -1; }
  }
  if (begin >= 0) spans.push({ begin, end: routePoints.length - 1 });
  // ⚠️ 1点だけの範囲は線にならない。捨てる
  return spans.filter((s) => s.end > s.begin);
}

module.exports = {
  findOverlaps, overlapRatio, resample, distanceToLine, blockedSegments,
  longestRunOnLine, spansOnLine, ROUTE_RUN_METERS,
  blocksEveryone, blocksAlways, appliesToRange,
  NEAR_METERS, STEP_METERS, MIN_RATIO, BLOCKING_KINDS, DISPLACEMENT_RANGES,
};

  },
  // ---- admin/lib/restrictionTime.js ----
  "restrictionTime": function (require, module, exports) {
/**
 * restrictionTime.js
 *
 * 通行規制の「効いている時間」を扱う（純ロジック）。
 *
 * 【なぜ必要か】
 * 二輪の規制は時間や曜日で切られていることが多い（「土日祝の 7:00〜19:00 のみ二輪通行禁止」など）。
 * 月（`activeMonths`）だけでは表せず、通れる時間まで「通行禁止」と案内してしまう。
 *
 * 【持ち方】
 *   activeDays  … 1=月 〜 7=日。空／未指定なら毎日
 *   includesHoliday … 祝日も含めるか（土日と別に指定されることがある）
 *   activeHours … { from: "07:00", to: "19:00" }。未指定なら終日
 *
 * ⚠️ **日をまたぐ指定を落とさないこと。** 「22:00〜05:00」は実在する（夜間規制）。
 *    from > to のときは、またぐものとして扱う。
 */
"use strict";

/** "07:00" → 420（分）。読めなければ null */
function parseHm(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
  return h * 60 + min;
}

/** 分 → "07:00" */
function formatHm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 保存できる形に整える。おかしな値は落とす（null にする）。
 *
 * ⚠️ 片方だけの時刻を通さないこと。「7:00から」だけでは終わりが決まらず、
 *    アプリ側で終日と区別できない。
 */
function normalizeHours(hours) {
  if (!hours) return null;
  const from = parseHm(hours.from);
  const to = parseHm(hours.to);
  if (from === null || to === null) return null;
  if (from === to) return null;              // 同じ時刻は「終日」と区別できない
  return { from: formatHm(from), to: formatHm(to) };
}

/** 曜日の指定を整える。1〜7 以外は落とす。全部そろっていれば「毎日」として null にする */
function normalizeDays(days) {
  if (!Array.isArray(days)) return null;
  const set = [...new Set(days.map(Number).filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (!set.length || set.length === 7) return null;
  return set;
}

/**
 * その日時に規制が効いているか。
 *
 * @param {object} restriction { activeDays, includesHoliday, activeHours }
 * @param {Date}   at
 * @param {object} options { isHoliday: boolean } 祝日かどうかは呼び出し側が渡す
 */
function isActiveAt(restriction, at, options = {}) {
  const days = normalizeDays(restriction.activeDays);
  if (days) {
    // ⚠️ JavaScript の getDay() は 0=日。1=月〜7=日 に直してから比べる
    const day = at.getDay() === 0 ? 7 : at.getDay();
    const holidayCounts = restriction.includesHoliday && options.isHoliday;
    if (!days.includes(day) && !holidayCounts) return false;
  }

  const hours = normalizeHours(restriction.activeHours);
  if (!hours) return true;                   // 時間の指定が無ければ終日
  const now = at.getHours() * 60 + at.getMinutes();
  const from = parseHm(hours.from);
  const to = parseHm(hours.to);
  // ⚠️ 日をまたぐ指定（22:00〜05:00）。単純な from <= now < to では落とす
  return from < to ? now >= from && now < to
                   : now >= from || now < to;
}

/** 画面や一覧に出す説明。指定が無ければ空 */
function describe(restriction) {
  const parts = [];
  const days = normalizeDays(restriction.activeDays);
  if (days) {
    const names = ["月", "火", "水", "木", "金", "土", "日"];
    parts.push(days.map((d) => names[d - 1]).join("・"));
  }
  if (restriction.includesHoliday) parts.push("祝");
  const hours = normalizeHours(restriction.activeHours);
  if (hours) parts.push(`${hours.from}〜${hours.to}`);
  return parts.join(" ");
}

module.exports = { parseHm, formatHm, normalizeHours, normalizeDays, isActiveAt, describe };

  },
  // ---- admin/lib/restrictionAvoid.js ----
  "restrictionAvoid": function (require, module, exports) {
/**
 * restrictionAvoid.js
 *
 * **引いた経路が二輪の通行規制に掛かっていないか**を見て、掛かっていれば
 * その場所を `exclude_polygons` で塞ぐための形を作る（純ロジック。通信はしない）。
 *
 * 【なぜ「引いてから」なのか】
 * ⚠️ **`exclude_polygons` は周囲の合計に上限がある**（Valhalla の
 *    `max_exclude_polygons_length`、既定 10,000m）。船を避けるときに実際に踏んだ:
 *    ±0.005度の四角3個で「Exceeded maximum circumference」になる。
 *    県内の規制を全部渡すことはできない（神奈川だけで登録済み27件＋JARTIC21件）。
 *    **引いた経路に実際に掛かったものだけ塞ぐ**なら、たいてい0〜数件で収まる。
 *
 * ⚠️ 上限は設定で変えられる（自前の Valhalla なので）。ただし上げると
 *    Valhalla が全部の辺を全部の多角形と突き合わせることになるので、
 *    **まず「当たったものだけ」で足りるか確かめること。**
 *
 * 【時間・曜日を見る】
 * ⚠️ **おすすめ道路の一覧づくりとは判断が違う。** あちらは時刻を持たないので
 *    「全員が・いつでも通れない」ものだけ落とす（`restrictionOverlap.blocksAlways`）。
 *    こちらは**いつ走るかが分かっている**ので、その時刻に効いている規制を避ける。
 *    実測: JARTIC の候補1,442件のうち388件が時間つき。千葉の通学路規制
 *    「07:00〜08:00」のように、時間を見ないと避けすぎ・避けなさすぎになる。
 */
"use strict";

const { findOverlaps, appliesToRange, BLOCKING_KINDS,
        longestRunOnLine, spansOnLine, ROUTE_RUN_METERS, NEAR_METERS } = require("./restrictionOverlap");
const { isActiveAt } = require("./restrictionTime");
const { decode } = require("./polyline");

/**
 * 排気量の区分 → 範囲。
 * ⚠️ アプリの `BikeDisplacement.ccRange` と同じ（`BikeProfile.swift`）。
 *    片方だけ変えると、避ける道が食い違う。
 */
const DISPLACEMENT_CC = {
  moped50:   [0, 50],
  small125:  [51, 125],
  medium250: [126, 250],
  large:     [251, 99_999],
};

/** 規制の線をどれだけ膨らませて塞ぐか。⚠️ 大きくすると上限にすぐ当たる */
const BUFFER_METERS = 25;

/**
 * その乗り手が、その時刻に通れない規制だけを選ぶ。
 *
 * @param {Array}  restrictions `data/road-restrictions/<romaji>.json` の `restrictions`
 * @param {object} opts { displacement, at, isHoliday }
 *   `at` を渡さなければ**時間の判断をしない**（＝時間指定のあるものも対象に含める）。
 *   ⚠️ 走る時刻が分からないのに「いまは通れる」と判断してはいけない。
 */
function applicable(restrictions, opts = {}) {
  const range = DISPLACEMENT_CC[opts.displacement] || null;
  const out = [];
  for (const r of restrictions || []) {
    if (!r || !BLOCKING_KINDS.has(r.kind)) continue;
    // ⚠️ 排気量が分からないときは絞らない（避けすぎより見落としのほうが危ない）
    if (range && !appliesToRange(r, range)) continue;
    if (opts.at && !isActiveAt(r, opts.at, { isHoliday: !!opts.isHoliday })) continue;
    const points = r.points || (r.polyline ? decode(r.polyline) : null);
    if (!points || points.length < 2) continue;
    out.push({ ...r, points });
  }
  return out;
}

/**
 * 引いた経路に掛かっている規制を返す。
 *
 * ⚠️ **判定は `restrictionOverlap.findOverlaps` を使い回す。** おすすめ道路の
 *    除外と同じ物差しにしておかないと、「一覧からは消えたのに経路は通る」
 *    「一覧には出るのに経路が避ける」という食い違いが起きる。
 *
 * @returns {Array} [{ id, name, kind, ratio, points }] 掛かっている順ではなく重なりの大きい順
 */
function hitsOnRoute(routePoints, restrictions, options = {}) {
  if (!Array.isArray(routePoints) || routePoints.length < 2) return [];
  const found = findOverlaps(restrictions, [{ id: "route", points: routePoints }], options);
  const hits = found.get("route") || [];
  const byId = new Map(restrictions.map((r) => [r.id, r]));

  // ⚠️ **割合だけでは足りない。** `findOverlaps` の物差しは「この道とこの道は
  //    同じ道か」で、長い規制線を少しかすめただけの経路を取りこぼす。
  //    経路は**走った距離**で見ること（実機で報告: 「二輪禁止表示は出ているが
  //    二輪禁止ルートを通ってしまっている」。表筑波スカイラインを763m走って
  //    いたのに、重なり17%で見逃していた）。
  const seen = new Set(hits.map((h) => h.restrictionId));
  const near = options.nearMeters ?? NEAR_METERS;
  const runLimit = options.runMeters ?? ROUTE_RUN_METERS;
  for (const r of restrictions) {
    if (seen.has(r.id) || !r.points || r.points.length < 2) continue;
    const run = longestRunOnLine(routePoints, r.points, near);
    if (run <= runLimit) continue;
    hits.push({ restrictionId: r.id, name: r.name, kind: r.kind,
                // ⚠️ 割合も添える（並べ替えと表示に使う）。走った距離で拾ったものは
                //    割合が小さいので、ここで0にはしない
                ratio: 0, runMeters: Math.round(run) });
  }

  return hits
    .map((h) => {
      const src = byId.get(h.restrictionId) || {};
      // ⚠️ **確認済みかどうかを落とさない。** 未確認（JARTIC の候補）を避けたのか、
      //    人が地図で見て登録したものを避けたのかは、見る側にとって意味が違う
      // ⚠️ **どこを走ったかも返すこと。** 画面はこの範囲を赤点線にして
      //    「ここは通れない」と示す（実機の要望）。件数だけでは場所が分からない
      return { ...h, id: h.restrictionId, points: src.points,
               verified: src.verified !== false,
               spans: src.points ? spansOnLine(routePoints, src.points, options.nearMeters ?? NEAR_METERS) : [] };
    })
    .filter((h) => h.points && h.points.length >= 2)
    .sort((a, b) => b.ratio - a.ratio);
}

/**
 * 線の上に、通せんぼの小さな四角を点々と置く。
 *
 * ⚠️ **線全体を包んではいけない。** 最初そうしたら、10km級の規制（芦ノ湖スカイライン）で
 *    周囲が **21,700m** になり、上限10,000mを超えて**まるごと捨てられた**（塞げていない）。
 * ⚠️ **道を通れなくするのに、道全体を塞ぐ必要はない。** 1点塞げばそこは通れない。
 *    ただし1点だけだと、その手前で入って手前で出る経路が残るので、
 *    **一定の間隔で点々と置く**。25m四方なら1個あたり周囲200mで、
 *    10km級の規制でも 10個 × 200m = 2,000m に収まる。
 * ⚠️ **四角は小さく保つこと。** 大きくすると規制されていない交差道路まで巻き込む。
 */
const BLOCK_EVERY_METERS = 1_000;

function boxesAround(points, bufferMeters = BUFFER_METERS, everyMeters = BLOCK_EVERY_METERS) {
  const spots = spotsAlong(points, everyMeters);
  const dLat = bufferMeters / 110_540;
  return spots.map(([lng, lat]) => {
    const dLng = bufferMeters / (111_320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    const a = [lng - dLng, lat - dLat];
    const b = [lng + dLng, lat - dLat];
    const c = [lng + dLng, lat + dLat];
    const d = [lng - dLng, lat + dLat];
    return [a, b, c, d, a];
  });
}

/** 線の上に、おおよそ `everyMeters` ごとの点を取る。⚠️ 端は避ける（交差点に掛かりやすい） */
function spotsAlong(points, everyMeters) {
  const total = lengthOf(points);
  if (total <= 0) return [points[0]];
  const count = Math.max(1, Math.round(total / everyMeters));
  const out = [];
  for (let i = 0; i < count; i++) {
    // ⚠️ 端ではなく、区切りの真ん中を取る。端は他の道との接続点になりやすい
    out.push(pointAt(points, total * (i + 0.5) / count));
  }
  return out;
}

function lengthOf(points) {
  let t = 0;
  for (let i = 1; i < points.length; i++) t += metersBetween(points[i - 1], points[i]);
  return t;
}

function pointAt(points, along) {
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const step = metersBetween(points[i - 1], points[i]);
    if (run + step >= along) {
      const t = step > 0 ? (along - run) / step : 0;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
              points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
    }
    run += step;
  }
  return points[points.length - 1];
}

function metersBetween(a, b) {
  const dLat = (b[1] - a[1]) * 110_540;
  const dLng = (b[0] - a[0]) * 111_320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

/** 環の周囲（m）。⚠️ Valhalla の上限に収まるかを、渡す前に自分で確かめるため */
function perimeterOf(ring) {
  let total = 0;
  for (let i = 1; i < ring.length; i++) total += metersBetween(ring[i - 1], ring[i]);
  return total;
}

/**
 * 掛かっている規制から、Valhalla に渡す多角形を作る。
 *
 * ⚠️ **上限に収まるぶんだけ返すこと。** 超えると Valhalla は
 *    「Exceeded maximum circumference for exclude_polygons」で**経路ごと失敗する**。
 *    一部しか渡せなかったことは呼び出し側へ返し、黙って落とさない。
 *
 * @returns {{polygons: Array, used: Array, skipped: Array, perimeter: number}}
 */
function excludePolygonsFor(hits, options = {}) {
  const budget = options.maxPerimeterMeters ?? 10_000;
  const buffer = options.bufferMeters ?? BUFFER_METERS;
  // ⚠️ **短いものを塞ぐときは間隔を詰めること。** 既定は1,000mおきなので、
  //    300mの輪には1個しか置かれず、塞げていないのに塞いだつもりになる
  const every = options.everyMeters ?? BLOCK_EVERY_METERS;
  const polygons = [];
  const used = [];
  const skipped = [];
  let perimeter = 0;

  for (const hit of hits) {
    const rings = boxesAround(hit.points, buffer, every);
    const cost = rings.reduce((a, r) => a + perimeterOf(r), 0);
    if (perimeter + cost > budget) { skipped.push({ ...hit, perimeter: cost }); continue; }
    polygons.push(...rings);
    perimeter += cost;
    used.push({ ...hit, perimeter: cost });
  }
  return { polygons, used, skipped, perimeter: Math.round(perimeter) };
}

module.exports = {
  applicable, hitsOnRoute, excludePolygonsFor, boxesAround, perimeterOf,
  DISPLACEMENT_CC, BUFFER_METERS, BLOCK_EVERY_METERS, spotsAlong,
};

  },
  // ---- admin/lib/roadTags.js ----
  "roadTags": function (require, module, exports) {
/**
 * roadTags.js
 *
 * おすすめ道路に付ける「札」の鍵と、その日本語表示名。
 *
 * 【なぜ鍵にするか】
 * ⚠️ **札は配信データに入り、アプリで音声案内にそのまま乗る**
 *    （`NavigationEngine.swift:362`「札があれば、そのまま言い回しに乗せる」）。
 *    日本語のまま配ると、海外へ出したときに日本語が読み上げられる。
 *
 * ⚠️ **語彙が小さいうちに変えること。** 手で付けた札は 1,281件／12県 あるが、
 *    使われている語は7つだけ（実測）:
 *      快走1047 / ワインディング665 / 要注意158 / 林道ぎみ85 / 絶景25 / 砂利道4 / 行き止まり1
 *    札を付けた県が増えてからでは、変換が重くなる。
 *
 * 【移行のしかた】
 * ⚠️ **知らない札はそのまま通す。** 古い配信データや手入力の自由記述が来ても
 *    落とさない。アプリ側も「知らない鍵はそのまま出す」で揃える。
 */
"use strict";

/**
 * 鍵 → 日本語の表示名。
 *
 * ⚠️ **鍵を変えないこと。** 配信データに入り、アプリが持つ対応表と揃っている必要がある。
 *    表示名の方は自由に直してよい（アプリ側は自前の訳を持つ）。
 */
const TAG_LABELS_JA = {
  scenic: "絶景",
  winding: "ワインディング",
  flowing: "快走",
  forest: "林道ぎみ",
  caution: "要注意",
  gravel: "砂利道",
  deadend: "行き止まり",
  // ⚠️ 自由記述で付けられた語を後から足したもの（神奈川で1件）。
  //    ここに無いと日本語のまま配信データに乗り、海外で日本語が読み上げられる
  toll: "有料道路",
};

/** 画面のボタンに出す順番（よく使うものから） */
const PRESET_TAGS = ["scenic", "winding", "flowing", "forest", "caution", "gravel", "deadend"];

/**
 * 日本語 → 鍵。**既存の1,281件を変換するための対応表。**
 *
 * ⚠️ ここに無い日本語（自由記述）は変換しない。そのまま残す。
 */
const JA_TO_KEY = Object.fromEntries(
  Object.entries(TAG_LABELS_JA).map(([key, label]) => [label, key]),
);

/** 鍵かどうか */
const isTagKey = (tag) => Object.prototype.hasOwnProperty.call(TAG_LABELS_JA, tag);

/**
 * 札を鍵に直す。**知らないものはそのまま返す。**
 *
 * ⚠️ 二度掛けても壊れない。鍵は `JA_TO_KEY` に載っていないので、
 *    そのまま自分自身が返る（＝変換が途中で止まったファイルに掛け直せる）。
 */
function toKey(tag) {
  if (typeof tag !== "string") return tag;
  const trimmed = tag.trim();
  return JA_TO_KEY[trimmed] || trimmed;
}

/** 札の並びを鍵に直す（重複は落とす） */
function toKeys(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const key = toKey(t);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * ルートを作るときに自動では選ばない札（鍵）。
 *
 * ⚠️ 利用者の判断（2026-10-03）:「ルート生成時に、おすすめ道路の札で林道ぎみは選択されないようにする」
 *    「砂利は選べないようにする」。実測（手元の配信データ 6,931区間）: 林道ぎみ 76区間・砂利道 1区間
 *    （八本松松井田線 91.8点）。点数の高い峠に付いている。「要注意」（219区間）は外さない
 * ⚠️ アプリの `FunRouteBuilder.autoExcludedTags` と揃えること（appFunRoute.js・funRouteSelect.js が使う）
 */
const AUTO_EXCLUDED_TAGS = new Set(["forest", "gravel"]);

/** 自動で選んでよい区間か。古い配信データの日本語の札（「林道ぎみ」「砂利道」）も鍵に直して見る */
const isAutoSelectable = (segment) =>
  !((segment && segment.tags) || []).some((t) => AUTO_EXCLUDED_TAGS.has(toKey(t)));

/** 鍵 → 日本語。知らない鍵はそのまま返す（＝自由記述はそのまま出る） */
const labelJa = (key) => TAG_LABELS_JA[key] || key;

module.exports = { TAG_LABELS_JA, PRESET_TAGS, JA_TO_KEY, isTagKey, toKey, toKeys, labelJa,
  AUTO_EXCLUDED_TAGS, isAutoSelectable };

  },
  // ---- admin/lib/appFunRoute.js ----
  "appFunRoute": function (require, module, exports) {
/**
 * appFunRoute.js
 *
 * **アプリと同じ選び方**で、おすすめ道路（楽しい道）を選ぶ（調整ツールの画面で「アプリと同じ」を選んだとき）。
 * 利用者の要望（2026-09-28）:「web でおすすめ道路などの現在のも選択できるようにしたい（web だけだとわからない）」。
 *
 * 【どこから来た処理か】
 * iOS の `FunRouteBuilder.swift`（build / buildSideVariants / buildVariants と、その下の
 * isWithinCorridor・traversal・pathLength・twoOptImprove など）と、ルート候補画面
 * （`RouteCandidatesView.loadFunRoute`）の組み合わせ方、`NavGeometry.directionAxis`、
 * `FunRoadRestrictionFilter` / `RoadRestrictionMatcher`、`NavRoutePreference.detourBudgetRatio` を移したもの。
 * **定数は向こうの値をそのまま使う。** アプリを変えたら、ここも同時に変えること。
 *
 * 【Web の従来の選び方（`funRouteSelect.js`）との違い】
 *   ・遠回りの基準  … 直線×1.6 ではなく、ふつうのルートの実際の距離（`baselineMeters`）
 *   ・進み具合      … 直線ではなく、ふつうのルートの形（`referenceAxis`＝間引いた線）で測る
 *   ・選び方        … 点数のいちばん高い道ではなく、点数の差が8以内の上位5本から**ランダム**
 *   ・曲率の下限    … 札（「絶景」など）の付いた道は 300 → 150 に緩める
 *   ・区間の出口    … 次の区間に近いところで途中で切る（最低3割は走る・500m以上縮むとき）
 *   ・本数          … 最大5本
 *   ・案            … まわり方（北・東・南・西）＋ 予算違い（たっぷり・ひかえめ）。顔ぶれが同じ案はまとめる
 *   ・規制          … 二輪通行禁止・通行止めと300m以上重なる道は候補から外す
 *
 * ⚠️ **点は `[経度, 緯度]`。** 配信データの `start` / `end` は `[緯度, 経度]`（アプリと同じ）なので入口で入れ替える。
 * ⚠️ 経路を引いたあと（Uターンを見つけた道を外して選び直す・3通りの条件で引く）はアプリと同じではない。
 *    ここが揃えるのは**どの道をどの順で通すか**まで
 * ⚠️ 2026-10-09: 好み（`taste`。選んだ道の記録から作る）での並べ方・抽選と、距離ガバの段（`BOOST_STEPS`）を
 *    アプリに追いつかせた（Web のルート作成でも使う。`public/route-maker-fun.js` はここから作る生成物）
 */
"use strict";

const { distance, project } = require("./navGeometry");
const { decode } = require("./polyline");
const { applicable } = require("./restrictionAvoid");
const { isAutoSelectable } = require("./roadTags");

// MARK: 定数（FunRouteBuilder.swift の値。⚠️ 勝手に変えないこと）

/** 軸の真上とみなす横ズレ（m）。ここより近い区間は、まわり方を持たせない */
const SIDE_NEUTRAL_METERS = 10;
/** 1回に通す区間の上限 */
const MAX_SEGMENTS = 5;
/** 「同じくらい良い」とみなす点数の幅 */
const SAME_QUALITY_SCORE_BAND = 8;
/** ランダムに選ぶ母数の上限 */
const RANDOM_POOL_SIZE = 5;
/** 自分で選ぶときの点数の下限 */
const MIN_AUTO_SCORE = 40;
const MIN_SEGMENT_LENGTH_KM = 1.0;
/** これより曲がっていない道は選ばない（度/km） */
const MIN_CURVINESS = 300;
/** 札の付いた道に許す、緩めた曲率の下限 */
const TAGGED_MIN_CURVINESS = 150;
const CORRIDOR_RATIO = 0.30;
const CORRIDOR_CAP_METERS = 25_000;
const CORRIDOR_LENGTH_FACTOR = 3.0;
const CORRIDOR_MIN_WIDTH_METERS = 5_000;
/** 「ひかえめ」の予算 */
const MODEST_DETOUR_RATIO = 1.35;
/** 「もっと寄り道」の探す幅・予算（ルート候補画面は予算違いを2案までにしているので使われない） */
const WIDE_CORRIDOR_SCALE = 2.0;
const WIDE_DETOUR_RATIO = 3.0;
/** 好みで上乗せする点数の上限。⚠️ `SAME_QUALITY_SCORE_BAND`（8）より小さく（好みだけでずっと低い道を選ばせない） */
const TASTE_BONUS_MAX = 6;
/** 抽選で好みに近い道に掛ける重み（1 ＋ これ × 好みの度合い） */
const TASTE_CHOICE_WEIGHT = 2;
/**
 * 距離ガバブーストの段（回り込む幅の倍率と遠回りの上限。`budgetRatio` が null ならつまみのとおり）。
 * ⚠️ 幅と上限を一緒に上げる（幅だけでは上限3倍で頭打ち。`FunRouteBuilder.boostSteps`）
 */
const BOOST_STEPS = [
  { corridorScale: 2, budgetRatio: null },
  { corridorScale: 3, budgetRatio: 4.0 },
  { corridorScale: 5, budgetRatio: 5.0 },
];
/** いまの幅で何段まで進めたか（0〜段の数） */
const boostLevel = (corridor) => BOOST_STEPS.filter((s) => s.corridorScale <= corridor).length;
/** いまの幅の次の段（もう無ければ null） */
const nextBoost = (corridor) => BOOST_STEPS.find((s) => s.corridorScale > corridor) || null;

/** 「別ルート」とみなす重なりの上限 */
const MAX_VARIANT_OVERLAP = 0.5;
const MAX_BACKWARD_EXCURSION_METERS = 1_000;
/** 区間を途中で切るとき、最低これだけの割合は走る */
const MIN_CUT_FRACTION = 0.3;
/** 途中で切って縮む距離がこれ未満なら公式の端点のまま */
const MIN_CUT_SAVINGS_METERS = 500;
/** 直線を道のりに直す係数 */
const CIRCUITY_FACTOR = 1.6;
/** 区間の沿線距離を信じてよい、道からの離れ（m） */
const ON_ROAD_LATERAL_THRESHOLD_METERS = 2_000;
/** 後退1mあたりの罰 */
const BACKWARD_PENALTY_WEIGHT = 1.0;

// NavRoutePreference.swift
/** これ未満のつまみは「楽しい道なし」 */
const MIN_FUN_WEIGHT = 0.01;
/** つまみを入れたときの最小の寄り道（+10%） */
const MIN_DETOUR_RATIO = 1.1;
/** つまみ全開の寄り道 */
const MAX_DETOUR_RATIO = 3.0;

// RoadRestrictionMatcher（RoadRestriction.swift）
const MATCH_TOLERANCE_METERS = 40;
const MIN_OVERLAP_METERS = 300;

// NavGeometry.directionAxis
const AXIS_MAX_POINTS = 400;
const AXIS_MIN_SPACING_METERS = 250;

/** まわり方（`FunRouteBuilder.Side`。⚠️ 並びは Side.allCases と同じ） */
const SIDES = { north: 0, east: 90, south: 180, west: 270 };
const SIDE_ORDER = ["north", "east", "south", "west"];

// MARK: 幾何

const rad = (d) => (d * Math.PI) / 180;

/** a から b への方位（度・0=北・時計回り）。`NavGeometry.bearing` */
function bearing(a, b) {
  const lat1 = rad(a[1]), lat2 = rad(b[1]);
  const dLon = rad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * 経路の形を、進み具合を測る基準に間引く（`NavGeometry.directionAxis`）。
 * ⚠️ 実ルートの点をそのまま使うと区間選びの射影回数がその点数ぶん増える
 */
function directionAxis(polyline, maxPoints = AXIS_MAX_POINTS, minSpacingMeters = AXIS_MIN_SPACING_METERS) {
  if (!(polyline.length > maxPoints)) return polyline;
  let total = 0;
  for (let i = 1; i < polyline.length; i++) total += distance(polyline[i - 1], polyline[i]);
  const spacing = Math.max(minSpacingMeters, total / maxPoints);
  const out = [polyline[0]];
  let accumulated = 0;
  for (let i = 1; i < polyline.length - 1; i++) {
    accumulated += distance(polyline[i - 1], polyline[i]);
    if (accumulated >= spacing) {
      out.push(polyline[i]);
      accumulated = 0;
    }
  }
  out.push(polyline[polyline.length - 1]);
  return out;
}

/** 配信データの `[緯度, 経度]` → `[経度, 緯度]` */
function coordinate(pair) {
  return Array.isArray(pair) && pair.length === 2 ? [pair[1], pair[0]] : null;
}

function midpoint(seg) {
  const s = coordinate(seg.start), e = coordinate(seg.end);
  if (!s || !e) return null;
  return [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2];
}

// ⚠️ 同じ計算を何万回も繰り返さないための控え（アプリと同じ理由。区間選びは traversal を何万回も呼ぶ）
const decoded = new Map();
const lengths = new Map();
const axisCache = new WeakMap();

/** 区間のポリライン（復号は1度だけ） */
function polylineOf(seg) {
  if (!seg.polyline) return [];
  let hit = decoded.get(seg.polyline);
  if (!hit) {
    if (decoded.size > 5_000) decoded.clear();
    hit = decode(seg.polyline);
    decoded.set(seg.polyline, hit);
  }
  return hit;
}

function polylineLength(seg, points) {
  let hit = lengths.get(seg.polyline);
  if (hit === undefined) {
    hit = 0;
    for (let i = 1; i < points.length; i++) hit += distance(points[i - 1], points[i]);
    if (lengths.size > 5_000) lengths.clear();
    lengths.set(seg.polyline, hit);
  }
  return hit;
}

function axisEntry(axis) {
  let e = axisCache.get(axis);
  if (!e) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of axis) {
      minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
      minLon = Math.min(minLon, p[0]); maxLon = Math.max(maxLon, p[0]);
    }
    e = { bounds: { minLat, maxLat, minLon, maxLon }, along: new Map() };
    axisCache.set(axis, e);
  }
  return e;
}

/** 基準軸の上の沿線位置（同じ点・同じ軸なら1度だけ） */
function alongOnAxis(point, axis) {
  if (!(axis.length >= 2)) return 0;
  const cache = axisEntry(axis).along;
  const key = `${point[0]},${point[1]}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    const proj = project(point, axis);
    hit = proj ? proj.along : 0;
    cache.set(key, hit);
  }
  return hit;
}

/** 点が軸の外接矩形から `meters` 以内か（射影の前の足切り） */
function isNearAxisBounds(point, axis, meters) {
  if (!(axis.length >= 2)) return true;
  const b = axisEntry(axis).bounds;
  const latMargin = meters / 111_320;
  const lonScale = Math.max(Math.cos(rad(point[1])), 0.01);
  const lonMargin = meters / (111_320 * lonScale);
  return point[1] >= b.minLat - latMargin && point[1] <= b.maxLat + latMargin
    && point[0] >= b.minLon - lonMargin && point[0] <= b.maxLon + lonMargin;
}

// MARK: 候補

/** 直線（または基準軸）から極端に外れていないか。曲率の下限もここで見る */
function isWithinCorridor(seg, origin, destination, directDistance, referenceAxis, corridorScale = 1) {
  if (!(seg.lengthKm >= MIN_SEGMENT_LENGTH_KM)) return false;
  // ⚠️ **札の付いた道は緩める。** 海沿いの快走路のように、曲がっていないが走って気持ちのよい道がある
  const hasTag = Array.isArray(seg.tags) && seg.tags.length > 0;
  if (!((seg.curviness || 0) >= (hasTag ? TAGGED_MIN_CURVINESS : MIN_CURVINESS))) return false;
  const mid = midpoint(seg);
  if (!mid) return false;
  const axis = referenceAxis || [origin, destination];
  const scale = Math.max(1, corridorScale);
  const allowed = Math.min(
    Math.min(directDistance * CORRIDOR_RATIO, CORRIDOR_CAP_METERS),
    Math.max(CORRIDOR_MIN_WIDTH_METERS, CORRIDOR_LENGTH_FACTOR * seg.lengthKm * 1000),
  ) * scale;
  if (!isNearAxisBounds(mid, axis, allowed)) return false;
  const proj = project(mid, axis);
  return !!proj && proj.lateralDistance <= allowed;
}

/** 区間が軸のどちら向きに膨らんでいるか（度）。軸の真上なら null */
function sideBearing(seg, origin, destination, referenceAxis) {
  const mid = midpoint(seg);
  if (!mid) return null;
  const proj = project(mid, referenceAxis || [origin, destination]);
  if (!proj || proj.lateralDistance < SIDE_NEUTRAL_METERS) return null;
  return bearing(proj.point, mid);
}

/** その膨らみが指定した方角の側か（半平面） */
const matchesSide = (side, b) => Math.abs(angleDelta(SIDES[side], b)) < 90;

/** 区間を、基準軸の上の進み具合で並べる */
function orderedByProgress(segments, origin, destination, referenceAxis) {
  const line = referenceAxis || [origin, destination];
  return segments
    .map((seg) => { const mid = midpoint(seg); return mid ? [seg, alongOnAxis(mid, line)] : null; })
    .filter(Boolean)
    .sort((a, b) => a[1] - b[1])
    .map((x) => x[0]);
}

function nextTarget(index, segments, destination) {
  const next = segments[index + 1];
  const mid = next && midpoint(next);
  return mid || destination;
}

/**
 * 区間をどちら向きに走るかを決めて、入口・出口を返す（`FunRouteBuilder.traversal`）。
 * 入口までの近さ＋出口から次の目標まで＋後退の罰で選び、次の目標に近いところで途中で切ることがある
 */
function traversal(seg, origin, target, tripOrigin, tripDestination, referenceAxis) {
  const start = coordinate(seg.start), end = coordinate(seg.end);
  if (!start || !end) return null;
  const points = polylineOf(seg);
  const hasPolyline = points.length >= 2;
  const totalLength = hasPolyline ? polylineLength(seg, points) : seg.lengthKm * 1000;

  let approachToStart, approachToEnd;
  const onRoad = hasPolyline ? project(origin, points) : null;
  if (onRoad && onRoad.lateralDistance <= ON_ROAD_LATERAL_THRESHOLD_METERS) {
    approachToStart = onRoad.along;
    approachToEnd = totalLength - onRoad.along;
  } else {
    approachToStart = distance(origin, start);
    approachToEnd = distance(origin, end);
  }

  const routeAxis = referenceAxis || [tripOrigin, tripDestination];
  const cursorAlong = alongOnAxis(origin, routeAxis);
  const startAlong = alongOnAxis(start, routeAxis);
  const endAlong = alongOnAxis(end, routeAxis);
  const viaStartBackward = Math.max(0, cursorAlong - startAlong) + Math.max(0, startAlong - endAlong);
  const viaEndBackward = Math.max(0, cursorAlong - endAlong) + Math.max(0, endAlong - startAlong);
  const viaStart = approachToStart + distance(end, target) + viaStartBackward * BACKWARD_PENALTY_WEIGHT;
  const viaEnd = approachToEnd + distance(start, target) + viaEndBackward * BACKWARD_PENALTY_WEIGHT;

  const entersAtStart = viaStart <= viaEnd;
  const entry = entersAtStart ? start : end;
  const officialExit = entersAtStart ? end : start;
  const officialExitCost = distance(officialExit, target);
  let exit = officialExit;
  let traversedMeters = seg.lengthKm * 1000;

  if (hasPolyline) {
    const cut = project(target, points);
    if (cut) {
      const cutAlongFromEntry = entersAtStart ? cut.along : totalLength - cut.along;
      const farEnough = cutAlongFromEntry >= totalLength * MIN_CUT_FRACTION && cutAlongFromEntry < totalLength;
      const savesEnough = officialExitCost - cut.lateralDistance >= MIN_CUT_SAVINGS_METERS;
      if (farEnough && savesEnough) {
        exit = cut.point;
        traversedMeters = cutAlongFromEntry;
      }
    }
  }
  return { entry, exit, traversedMeters };
}

/** 出発地 → 各区間（入口→出口）→ 目的地 のおおよその距離（区間の間は直線×1.6） */
function pathLength(segments, origin, destination, referenceAxis) {
  let total = 0;
  let cursor = origin;
  segments.forEach((seg, i) => {
    const t = traversal(seg, cursor, nextTarget(i, segments, destination), origin, destination, referenceAxis);
    if (!t) return;
    total += distance(cursor, t.entry) * CIRCUITY_FACTOR;
    total += t.traversedMeters;
    cursor = t.exit;
  });
  return total + distance(cursor, destination) * CIRCUITY_FACTOR;
}

/** 並べた区間を経由地（入口・出口の組）にする。⚠️ 直前の区間の出口を引き回す */
function waypointsFor(ordered, origin, destination, referenceAxis) {
  const out = [];
  let cursor = origin;
  ordered.forEach((seg, i) => {
    const t = traversal(seg, cursor, nextTarget(i, ordered, destination), origin, destination, referenceAxis);
    if (!t) return;
    out.push(t.entry, t.exit);
    cursor = t.exit;
  });
  return out;
}

/** 2-opt で並びを改善する（1m 未満の改善は揺れとして無視） */
function twoOptImprove(segments, origin, destination, referenceAxis) {
  if (segments.length < 3) return segments;
  let best = segments;
  let bestLength = pathLength(best, origin, destination, referenceAxis);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const len = pathLength(candidate, origin, destination, referenceAxis);
        if (len < bestLength - 1) {
          best = candidate;
          bestLength = len;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** 経由地にしたとき、軸の上でいちばん大きく後退する幅（m） */
function worstBackwardExcursion(segments, origin, destination, referenceAxis) {
  const wps = waypointsFor(segments, origin, destination, referenceAxis);
  if (!wps.length) return 0;
  const axis = referenceAxis || [origin, destination];
  const track = [origin, ...wps, destination];
  const alongs = track.map((p) => { const pr = project(p, axis); return pr ? pr.along : null; });
  if (alongs.some((a) => a === null)) return 0;
  let worst = 0;
  for (let i = 1; i < alongs.length; i++) worst = Math.min(worst, alongs[i] - alongs[i - 1]);
  return -worst;
}

/** つまみ（0〜1）→ 寄り道の倍率（`NavRoutePreference.detourBudgetRatio`）。入れていなければ 1.0 */
function detourBudgetRatio(funWeight) {
  if (!(funWeight >= MIN_FUN_WEIGHT)) return 1.0;
  const t = Math.max(0, Math.min(1, funWeight));
  return MIN_DETOUR_RATIO + (MAX_DETOUR_RATIO - MIN_DETOUR_RATIO) * t;
}

/** 同じくらい良い道からランダムに1本（好みが無いときのアプリの既定） */
const randomChoice = (pool) => (pool.length ? pool[Math.floor(Math.random() * pool.length)] : null);

/**
 * 好みで重みを付けたランダム（`FunRouteBuilder.tasteWeightedChoice`）。好みが無ければふつうのランダム。
 * 好みにぴったりの道は3倍当たりやすい
 */
function tasteWeightedChoice(pool, taste, random = Math.random) {
  if (!taste || !pool.length) return pool.length ? pool[Math.floor(random() * pool.length)] : null;
  const weights = pool.map((s) => 1 + TASTE_CHOICE_WEIGHT * Math.max(0, Math.min(1, taste(s))));
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    if (r < weights[i]) return pool[i];
    r -= weights[i];
  }
  return pool[pool.length - 1];
}
/** 点数のいちばん高い道（毎回同じになる。見比べるとき用） */
const topChoice = (pool) => pool[0] || null;

const lineupOf = (segments) => segments.map((s) => s.id).sort().join("|");
const sameSegments = (a, b) => a.segments.length === b.segments.length
  && a.segments.every((s, i) => s.id === b.segments[i].id);

/**
 * 楽しい区間を選んで経由地にする（`FunRouteBuilder.build`）。1本も選べなければ null
 *
 * @param o.funWeight つまみ（0〜1）。予算は `budgetRatio` を渡さなければこれから
 * @param o.baselineMeters ふつうのルートの距離。無ければ直線×1.6
 * @param o.referenceAxis 進み具合を測る形（`directionAxis` で間引いたもの）。無ければ直線
 * @param o.choose 同じくらい良い道から1本選ぶ関数（既定は好みで重みを付けたランダム）
 * @param o.taste 好みにどれだけ近いか（区間 → 0〜1）。渡さなければ好みを使わない
 */
function build(o) {
  const { origin, destination, segments } = o;
  if (!(o.funWeight >= MIN_FUN_WEIGHT)) return null;
  const directDistance = distance(origin, destination);
  if (!(directDistance > 0)) return null;
  const axis = o.referenceAxis || null;
  const baseline = o.baselineMeters ?? directDistance * CIRCUITY_FACTOR;
  const budget = baseline * (o.budgetRatio ?? detourBudgetRatio(o.funWeight));
  const excluding = o.excluding || new Set();
  const corridorScale = o.corridorScale ?? 1;
  const taste = typeof o.taste === "function" ? o.taste : null;
  const choose = o.choose || ((pool) => tasteWeightedChoice(pool, taste));
  // ⚠️ 好みは**上乗せ**で並べる（最大 TASTE_BONUS_MAX 点）。同じくらい良い道の中で好みに近い道を先に集める
  const ranked = (s) => s.score + TASTE_BONUS_MAX * (taste ? taste(s) : 0);

  // ⚠️ 林道ぎみ・砂利道（roadTags.js の AUTO_EXCLUDED_TAGS）は自動では選ばない。アプリの FunRouteBuilder と同じ
  const inCorridor = segments.filter((s) => s.score >= MIN_AUTO_SCORE && isAutoSelectable(s) && !excluding.has(s.id)
    && isWithinCorridor(s, origin, destination, directDistance, axis, corridorScale));
  if (!inCorridor.length) return null;
  let candidates = inCorridor;
  if (o.side) {
    // ⚠️ コリドーを通したあとに掛ける。軸の真上の区間はどちらにも入れない
    candidates = inCorridor.filter((s) => {
      const b = sideBearing(s, origin, destination, axis);
      return b !== null && matchesSide(o.side, b);
    });
    if (!candidates.length) return null;
  }

  // ⚠️ 道の良さ（点数）で選び、距離は予算に収まるかだけに使う
  const byScore = candidates.slice().sort((a, b) => ranked(b) - ranked(a));
  const chosen = [];
  const limit = Math.max(1, Math.min(o.maxSegmentCount ?? MAX_SEGMENTS, MAX_SEGMENTS));
  while (chosen.length < limit) {
    // ⚠️ いちばん良い1本に決め打ちしない。同じくらい良い道を数本集めて、その中から選ぶ
    const pool = [];
    let bestScore = null;
    for (const candidate of byScore) {
      if (chosen.some((s) => s.id === candidate.id)) continue;
      if (bestScore !== null && bestScore - ranked(candidate) > SAME_QUALITY_SCORE_BAND) break;
      const trial = orderedByProgress(chosen.concat([candidate]), origin, destination, axis);
      const length = pathLength(trial, origin, destination, axis);
      if (!(length <= budget)) continue;
      if (bestScore === null) bestScore = ranked(candidate);
      pool.push(candidate);
      if (pool.length >= RANDOM_POOL_SIZE) break;
    }
    const picked = choose(pool);
    if (!picked || !pool.some((s) => s.id === picked.id)) break;
    chosen.push(picked);
  }
  if (!chosen.length) return null;

  const recipe = { budgetRatio: o.budgetRatio ?? null, corridorScale: Math.max(1, corridorScale), side: o.side || null };
  // ⚠️ 並べ替えても大きく後退するなら「Uターンでしか組み込めない」とみなし、点数の低い区間から諦める
  let remaining = chosen.slice();
  const uTurnOnly = [];
  while (remaining.length) {
    const ordered = twoOptImprove(orderedByProgress(remaining, origin, destination, axis), origin, destination, axis);
    const waypoints = waypointsFor(ordered, origin, destination, axis);
    if (!waypoints.length) return null;
    if (worstBackwardExcursion(ordered, origin, destination, axis) <= MAX_BACKWARD_EXCURSION_METERS) {
      return {
        waypoints, segments: ordered,
        detourRatio: pathLength(ordered, origin, destination, axis) / baseline,
        baselineMeters: baseline,
        kind: o.kind || "generous", recipe, sides: o.side ? [o.side] : [], uTurnOnly,
      };
    }
    const weakest = remaining.reduce((a, b) => (a.score <= b.score ? a : b));
    uTurnOnly.push(weakest);
    remaining = remaining.filter((s) => s.id !== weakest.id);
  }
  return null;
}

/** まわり方（北・東・南・西）ごとに作る。顔ぶれが同じ方角はまとめる（`buildSideVariants`） */
function buildSideVariants(o) {
  const results = [];
  const byLineup = new Map();
  for (const side of SIDE_ORDER) {
    const pick = build({ ...o, side, kind: "generous" });
    if (!pick) continue;
    const lineup = lineupOf(pick.segments);
    if (byLineup.has(lineup)) { results[byLineup.get(lineup)].sides.push(side); continue; }
    byLineup.set(lineup, results.length);
    results.push(pick);
  }
  return results;
}

/** 予算違い（たっぷり・ひかえめ・別ルート・もっと寄り道）を作る（`buildVariants`） */
function buildVariants(o) {
  const maxVariants = o.maxVariants ?? 3;
  const generous = build({ ...o, kind: "generous" });
  if (!generous) return [];
  const variants = [generous];
  if (maxVariants < 2) return variants;
  // ⚠️ 全部の案で同じ予算・同じ幅を使う
  const effectiveBudget = o.budgetRatio ?? detourBudgetRatio(o.funWeight);
  const effectiveCorridor = Math.max(1, o.corridorScale ?? 1);
  const modest = build({ ...o, budgetRatio: Math.min(MODEST_DETOUR_RATIO, effectiveBudget),
                         corridorScale: effectiveCorridor, kind: "modest" });
  if (modest && !sameSegments(modest, generous)) variants.push(modest);
  if (maxVariants < 3) return variants;

  const top = new Set(generous.segments.slice().sort((a, b) => b.score - a.score).slice(0, 2).map((s) => s.id));
  const alternate = build({ ...o, budgetRatio: effectiveBudget, excluding: top,
                            corridorScale: effectiveCorridor, kind: "alternate" });
  if (alternate && !variants.some((v) => sameSegments(v, alternate))
      && variants.every((v) => overlapRatio(v.segments, alternate.segments) < MAX_VARIANT_OVERLAP)) {
    variants.push(alternate);
  }
  if (variants.length < maxVariants) {
    const wide = build({ ...o, budgetRatio: Math.max(WIDE_DETOUR_RATIO, effectiveBudget),
                         corridorScale: Math.max(WIDE_CORRIDOR_SCALE, effectiveCorridor), kind: "wide" });
    if (wide && !variants.some((v) => sameSegments(v, wide))
        && wide.segments.some((c) => !variants.some((v) => v.segments.some((s) => s.id === c.id)))) {
      variants.push(wide);
    }
  }
  return variants;
}

function overlapRatio(a, b) {
  const A = new Set(a.map((s) => s.id)), B = new Set(b.map((s) => s.id));
  const union = new Set([...A, ...B]);
  if (!union.size) return 0;
  let both = 0;
  for (const id of A) if (B.has(id)) both++;
  return both / union.size;
}

// MARK: 規制と重なる道を外す（FunRoadRestrictionFilter / RoadRestrictionMatcher）

function distanceToSegment(p, a, b) {
  const scale = Math.cos(rad(p[1]));
  const px = (p[0] - a[0]) * scale * 111_320, py = (p[1] - a[1]) * 111_320;
  const ex = (b[0] - a[0]) * scale * 111_320, ey = (b[1] - a[1]) * 111_320;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return Math.sqrt(px * px + py * py);
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / len2));
  return Math.hypot(px - t * ex, py - t * ey);
}

function roughDistance(a, b) {
  const dLat = (a[1] - b[1]) * 111_320;
  const dLng = (a[0] - b[0]) * 111_320 * Math.cos(rad(a[1]));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** 区間のうち、規制の線に沿って走っている長さ（いちばん長いひと続き） */
function overlapMeters(route, target) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of target) {
    minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
    minLng = Math.min(minLng, p[0]); maxLng = Math.max(maxLng, p[0]);
  }
  const inBox = (p) => {
    const dLat = MATCH_TOLERANCE_METERS / 111_320;
    const dLng = MATCH_TOLERANCE_METERS / (111_320 * Math.cos(rad(p[1])));
    return p[1] >= minLat - dLat && p[1] <= maxLat + dLat && p[0] >= minLng - dLng && p[0] <= maxLng + dLng;
  };
  const near = (p) => {
    let best = Infinity;
    for (let i = 1; i < target.length; i++) {
      best = Math.min(best, distanceToSegment(p, target[i - 1], target[i]));
      if (best < 1) break;
    }
    return best <= MATCH_TOLERANCE_METERS;
  };
  let best = 0, run = 0, running = false;
  for (let i = 0; i < route.length; i++) {
    if (inBox(route[i]) && near(route[i])) {
      // ⚠️ アプリと同じく、入った1辺（直前の点から）も数える
      if (i > 0) run += roughDistance(route[i - 1], route[i]);
      running = true;
    } else {
      if (running) best = Math.max(best, run);
      running = false;
      run = 0;
    }
  }
  if (running) best = Math.max(best, run);
  return best;
}

/**
 * 候補から外す区間か（二輪通行禁止・通行止めと300m以上重なる）。
 * ⚠️ 走る日時が分からないときは時間を見ずに避ける（避けすぎ側。アプリと同じ）
 */
function isBlockedByRestrictions(points, restrictions, displacement, at) {
  if (!(points.length >= 2)) return false;
  const target = applicable(restrictions, { displacement, at });
  return target.some((r) => overlapMeters(points, r.points) >= MIN_OVERLAP_METERS);
}

// MARK: ルート候補画面の組み合わせ（RouteCandidatesView.loadFunRoute）

/**
 * ルート候補画面と同じ組み合わせで案を作る: まわり方（北・東・南・西）を先に、
 * 予算違いは2案まで（たっぷり・ひかえめ）。顔ぶれが同じ案は出さない。
 *
 * @param o.referencePolyline ふつうのルートの線（`[経度, 緯度]` の並び）。間引いて基準軸にする
 * @param o.restrictions 規制（`data/road-restrictions` の形）。渡さなければ外さない
 */
function appFunVariants(o) {
  const all = o.segments || [];
  const usable = (o.restrictions && o.restrictions.length)
    ? all.filter((s) => !isBlockedByRestrictions(polylineOf(s), o.restrictions, o.displacement, o.at))
    : all;
  const referenceAxis = Array.isArray(o.referencePolyline) && o.referencePolyline.length >= 2
    ? directionAxis(o.referencePolyline) : null;
  const common = { origin: o.origin, destination: o.destination, segments: usable, funWeight: o.funWeight,
                   baselineMeters: o.baselineMeters, referenceAxis, choose: o.choose, taste: o.taste,
                   maxSegmentCount: o.maxSegmentCount ?? MAX_SEGMENTS };
  const sideVariants = buildSideVariants(common);
  const budgetVariants = buildVariants({ ...common, maxVariants: 2 });
  const seen = new Set(sideVariants.map((v) => lineupOf(v.segments)));
  const variants = sideVariants.slice();
  for (const v of budgetVariants) {
    const lineup = lineupOf(v.segments);
    if (seen.has(lineup)) continue;
    seen.add(lineup);
    variants.push(v);
  }
  // ⚠️ `common` も返す。往復を見つけた道を外して選び直すとき、同じ条件（基準・軸・つまみ）で作り直すため
  return { variants, usableCount: usable.length, blockedCount: all.length - usable.length, referenceAxis, common };
}

module.exports = {
  appFunVariants, build, buildSideVariants, buildVariants, detourBudgetRatio, directionAxis,
  isWithinCorridor, sideBearing, orderedByProgress, traversal, pathLength, waypointsFor, twoOptImprove,
  worstBackwardExcursion, isBlockedByRestrictions, overlapMeters, randomChoice, topChoice, polylineOf,
  tasteWeightedChoice, boostLevel, nextBoost, BOOST_STEPS, TASTE_BONUS_MAX, TASTE_CHOICE_WEIGHT,
  MAX_SEGMENTS, SAME_QUALITY_SCORE_BAND, RANDOM_POOL_SIZE, MIN_AUTO_SCORE, MIN_CURVINESS, TAGGED_MIN_CURVINESS,
  MODEST_DETOUR_RATIO, MIN_DETOUR_RATIO, MAX_DETOUR_RATIO, MIN_FUN_WEIGHT, CIRCUITY_FACTOR,
  MIN_CUT_FRACTION, MIN_CUT_SAVINGS_METERS, MATCH_TOLERANCE_METERS, MIN_OVERLAP_METERS, SIDE_ORDER,
};

  },
  // ---- admin/lib/roadFeedback.js ----
  "roadFeedback": function (require, module, exports) {
"use strict";

/**
 * 走った道の感想（アプリの RoadFeedback.swift が road_feedback に書く）を、道ごとにまとめる。
 *
 * ⚠️ 利用者の判断（2026-10-08）: 走ったおすすめ道路の評価と札を夜の通知で聞き、**まず調整ツールだけ**に出す。
 *    札は開発者が見て採用する（自動で配信に流さない。road_reviews と同じ考え方）。
 * ⚠️ **誰が書いたかは出さない。** uid は「何人が答えたか」を数えるのに使うだけ
 * ⚠️ 道の鍵は調整ツールの `reviewKey`（`/` を `_` に置き換えた道のまとめキー）と同じ形にする。
 *    ずれると声が1件も当たらない（黙って空になるだけで気付けない）
 */

const VERDICTS = ["good", "ok", "bad"];
const TAGS = ["scenic", "winding", "flowing", "forest"];
const CAUTIONS = ["rough", "narrow", "traffic", "gravel"];
const CAUTION_LABELS = { rough: "路面が荒い", narrow: "狭い", traffic: "交通量が多い", gravel: "砂利" };

/** 道のまとめキーを調整ツールの鍵の形にする（`/` → `_`） */
function keyOf(roadID) {
  return String(roadID || "").replace(/\//g, "_");
}

function toIso(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return null;
}

/**
 * 道ごとの声。{ 鍵: { roadName, good, ok, bad, total, tags:{鍵:人数}, cautions:{鍵:人数}, notes:[{text, at}], lastAt } }
 * ⚠️ 形の崩れた文書（判定が無い・道の鍵が無い）は数えない
 */
function summarizeFeedback(docs, { maxNotes = 5 } = {}) {
  const out = {};
  for (const d of docs || []) {
    if (!d || !d.roadID || !VERDICTS.includes(d.verdict)) continue;
    const k = keyOf(d.roadID);
    const s = out[k] || (out[k] = {
      roadName: d.roadName || "", good: 0, ok: 0, bad: 0, total: 0, tags: {}, cautions: {}, notes: [], lastAt: null,
    });
    s[d.verdict] += 1;
    s.total += 1;
    for (const t of Array.isArray(d.tags) ? d.tags : []) if (TAGS.includes(t)) s.tags[t] = (s.tags[t] || 0) + 1;
    for (const c of Array.isArray(d.cautions) ? d.cautions : []) {
      if (CAUTIONS.includes(c)) s.cautions[c] = (s.cautions[c] || 0) + 1;
    }
    const at = toIso(d.updatedAt) || toIso(d.rodeAt);
    const note = typeof d.note === "string" ? d.note.trim() : "";
    if (note) s.notes.push({ text: note.slice(0, 200), at });
    if (at && (!s.lastAt || at > s.lastAt)) s.lastAt = at;
  }
  for (const s of Object.values(out)) {
    s.notes.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    s.notes = s.notes.slice(0, maxNotes);
  }
  return out;
}

/** 答えてもらえた数（/riders 用）。回答数・答えた人の数・道の数 */
function countFeedback(docs) {
  const valid = (docs || []).filter((d) => d && d.roadID && VERDICTS.includes(d.verdict));
  return {
    answers: valid.length,
    riders: new Set(valid.map((d) => d.uid).filter(Boolean)).size,
    roads: new Set(valid.map((d) => keyOf(d.roadID))).size,
  };
}

module.exports = { summarizeFeedback, countFeedback, keyOf, VERDICTS, TAGS, CAUTIONS, CAUTION_LABELS };

  },
  // ---- admin/lib/riderInsights.js ----
  "riderInsights": function (require, module, exports) {
"use strict";
const { countFeedback } = require("./roadFeedback");

/**
 * 利用者の好みと行き先（開発者だけが見る画面 /riders の中身）。
 *
 * ⚠️ 利用者の要望（2026-10-07）:「投稿したスポット/スポットの札などもユーザーへおすすめスポット/道路を
 *    提供できるように解析したい」。判断: **解析はアプリ側でその人の分だけ**（`RiderSignals.swift`）。
 *    「全員の確認は web の開発者オンリーの view で確認し、マッピングや視覚的にユーザーがどんな場所に
 *    よく行くか確認できるようにしたい。今後の開発などに活かせるものにしたい」→ この画面
 * ⚠️ **好みの決め方はアプリと同じにする**（重み・特徴の作り方）。アプリを変えたらここも変える
 *    （`RiderSignals.swift` の `sourceWeight`・`RiderChoices.roadFeatures/spotFeatures`）
 * ⚠️ **誰かは出さない。** uid・名前・メールは返さず、活動の多い順の番号（利用者 #1…）で出す
 */

const { toKey } = require("./roadTags");

/** 材料ごとの重み（アプリの `RiderSignals.sourceWeight` と同じ。選んだ記録は回数をそのまま使う） */
const SOURCE_WEIGHT = { post: 1.0, plan: 1.0, review: 0.8, like: 0.6 };
/** 同じ重みのときにどの材料を理由にするか（前ほど優先） */
const SOURCE_ORDER = ["choice", "post", "plan", "review", "like"];
/** 口コミは ★4 以上だけ好みに使う（低い評価は好みではない） */
const REVIEW_MIN = 4;
/** 地図の集計の升目（度）。0.1度 ≒ 緯度で11km */
const GRID_DEG = 0.1;

const curvinessBand = (c) => (c >= 600 ? "curvy:high" : c >= 300 ? "curvy:mid" : "curvy:low");

/** 道の特徴（アプリの `RiderChoices.roadFeatures` と同じ） */
function roadFeatures(tags, highway, curviness) {
  const out = new Set((tags || []).map((t) => "tag:" + toKey(t)));
  if (highway) out.add("hw:" + highway);
  out.add(curvinessBand(curviness || 0));
  return [...out].sort();
}

/** スポットの特徴（アプリの `RiderChoices.spotFeatures` と同じ） */
function spotFeatures(points, tags) {
  return [...new Set([...(points || []).map((p) => "pt:" + p), ...(tags || []).filter((t) => t).map((t) => "genre:" + t)])].sort();
}

/**
 * 材料（{kind, key, features, weight, source}）から好みを作る。
 * ⚠️ 同じもの（kind と key が同じ）は重みのいちばん大きい材料だけを使う（投稿してプランにも入れた
 *    スポットを2回数えない）
 * @returns {{spots: object, roads: object, spotSources: object, roadSources: object}}
 *   特徴 → 重み（0...1）と、特徴 → いちばん効いた材料
 */
function tasteFromEvidence(evidence) {
  const best = new Map();
  for (const e of evidence) {
    if (!e || !e.key || !(e.weight > 0)) continue;
    const id = e.kind + "\u0000" + e.key;
    const prev = best.get(id);
    const better = !prev || e.weight > prev.weight ||
      (e.weight === prev.weight && SOURCE_ORDER.indexOf(e.source) < SOURCE_ORDER.indexOf(prev.source));
    if (better) best.set(id, e);
  }
  const make = (kind) => {
    const items = [...best.values()].filter((e) => e.kind === kind);
    const total = items.reduce((s, e) => s + e.weight, 0);
    const weights = {}, bySource = {};
    for (const e of items) {
      for (const f of new Set(e.features || [])) {
        weights[f] = (weights[f] || 0) + e.weight;
        bySource[f] = bySource[f] || {};
        bySource[f][e.source] = (bySource[f][e.source] || 0) + e.weight;
      }
    }
    const sources = {};
    for (const f of Object.keys(weights)) {
      weights[f] = total > 0 ? weights[f] / total : 0;
      sources[f] = Object.entries(bySource[f])
        .sort((a, b) => b[1] - a[1] || SOURCE_ORDER.indexOf(a[0]) - SOURCE_ORDER.indexOf(b[0]))[0][0];
    }
    return { weights, sources };
  };
  const spots = make("spot"), roads = make("road");
  return { spots: spots.weights, roads: roads.weights, spotSources: spots.sources, roadSources: roads.sources };
}

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 全員の材料から、画面に出すものを作る。
 * @param {object} data
 *   posts:   [{id, userID, lat, lng, tag, points, road:{name,ref,highway}}]（投稿）
 *   likes:   [{userID, spotID}]（スポット配下のいいね）
 *   reviews: [{userID, spotID, rating}]（口コミ）
 *   plans:   [{userID, spots:[{spotId, lat, lng, isRoad, roadID}]}]（プラン）
 *   tastes:  [{userID, roads:{..}, spots:{..}}]（選んだ記録 user_taste）
 * @param {(lng:number, lat:number) => string|null} locate 県を引く
 */
function buildInsights(data, locate = () => null) {
  const posts = data.posts || [];
  const postById = new Map(posts.map((p) => [p.id, p]));
  const people = new Map();
  const person = (uid) => {
    if (!people.has(uid)) {
      people.set(uid, { evidence: [], points: [], counts: { post: 0, like: 0, review: 0, plan: 0, choice: 0 } });
    }
    return people.get(uid);
  };
  const addPoint = (p, lat, lng, source) => {
    const la = num(lat), ln = num(lng);
    if (la == null || ln == null) return;
    p.points.push({ lat: la, lng: ln, source });
  };
  const spotEvidence = (post, source, weight) => ({
    kind: "spot", key: post.id, source, weight,
    features: spotFeatures(post.points, post.tag),
  });

  for (const post of posts) {
    if (!post.userID) continue;
    const p = person(post.userID);
    p.counts.post++;
    p.evidence.push(spotEvidence(post, "post", SOURCE_WEIGHT.post));
    // 投稿の「近くの道」は道の好みにも使う。⚠️ ここでは道の種類だけ（アプリは配信データから道を引き当てて
    //    札・曲がり具合まで使う。全員分を引き当てると重いので、この画面では省いている）
    if (post.road && post.road.name) {
      const highway = post.road.highway || "";
      p.evidence.push({ kind: "road", key: `post:${post.id}`, source: "post", weight: SOURCE_WEIGHT.post,
                        features: highway ? ["hw:" + highway] : [] });
    }
    addPoint(p, post.lat, post.lng, "post");
  }
  for (const like of data.likes || []) {
    const post = postById.get(like.spotID);
    if (!like.userID || !post) continue;
    const p = person(like.userID);
    p.counts.like++;
    p.evidence.push(spotEvidence(post, "like", SOURCE_WEIGHT.like));
    addPoint(p, post.lat, post.lng, "like");
  }
  for (const review of data.reviews || []) {
    const post = postById.get(review.spotID);
    if (!review.userID || !post) continue;
    const p = person(review.userID);
    p.counts.review++;
    if ((review.rating || 0) >= REVIEW_MIN) p.evidence.push(spotEvidence(post, "review", SOURCE_WEIGHT.review));
    addPoint(p, post.lat, post.lng, "review");
  }
  for (const plan of data.plans || []) {
    if (!plan.userID) continue;
    const p = person(plan.userID);
    p.counts.plan++;
    for (const s of plan.spots || []) {
      const post = s.spotId ? postById.get(s.spotId) : null;
      if (post && !s.isRoad) p.evidence.push(spotEvidence(post, "plan", SOURCE_WEIGHT.plan));
      addPoint(p, s.lat, s.lng, "plan");
    }
  }
  for (const taste of data.tastes || []) {
    if (!taste.userID) continue;
    const p = person(taste.userID);
    for (const [group, kind] of [["roads", "road"], ["spots", "spot"]]) {
      for (const item of Object.values(taste[group] || {})) {
        if (!item || !item.key) continue;
        p.counts.choice++;
        p.evidence.push({ kind, key: item.key, source: "choice", weight: Math.max(1, item.count || 1),
                          features: item.features || [] });
        const post = kind === "spot" ? postById.get(item.key) : null;
        if (post) addPoint(p, post.lat, post.lng, "choice");
      }
    }
  }

  const activity = (p) => Object.values(p.counts).reduce((s, n) => s + n, 0);
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
  // ⚠️ 番号は活動の多い順（同じなら uid 順で固定。uid そのものは返さない）
  const ordered = [...people.entries()].sort((a, b) => activity(b[1]) - activity(a[1]) || (a[0] < b[0] ? -1 : 1));
  const users = ordered.map(([, p], i) => {
    const taste = tasteFromEvidence(p.evidence);
    const prefs = {};
    for (const pt of p.points) {
      const pref = locate(pt.lng, pt.lat);
      if (pref) prefs[pref] = (prefs[pref] || 0) + 1;
    }
    return {
      no: i + 1,
      counts: p.counts,
      areas: top(prefs, 3),
      spotTaste: top(taste.spots, 5).map(([f, w]) => [f, Math.round(w * 100) / 100, taste.spotSources[f]]),
      roadTaste: top(taste.roads, 5).map(([f, w]) => [f, Math.round(w * 100) / 100, taste.roadSources[f]]),
      points: p.points,
    };
  });

  // 全員の合計
  const tags = {}, spotPoints = {}, highways = {};
  let withTag = 0, withPoints = 0, withRoad = 0;
  for (const post of posts) {
    const t = (post.tag || []).filter((x) => x);
    if (t.length) withTag++;
    for (const x of t) tags[x] = (tags[x] || 0) + 1;
    if ((post.points || []).length) withPoints++;
    for (const x of post.points || []) spotPoints[x] = (spotPoints[x] || 0) + 1;
    if (post.road && post.road.name) {
      withRoad++;
      const h = post.road.highway || "(不明)";
      highways[h] = (highways[h] || 0) + 1;
    }
  }
  // 地図の升目: 材料ごとの件数と、何人の行き先か
  const cells = new Map();
  for (const [uid, p] of people) {
    for (const pt of p.points) {
      const gy = Math.floor(pt.lat / GRID_DEG), gx = Math.floor(pt.lng / GRID_DEG);
      const id = gy + ":" + gx;
      if (!cells.has(id)) {
        cells.set(id, { lat: (gy + 0.5) * GRID_DEG, lng: (gx + 0.5) * GRID_DEG, total: 0, bySource: {}, people: new Set() });
      }
      const c = cells.get(id);
      c.total++;
      c.bySource[pt.source] = (c.bySource[pt.source] || 0) + 1;
      c.people.add(uid);
    }
  }
  const grid = [...cells.values()]
    .map((c) => ({ lat: Math.round(c.lat * 1000) / 1000, lng: Math.round(c.lng * 1000) / 1000,
                   total: c.total, bySource: c.bySource, people: c.people.size }))
    .sort((a, b) => b.total - a.total);
  const prefectures = {};
  for (const u of users) for (const [pref, n] of u.areas) prefectures[pref] = (prefectures[pref] || 0) + n;

  return {
    totals: {
      people: users.length,
      posts: posts.length, withTag, withPoints, withRoad,
      likes: users.reduce((s, u) => s + u.counts.like, 0),
      reviews: users.reduce((s, u) => s + u.counts.review, 0),
      plans: users.reduce((s, u) => s + u.counts.plan, 0),
      choices: users.reduce((s, u) => s + u.counts.choice, 0),
      // 走った道の感想（2026-10-08。アプリの RoadFeedback.swift）。どれくらい答えてもらえているかを数える
      ...feedbackTotals(data.feedback),
    },
    tags: top(tags, 50), spotPoints: top(spotPoints, 50), highways: top(highways, 10),
    prefectures: top(prefectures, 47),
    grid, gridDeg: GRID_DEG,
    users,
  };
}

/**
 * 本番から材料を読む（**読むだけ**）。⚠️ 必要な項目だけ（select）。メール・名前は読まない
 * - いいねは**スポットの配下**のものだけ（imagedownload/{spot}/yaehCount）。外に置いた古い控え（yaehCount）は
 *   取り消しても残るので使わない
 * - プランは users/{uid}/touringPlans
 */
/** 走った道の感想の数（回答数・答えた人・道の数）。⚠️ 中身（ひとこと）は /riders では使わない */
function feedbackTotals(feedback) {
  const c = countFeedback(feedback || []);
  return { feedbackAnswers: c.answers, feedbackRiders: c.riders, feedbackRoads: c.roads };
}

async function loadRiderData(db) {
  const [postsSnap, likesSnap, womSnap, plansSnap, tasteSnap, feedbackSnap] = await Promise.all([
    db.collection("imagedownload").select("userID", "lat", "lng", "tag", "points", "road").get(),
    db.collectionGroup("yaehCount").select("userID").get(),
    db.collection("wordOfMouth").select("postUserID", "locationDocID", "womAssessment").get(),
    db.collectionGroup("touringPlans").select("spots").get(),
    db.collection("user_taste").select("roads", "spots").get(),
    db.collection("road_feedback").select("uid", "roadID", "verdict").get(),
  ]);
  const posts = postsSnap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, userID: x.userID, lat: x.lat, lng: x.lng, tag: x.tag || [], points: x.points || [], road: x.road || null };
  });
  const likes = [];
  for (const d of likesSnap.docs) {
    const spot = d.ref.parent.parent;
    if (!spot || !spot.parent || spot.parent.id !== "imagedownload") continue;
    likes.push({ userID: d.data().userID, spotID: spot.id });
  }
  const reviews = womSnap.docs.map((d) => {
    const x = d.data();
    return { userID: x.postUserID, spotID: x.locationDocID, rating: x.womAssessment || 0 };
  });
  const plans = [];
  for (const d of plansSnap.docs) {
    const owner = d.ref.parent.parent;
    if (!owner) continue;
    const spots = (d.data().spots || []).map((s) => ({ spotId: s.spotId || null, lat: s.lat, lng: s.lng,
                                                       isRoad: s.isRoad === true, roadID: s.roadId || null }));
    plans.push({ userID: owner.id, spots });
  }
  const tastes = tasteSnap.docs.map((d) => ({ userID: d.id, ...(d.data() || {}) }));
  const feedback = feedbackSnap.docs.map((d) => d.data() || {});
  return { posts, likes, reviews, plans, tastes, feedback };
}

module.exports = { SOURCE_WEIGHT, REVIEW_MIN, GRID_DEG, roadFeatures, spotFeatures, tasteFromEvidence, buildInsights, loadRiderData };

  },
  };
  var cache = {};
  function load(name) {
    if (cache[name]) return cache[name].exports;
    var module = { exports: {} };
    cache[name] = module;
    defs[name](function (id) {
      var m = /^\.\/([A-Za-z0-9_]+)(?:\.js)?$/.exec(id);
      // ⚠️ Node だけの部品（fs など）は空の箱。Web では使わない関数の中でしか使っていない
      return m && defs[m[1]] ? load(m[1]) : {};
    }, module, module.exports);
    return module.exports;
  }
  var api = { appFun: load("appFunRoute"), geometry: load("navGeometry"), rider: load("riderInsights") };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSFun = api;
})(typeof window !== "undefined" ? window : this);
