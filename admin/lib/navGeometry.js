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
