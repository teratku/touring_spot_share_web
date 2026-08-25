/**
 * roadRecommendIndex.js
 *
 * 出発地と目的地のあいだにある県のおすすめ道路を、**県をまたいで**集める。
 *
 * 【なぜ要るか】
 * ⚠️ **1県だけ読むと、県境をまたぐ旅で市街地の道しか選べない。**
 *    実測（新宿→秩父）:
 *      東京だけ    候補 3本 → 祝田通り(66点)・明治通り(71点) …市街地の道
 *      東京＋埼玉  候補21本 → 青梅秩父線(77点)・下日野沢東門平吉田線(82点) …本物の峠
 *    秩父は埼玉県なので、東京のデータだけでは目的地周辺の道が1本も入らない。
 *
 * 【どこから来た処理か】
 * iOS の `EnjoyableRoadsService.prefecturesWithin(center:radiusKm:)` と同じ考え方。
 * 出発地と目的地の**中点**を中心に、**半径 max(30km, 直線距離)** の箱に掛かる県を取る。
 *
 * ⚠️ **県の範囲は、配信データの区間そのものから作る。**
 *    アプリは行政界（`PrefectureData.bounds`）を使っているが、こちらは
 *    「おすすめ道路がどこにあるか」だけが要るので、区間の外接矩形で足りる。
 *    行政界より狭くなるぶん、**道が1本も入らない県を読まずに済む**。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data", "road-recommend");
//: 中点からの半径の下限（km）。近い2点でも、この範囲の県は見る
const MIN_RADIUS_KM = 30;

//: romaji → { prefecture, bounds, mtimeMs }
let index = null;
let builtFrom = null;   // 索引を作ったときのファイル一覧の指紋

/** いま置かれているファイルの指紋。差し替えたら索引を作り直すため */
function fingerprint() {
  if (!fs.existsSync(DIR)) return "";
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
    .map((f) => `${f}:${fs.statSync(path.join(DIR, f)).mtimeMs}`).join("|");
}

/**
 * 県ごとの外接矩形を作る。
 *
 * ⚠️ 全県ぶん（47ファイル・4.4MB）を読むので、**一度作ったら使い回す。**
 *    毎回作り直すと、ルートを引くたびに4.4MBを解くことになる。
 */
function build() {
  const print = fingerprint();
  if (index && builtFrom === print) return index;

  index = {};
  if (!fs.existsSync(DIR)) { builtFrom = print; return index; }
  for (const file of fs.readdirSync(DIR)) {
    if (!file.endsWith(".json")) continue;
    const romaji = file.replace(/\.json$/, "");
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")); }
    catch (e) { continue; }          // 壊れたファイルで全体を止めない
    let latMin = 90, latMax = -90, lngMin = 180, lngMax = -180, count = 0;
    for (const s of data.segments || []) {
      for (const p of [s.start, s.end]) {
        if (!Array.isArray(p) || p.length < 2) continue;
        // ⚠️ start / end は [緯度, 経度]
        latMin = Math.min(latMin, p[0]); latMax = Math.max(latMax, p[0]);
        lngMin = Math.min(lngMin, p[1]); lngMax = Math.max(lngMax, p[1]);
        count++;
      }
    }
    if (!count) continue;
    index[romaji] = {
      romaji, prefecture: data.prefecture || romaji,
      bounds: { latMin, latMax, lngMin, lngMax },
      segmentCount: (data.segments || []).length,
    };
  }
  builtFrom = print;
  return index;
}

/**
 * 中心から半径 radiusKm の箱に掛かる県。
 * @param {[number,number]} center [経度, 緯度]
 */
function prefecturesWithin(center, radiusKm) {
  const [lng, lat] = center;
  const latDelta = radiusKm / 111.0;
  const lngDelta = radiusKm / (111.0 * Math.cos((lat * Math.PI) / 180));
  const latMin = lat - latDelta, latMax = lat + latDelta;
  const lngMin = lng - lngDelta, lngMax = lng + lngDelta;
  return Object.values(build())
    .filter((e) => e.bounds.latMin <= latMax && e.bounds.latMax >= latMin
                && e.bounds.lngMin <= lngMax && e.bounds.lngMax >= lngMin)
    .map((e) => e.romaji)
    .sort();
}

/**
 * 出発地と目的地のあいだにある県の区間を、まとめて返す。
 *
 * @param {[number,number]} origin      [経度, 緯度]
 * @param {[number,number]} destination [経度, 緯度]
 * @returns {{segments, prefectures}}
 */
function segmentsBetween(origin, destination) {
  const center = [(origin[0] + destination[0]) / 2, (origin[1] + destination[1]) / 2];
  // 直線距離（km）。ざっくりで足りる（どの県を読むかの判断にしか使わない）
  const dLat = (destination[1] - origin[1]) * 111.0;
  const dLng = (destination[0] - origin[0]) * 111.0 * Math.cos((center[1] * Math.PI) / 180);
  const spanKm = Math.hypot(dLat, dLng);
  const romajis = prefecturesWithin(center, Math.max(MIN_RADIUS_KM, spanKm));

  const segments = [];
  for (const romaji of romajis) {
    const file = path.join(DIR, `${romaji}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const s of data.segments || []) segments.push(s);
    } catch (e) { /* 壊れたファイルは飛ばす */ }
  }
  return { segments, prefectures: romajis };
}

/** 索引を捨てる（データを作り直したあとなど） */
function clearIndex() { index = null; builtFrom = null; }

module.exports = { segmentsBetween, prefecturesWithin, build, clearIndex, MIN_RADIUS_KM, DIR };
