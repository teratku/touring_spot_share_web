/**
 * funRoute.js
 *
 * おすすめ道路を1本通る経路を、**自前のデータだけ**で作る。
 *
 * 【なぜ自前でやるか】
 * ⚠️ いまアプリは Google Directions に経由地を最大22点渡して楽しい道を通している。
 *    そのせいで次が起きていた（すべて実機で確認）:
 *      ・経由地を指定すると Directions が代替ルートを返さず、候補が1本に潰れる
 *      ・`avoid` はヒントなので、下道指定でも有料が混ざる
 *      ・経由地の順序次第でUターンになり、除外して作り直すと候補が減る
 *      ・1回の生成で12〜78リクエスト（経由地10点超は Advanced 課金）
 *    経路そのものを自前で引けば、この全部が構造ごと無くなる。
 *
 * 【どこまでやるか・やらないか】
 * ⚠️ **これは案内（ナビ）ではない。** 一方通行も進入禁止も通行止めも見ていない。
 *    「この道を通ると気持ちいい」を**提案する**ための線であって、
 *    右折・左折を指示するためのものではない。案内は Google / Yahoo に渡す前提。
 * ⚠️ 通す楽しい道は**1本だけ**。多く繋ぐほど遠回りと計算量が増え、
 *    Directions 版で起きていた問題（Uターン・予算超過）が自前でも再現する。
 *    まず1本で質を見る。
 *
 * 使い方:
 *   const { buildFunRoute } = require("./lib/funRoute");
 *   await buildFunRoute({ from: [lng, lat], to: [lng, lat], prefectures: ["山梨県"] })
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { routeBetween } = require("./roadRoute");
const { decode, encode } = require("./polyline");
const { distanceMeters, polylineLength } = require("./roadCsv");
const { ROMAJI } = require("./prefectureRomaji");

/** 通す楽しい道の最低条件。生成データの分布に合わせてある */
const MIN_SCORE = 40;
const MIN_CURVINESS = 300;
const MIN_LENGTH_KM = 1.0;

/**
 * 直線から横にどれだけ離れてよいか。
 *
 * ⚠️ 広げるほど「遠くの良い道」を拾えるが、**行きも帰りも同じ方向へ戻る**形になり
 *    体感の遠回りが跳ね上がる。iOS 版と同じ考え方（直線距離の3割・上限25km）にしてある。
 */
const CORRIDOR_RATIO = 0.30;
const CORRIDOR_CAP_METERS = 25_000;
const CORRIDOR_MIN_METERS = 5_000;

/** 遠回りの上限（最短経路に対する倍率）。これを超える道は通さない */
const DEFAULT_MAX_DETOUR = 1.6;

/** 点から線分への直交距離（m）。平面近似 */
function lateralMeters(point, a, b) {
  const M = 111320;
  const cos = Math.cos((a[1] * Math.PI) / 180);
  const px = (point[0] - a[0]) * M * cos, py = (point[1] - a[1]) * M;
  const bx = (b[0] - a[0]) * M * cos, by = (b[1] - a[1]) * M;
  const len2 = bx * bx + by * by;
  if (!len2) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - bx * t, py - by * t);
}

/**
 * 県の配信データから、通せそうな区間を集める。
 *
 * ⚠️ 配信データの `start`/`end` は **[緯度, 経度]**、経路探索は **[経度, 緯度]**。
 *    ここを取り違えると、地球の裏側を探しにいって「道が無い」としか見えない。
 */
function loadCandidates(prefectures, dataDir) {
  const out = [];
  for (const pref of prefectures) {
    const romaji = ROMAJI[pref];
    if (!romaji) continue;
    const file = path.join(dataDir, `${romaji}.json`);
    if (!fs.existsSync(file)) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    for (const s of json.segments || []) {
      if (!s.polyline) continue;
      if (!(s.score >= MIN_SCORE)) continue;
      if (!(s.curviness >= MIN_CURVINESS)) continue;
      if (!(s.lengthKm >= MIN_LENGTH_KM)) continue;
      out.push({
        id: s.id, name: s.name, score: s.score, lengthKm: s.lengthKm,
        curviness: s.curviness,
        // [緯度,経度] → [経度,緯度] に直す
        start: [s.start[1], s.start[0]],
        end: [s.end[1], s.end[0]],
        points: decode(s.polyline),
      });
    }
  }
  return out;
}

