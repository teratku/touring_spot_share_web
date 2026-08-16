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
function overlapRatio(restrictionLine, roadLine, nearMeters = NEAR_METERS) {
  const points = resample(restrictionLine);
  if (!points.length || roadLine.length < 2) return 0;
  let hit = 0;
  for (const p of points) if (distanceToLine(p, roadLine) <= nearMeters) hit++;
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
    for (const restriction of restrictions) {
      if (!restriction.points || restriction.points.length < 2) continue;
      // ⚠️ 先に大づかみで弾く。全部の点を測ると、県内150本×規制数で待たされる
      if (distanceToLine(restriction.points[0], road.points) > 5000) continue;
      const ratio = overlapRatio(restriction.points, road.points, nearMeters);
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
 * 二輪が通れない規制と重なる、おすすめ道路の番号を返す。
 *
 * ⚠️ **おすすめ道路の区間は `points` を持っていない。** 持っているのは
 *    `polyline`（符号化した文字列）で、`points` は生成の途中でしか存在しない。
 *    そこを取り違えて `seg.points` を渡していたため、この除外は
 *    **一度も働いていなかった**（栃木で「0本除外」と出ていたのは、規制が
 *    重ならなかったのではなく空振りしていたから）。エラーは出ない。
 *    だからここで受け取って、この中で復号する。
 *
 * @param {Array} saved    data/road-restrictions/<romaji>.json の `restrictions`
 * @param {Array} segments おすすめ道路の区間（`polyline` を持つ形）
 * @returns {Map} 区間の番号 → [{ restrictionId, name, kind, ratio }]
 */
function blockedSegments(saved, segments) {
  const { decode } = require("./polyline");
  const restrictions = (saved || [])
    .filter((r) => r && BLOCKING_KINDS.has(r.kind) && r.polyline)
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

module.exports = {
  findOverlaps, overlapRatio, resample, distanceToLine, blockedSegments,
  NEAR_METERS, STEP_METERS, MIN_RATIO, BLOCKING_KINDS,
};
