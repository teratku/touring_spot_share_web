"use strict";
/**
 * osmGridLayer.js — 手元の OSM の道（グリッドCSV）を、地図に重ねる分だけ返す（/roads の「OSMの道」）。
 *
 * ⚠️ 利用者の要望（2026-10-11）: 道を足す・直すときに、線がどこを通るか確かめたい。全部開くと重い。
 * ⚠️ **線を引く経路探索（`roadRoute.js`）と同じ道だけを返す**（`TARGET_HIGHWAYS` で絞るだけ）。
 *    道を足す画面の青い線（道路の索引 `buildRoadIndex.js`）とは違う: あちらはランプ（`_link`）と
 *    200m 未満を落とし、索引を作った県でしか出ず、一度に500本まで。そこに無い道を線が通ると、
 *    どこを通ったのか分からなかった
 * ⚠️ 手元の CSV（`grid_csvs_japan_empty`）には名前の付いた道しか入っていない（2026-10-11 に
 *    無作為150マス・18,951本で確認）。名前の無い道は経路探索も通れない
 * ⚠️ **マス（0.1度）ごとに返す。** 画面は見えているマスだけ取りに来る。重いのは量より線の数
 *    （実測: 東京の中心のマスで 4,847本・応答426KB・初めて0.14秒／覚えたあと0.006秒。秩父の山は125本・16KB）
 */
const fs = require("fs");
const path = require("path");
const { parseWkt, readGridFile } = require("./roadCsv");
const { TARGET_HIGHWAYS, GRID_DIR, gridCell, cellFileName } = require("./roadsAtPoint");
const { simplify, encode } = require("./polyline");

/** 1回に返すマスの上限。超えたら「寄ってください」（東京の中心が24マスで10万本を超える） */
const MAX_CELLS = 24;
/** 線の間引き（m）。⚠️ 経路探索は間引かない線をたどる。見た目が変わらない程度にとどめる */
const TOLERANCE = 3;
/** 覚えておくマスの数（読み直すと東京の中心で約0.2秒） */
const CACHE_CELLS = 64;

/** 範囲に掛かるマスのうち、ファイルがあるもの（海だけのマスにはファイルが無い） */
function cellKeysInBounds(bounds, { gridDir = GRID_DIR } = {}) {
  const { s, w, n, e } = bounds || {};
  if (![s, w, n, e].every(Number.isFinite) || s > n || w > e) return { error: "範囲（s,w,n,e）が正しくありません" };
  const lo = gridCell(s, w);
  const hi = gridCell(n, e);
  if ((hi.a - lo.a + 1) * (hi.b - lo.b + 1) > MAX_CELLS) return { tooMany: true, cells: [] };
  const cells = [];
  for (let a = lo.a; a <= hi.a; a++) {
    for (let b = lo.b; b <= hi.b; b++) {
      if (fs.existsSync(path.join(gridDir, cellFileName(a, b)))) cells.push(`${a}_${b}`);
    }
  }
  return { tooMany: false, cells };
}

/** "1256_3197" → { a, b }。形が違えば null（ファイル名に使うので数字だけ通す） */
function parseCellKey(key) {
  const m = /^(\d{3,4})_(\d{3,4})$/.exec(String(key || ""));
  return m ? { a: Number(m[1]), b: Number(m[2]) } : null;
}

const cache = new Map(); // key → { mtimeMs, promise }

/**
 * 1マスの道。`{ i: osm_id, n: 名前, h: 種類, r: 番号, p: 線（Encoded Polyline） }` の並び。
 * ⚠️ 鍵を短くしているのは東京の中心で5千本近くあるから（名前のほかは数文字ずつ）
 */
async function cellWays(key, { gridDir = GRID_DIR } = {}) {
  const cell = parseCellKey(key);
  if (!cell) return null;
  const file = path.join(gridDir, cellFileName(cell.a, cell.b));
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
  const cacheKey = `${gridDir}|${key}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.mtimeMs === mtimeMs) {
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit.promise;
  }
  const promise = (async () => {
    const ways = [];
    await readGridFile(file, ({ get }) => {
      const h = get("highway");
      if (!TARGET_HIGHWAYS.has(h)) return;
      const points = parseWkt(get("geometry"));
      if (!points) return;
      ways.push({ i: get("osm_id"), n: get("name"), h, r: get("ref"), p: encode(simplify(points, TOLERANCE)) });
    });
    return ways;
  })();
  cache.set(cacheKey, { mtimeMs, promise });
  promise.catch(() => cache.delete(cacheKey));
  while (cache.size > CACHE_CELLS) cache.delete(cache.keys().next().value);
  return promise;
}

module.exports = { cellKeysInBounds, parseCellKey, cellWays, MAX_CELLS, TOLERANCE };
