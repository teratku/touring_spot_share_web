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
