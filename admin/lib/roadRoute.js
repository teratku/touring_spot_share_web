/**
 * roadRoute.js
 *
 * 手元のグリッドCSVを使って、指定した2点のあいだを道でつなぐ。
 *
 * 【なぜ必要か】
 * 通行規制は「◯◯橋から△△トンネルまで」のように**両端**で決まっている。
 * 1本の道を選んで「始」「終」をドラッグする方式だと、
 *   ・規制が複数の道路にまたがっていると1本では表せない
 *   ・両端の場所が分かっていても、そこまでドラッグで合わせるのが手間
 * という不便がある。両端を指したら、そのあいだの道を自動でつなぐ。
 *
 * 【つなぎ方】
 * CSV の道路断片は交差点で切れているので、**端点をつないだグラフ**として
 * ダイクストラで最短経路を探す。端点は roadStitcher と同じ粗さで量子化して
 * 突き合わせる（測量誤差で完全一致しないため）。
 *
 * ⚠️ 車の経路探索ではない。一方通行も進入禁止も見ていない。
 *    規制区間の形を作るための「道でつながった線」であって、走る順路ではない。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { parseWkt, distanceMeters, readGridFile } = require("./roadCsv");
const { simplify, encode } = require("./polyline");
const { gridFileName, TARGET_HIGHWAYS, GRID_DIR } = require("./roadsAtPoint");

/** 端点を同じ点とみなす粗さ（度）。約22m。roadStitcher の CELL と同じ考え方 */
const NODE_CELL = 0.0002;

/** 2点の外側にこれだけ余裕を持たせてCSVを読む（迂回する道が範囲外だと繋がらない） */
const MARGIN_DEGREES = 0.05;

/** 端点からこれ以上離れた場所しか道が無ければ、その点は道の上に無いとみなす */
const MAX_SNAP_METERS = 500;

/** 読むマスの上限。広い範囲を指されたときに待たせない */
const MAX_CELLS = 42;

/**
 * 端点が同じ場所とみなせる距離（m）。
 *
 * 【実測（大月→青梅・直線36.2km。CSVの端点が微妙に離れていて繋がらなかった例）】
 *   0〜45m … つなぐ道が見つからない
 *   50m    … 54.87km（直線比1.51）継ぎ目16m
 *   55m〜  … 53.18km（直線比1.47）継ぎ目20m
 *
 * ⚠️ 短い区間の結果はほとんど変わらない（都留→大月 8.14km→8.13km、
 *    奥多摩→丹波山 21.48km→21.47km）。長い経路が繋がるかどうかだけが変わる。
 *
 * ⚠️ 広げすぎないこと。端点どうしが50m以内にあるのは「本当は繋がっている道」が
 *    ほとんどだが、川や立体交差をまたいで繋いでしまう余地は残る。
 *    どれだけ跨いだかは `joinGapMeters` で返しているので、画面で必ず見せること。
 */
const JOIN_METERS = 50;

/** 返す線の粗さ */
const TOLERANCE = 10;

const key = (point) =>
  `${Math.round(point[0] / NODE_CELL)}:${Math.round(point[1] / NODE_CELL)}`;

/** 2点を含む範囲（＋余裕）に掛かるマスをすべて並べる */
function cellsCovering(from, to) {
  const minLat = Math.min(from[1], to[1]) - MARGIN_DEGREES;
  const maxLat = Math.max(from[1], to[1]) + MARGIN_DEGREES;
  const minLng = Math.min(from[0], to[0]) - MARGIN_DEGREES;
  const maxLng = Math.max(from[0], to[0]) + MARGIN_DEGREES;
  const names = [];
  // ⚠️ 四隅だけでは足りない。範囲が3マス以上にまたがると真ん中が抜ける
  for (let lat = Math.floor(minLat * 10); lat <= Math.floor(maxLat * 10); lat++) {
    for (let lng = Math.floor(minLng * 10); lng <= Math.floor(maxLng * 10); lng++) {
      names.push(gridFileName(lat / 10 + 0.05, lng / 10 + 0.05));
    }
  }
  return names;
}