/** 直線の近くにある区間だけ残す */
function withinCorridor(candidates, from, to, scale = 1) {
  const direct = distanceMeters(from, to);
  const cap = Math.min(direct * CORRIDOR_RATIO, CORRIDOR_CAP_METERS);
  return candidates.filter((c) => {
    const mid = c.points[Math.floor(c.points.length / 2)];
    const allowed = Math.max(CORRIDOR_MIN_METERS,
                             Math.min(cap, 3000 * c.lengthKm)) * scale;
    return lateralMeters(mid, from, to) <= allowed;
  });
}

/**
 * 区間を通る向きを決める。
 * ⚠️ 出発地に近い端から入ること。逆から入ると、区間の手前で折り返す形になる。
 */
function orient(segment, from) {
  const toStart = distanceMeters(from, segment.start);
  const toEnd = distanceMeters(from, segment.end);
  return toStart <= toEnd
    ? { entry: segment.start, exit: segment.end, points: segment.points }
    : { entry: segment.end, exit: segment.start, points: [...segment.points].reverse() };
}

/**
 * おすすめ道路を1本通る経路を作る。
 *
 * @param {object} o
 *   from/to      [経度, 緯度]
 *   prefectures  探す県（配信データを読む）
 *   maxDetour    遠回りの上限（最短の何倍まで）。既定 1.6
 * @returns {object} { polyline, points, lengthMeters, baselineMeters, detourRatio,
 *                     segment, tried, error }
 */
async function buildFunRoute(o) {
  const { from, to, prefectures = [], maxDetour = DEFAULT_MAX_DETOUR } = o;
  const dataDir = o.dataDir || path.join(__dirname, "..", "data", "road-recommend");
  const gridDir = o.gridDir;

  // ⚠️ まず最短を引く。遠回りの度合いは**実際に引いた経路**に対して測る。
  //    直線距離を基準にすると、誰も走らない距離との比になって体感と合わない
  const base = await routeBetween(from, to, { gridDir });
  if (base.error) return { error: `基準の経路を引けません: ${base.error}` };
  const baselineMeters = base.lengthMeters;

  const candidates = withinCorridor(loadCandidates(prefectures, dataDir), from, to);
  if (!candidates.length) {
    return { error: "近くに条件を満たすおすすめ道路がありません",
             baselineMeters, polyline: base.polyline, points: base.points,
             lengthMeters: baselineMeters, detourRatio: 1, segment: null, tried: 0 };
  }

  // ⚠️ **点数の高い順に見て、予算に収まった最初のものを採る。**
  //    「寄り道の安さ」で選ぶと、直線の近くにある凡庸な道が勝つ（iOS 版で実測済み）。
  const byScore = [...candidates].sort((a, b) => b.score - a.score);
  const budget = baselineMeters * maxDetour;
  let tried = 0;

  for (const candidate of byScore) {
    tried++;
    const o2 = orient(candidate, from);
    const head = await routeBetween(from, o2.entry, { gridDir });
    if (head.error) continue;
    const tail = await routeBetween(o2.exit, to, { gridDir });
    if (tail.error) continue;

    const points = [...head.points, ...o2.points, ...tail.points];
    const lengthMeters = polylineLength(points);
    if (lengthMeters > budget) continue;

    return {
      polyline: encode(points), points, lengthMeters, baselineMeters,
      detourRatio: Number((lengthMeters / baselineMeters).toFixed(3)),
      segment: { id: candidate.id, name: candidate.name, score: candidate.score,
                 lengthKm: candidate.lengthKm },
      legs: { head: head.lengthMeters, fun: polylineLength(o2.points), tail: tail.lengthMeters },
      tried,
    };
  }

  // ⚠️ 見つからなかったことを黙って最短で返さない。理由を添える
  return { error: `予算（最短の${maxDetour}倍）に収まるおすすめ道路がありませんでした`,
           baselineMeters, polyline: base.polyline, points: base.points,
           lengthMeters: baselineMeters, detourRatio: 1, segment: null, tried };
}

module.exports = {
  buildFunRoute, loadCandidates, withinCorridor, orient, lateralMeters,
  MIN_SCORE, MIN_CURVINESS, MIN_LENGTH_KM, DEFAULT_MAX_DETOUR,
};