function lengthOf(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

/**
 * 2点のあいだを道でつなぐ。
 *
 * @param {[number,number]} from [lng, lat]
 * @param {[number,number]} to   [lng, lat]
 * @returns {Promise<{points, lengthMeters, polyline, roadNames, cells, truncated}|{error}>}
 */
async function routeBetween(from, to, options = {}) {
  const dir = options.gridDir || GRID_DIR;
  const cells = cellsCovering(from, to);
  if (cells.length > MAX_CELLS) {
    return { error: `範囲が広すぎます（${cells.length}マス）。近い2点で試してください` };
  }

  // --- 道路断片を読む ---
  const edges = [];
  const used = [];
  for (const name of cells) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    used.push(name);
    await readGridFile(file, (row) => {
      if (!TARGET_HIGHWAYS.has(row.get("highway"))) return;
      const points = parseWkt(row.get("geometry"));
      if (!points || points.length < 2) return;
      edges.push({ name: row.get("name") || row.get("ref") || "", points, meters: lengthOf(points) });
    });
  }
  if (!edges.length) return { error: "この範囲のCSVが手元にありません" };

  // --- 端点をつないでグラフにする ---
  const graph = new Map();   // ノード → [{ to, meters, points, name }]
  const nodePoint = new Map();
  const addNode = (point) => {
    const k = key(point);
    if (!nodePoint.has(k)) { nodePoint.set(k, point); graph.set(k, []); }
    return k;
  };
  for (const edge of edges) {
    const a = addNode(edge.points[0]);
    const b = addNode(edge.points[edge.points.length - 1]);
    if (a === b) continue;                        // 輪になっている断片は使わない
    graph.get(a).push({ to: b, meters: edge.meters, points: edge.points, name: edge.name });
    graph.get(b).push({ to: a, meters: edge.meters, points: [...edge.points].reverse(), name: edge.name });
  }

  // ⚠️ **近いだけの端点も繋ぐこと。** 鍵が一致するかだけで見ると、マスの境目を
  //    はさんで数mしか離れていない端点が別ノードになる。実際にそれで、終点が
  //    2ノードだけの孤立した断片に付き（本線まで37m）「つなぐ道が見つからない」
  //    と出た。roadStitcher が端点合わせに使っているのと同じ考え方で、
  //    隣のマスまで見て近いもの同士を繋ぐ。
  const joinMeters = Number.isFinite(options.joinMeters) ? options.joinMeters : JOIN_METERS;
  const buckets = new Map();
  for (const [k, point] of nodePoint) {
    const bk = `${Math.round(point[0] / NODE_CELL)}:${Math.round(point[1] / NODE_CELL)}`;
    if (!buckets.has(bk)) buckets.set(bk, []);
    buckets.get(bk).push(k);
  }
  for (const [k, point] of nodePoint) {
    const cx = Math.round(point[0] / NODE_CELL);
    const cy = Math.round(point[1] / NODE_CELL);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (const other of buckets.get(`${cx + dx}:${cy + dy}`) || []) {
          if (other === k) continue;
          const d = distanceMeters(point, nodePoint.get(other));
          if (d > joinMeters) continue;
          // 繋ぎは形を持たない（この間に道の線は無い）。距離だけ払わせる
          graph.get(k).push({ to: other, meters: d, points: [point, nodePoint.get(other)], name: "", isJoin: true });
        }
      }
    }
  }

  // --- 両端に一番近いノードを探す ---
  const nearestNode = (at) => {
    let best = null;
    let bestDistance = MAX_SNAP_METERS;
    for (const [k, point] of nodePoint) {
      const d = distanceMeters(at, point);
      if (d < bestDistance) { bestDistance = d; best = k; }
    }
    return best;
  };
  const start = nearestNode(from);
  const goal = nearestNode(to);
  if (!start) return { error: "始点の近くに道が見つかりません" };
  if (!goal) return { error: "終点の近くに道が見つかりません" };
  if (start === goal) return { error: "始点と終点が同じ場所です" };

  // --- ダイクストラ ---
  // ⚠️ 優先度付きキューは使わず、素朴に最小を選ぶ。ノードは数千で、
  //    1回の操作にしか使わないので、読みやすさを取る。
  const distance = new Map([[start, 0]]);
  const cameFrom = new Map();
  const visited = new Set();
  while (true) {
    let current = null;
    let currentDistance = Infinity;
    for (const [k, d] of distance) {
      if (!visited.has(k) && d < currentDistance) { currentDistance = d; current = k; }
    }
    if (current === null) break;
    if (current === goal) break;
    visited.add(current);
    for (const edge of graph.get(current) || []) {
      const next = currentDistance + edge.meters;
      if (next < (distance.get(edge.to) ?? Infinity)) {
        distance.set(edge.to, next);
        cameFrom.set(edge.to, { from: current, edge });
      }
    }
  }
  if (!cameFrom.has(goal)) {
    return { error: "2点をつなぐ道が見つかりませんでした（離れすぎか、間の道がCSVにありません）" };
  }

  // --- 経路を組み立てる ---
  const parts = [];
  for (let at = goal; cameFrom.has(at); at = cameFrom.get(at).from) parts.push(cameFrom.get(at).edge);
  parts.reverse();

  const points = [];
  const roadNames = [];
  // ⚠️ **継ぎ目の飛びを測っておくこと。** 端点は約22mの粗さで突き合わせているので、
  //    別の道の端を同じ点と誤認すると、そこで線が飛ぶ。元データ自体にも
  //    長い直線区間（実測で最大739m）があるため、全体の頂点間隔を見ても
  //    区別できない。**区間のつなぎ目だけ**を測る。
  let joinGapMeters = 0;
  for (const part of parts) {
    const last = points[points.length - 1];
    if (last) joinGapMeters = Math.max(joinGapMeters, distanceMeters(last, part.points[0]));
    for (const p of part.points) {
      const tail = points[points.length - 1];
      if (!tail || tail[0] !== p[0] || tail[1] !== p[1]) points.push(p);
    }
    if (part.name && roadNames[roadNames.length - 1] !== part.name) roadNames.push(part.name);
  }

  return {
    points,
    lengthMeters: Math.round(lengthOf(points)),
    polyline: encode(simplify(points, TOLERANCE)),
    roadNames,
    cells: used,
    // 指した端と、実際に道へ乗せた位置とのずれ（大きいと違う道を掴んでいる）
    snapFromMeters: Math.round(distanceMeters(from, nodePoint.get(start))),
    snapToMeters: Math.round(distanceMeters(to, nodePoint.get(goal))),
    // 区間のつなぎ目でどれだけ飛んだか。大きいと別の道を掴んでいる
    joinGapMeters: Math.round(joinGapMeters),
  };
}

module.exports = { routeBetween, cellsCovering, MAX_CELLS, MAX_SNAP_METERS, MARGIN_DEGREES, JOIN_METERS };
