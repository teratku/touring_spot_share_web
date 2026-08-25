/**
 * roadSurface.js
 *
 * 道の舗装の状態（砂利道かどうか）を扱う。
 *
 * 【どこから来たデータか】
 * `~/Documents/OSM道路データ更新/extract_surface.py` が pbf から抜いた
 * `data/road-surface.csv`（osm_id, surface, tracktype, highway, name）。
 *
 * ⚠️ **配信しているグリッドCSVには `surface` の列が無い。** 列を足すには
 *    pbf を読み直して4,587マスを作り直し、Firebase へ上げ直すことになる。
 *    未舗装の道の id だけを別ファイルに持つ形にしてある（全国11.4万本・3.2MB）。
 *
 * 【実測（2026-08-25・japan-260823.osm.pbf）】
 *   道路の way 10,577,854本のうち surface があるのは 1,076,985本（10.2%）。
 *   未舗装は 114,346本。おすすめ道路の対象種別だけだと:
 *     secondary 774 / primary 170 / tertiary 41 / trunk 18
 *   配信中のおすすめ6,980区間のうち、名前が一致するのは285区間。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "data", "road-surface.csv");

/**
 * surface の値 → 画面に出す言い方。
 *
 * ⚠️ **「砂利」と「未舗装」を分けること。** 砂利道は走れるが気を使う、
 *    土や草は状況次第で入れない。ひとまとめにすると判断できない。
 */
const LABELS = {
  gravel: "砂利", fine_gravel: "細かい砂利", pebblestone: "玉砂利",
  compacted: "締固め", unpaved: "未舗装",
  dirt: "土", earth: "土", ground: "地面", mud: "ぬかるみ",
  sand: "砂", grass: "草", rock: "岩", woodchips: "木くず",
  wood: "木道", "grass_paver": "芝生ブロック",
};

//: 走行に気を使う度合いが高い順。1本の道に複数の値があるとき、これで代表を決める
const SEVERITY = [
  "mud", "sand", "ground", "earth", "dirt", "grass", "rock", "woodchips",
  "unpaved", "wood", "pebblestone", "gravel", "fine_gravel", "compacted",
];

/** `tracktype` しか無いときの言い方（grade2〜6 が未舗装） */
const TRACKTYPE_LABELS = {
  grade2: "締固め（砂利まじり）", grade3: "砂利・土",
  grade4: "土・草", grade5: "ほぼ土", grade6: "ほぼ土",
};

/**
 * 未舗装の道を読み込む。
 * @returns {Map<string, {surface, tracktype, label}>}  osm_id → 舗装の状態
 */
function loadSurfaces(file = DEFAULT_FILE) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // ⚠️ 名前にカンマが入ることがある。**先頭4つだけ取る**（名前は使わない）
    const parts = line.split(",");
    const [osmId, surface, tracktype] = parts;
    if (!osmId) continue;
    map.set(osmId, {
      surface: surface || "",
      tracktype: tracktype || "",
      label: labelFor(surface, tracktype),
    });
  }
  return map;
}

/** surface / tracktype から、画面に出す言い方を作る */
function labelFor(surface, tracktype) {
  if (surface && LABELS[surface]) return LABELS[surface];
  if (surface) return surface;                       // 知らない値はそのまま出す
  if (tracktype && TRACKTYPE_LABELS[tracktype]) return TRACKTYPE_LABELS[tracktype];
  return "未舗装";
}

/**
 * 複数の値から、代表を1つ選ぶ。
 * ⚠️ **いちばん走りにくいものを選ぶ。** 「一部が土」なのに「締固め」と出すと、
 *    行ってから困る。
 */
function worstSurface(values) {
  const list = [...new Set(values.filter(Boolean))];
  if (!list.length) return "";
  list.sort((a, b) => {
    const ia = SEVERITY.indexOf(a), ib = SEVERITY.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return list[0];
}

/**
 * 区間の点をたどって、未舗装の距離を測る。
 *
 * ⚠️ **点が未舗装の道の上にあるかで見る。** 区間は複数の道をつないで作られるので、
 *    「この区間の道はどれか」を1つに決められない。
 *    区間の一部だけが砂利、ということが普通にある。
 *
 * @param {Array<[number,number]>} points  区間の点 [経度, 緯度]
 * @param {Map<string,{surface,tracktype,label}>} pointSurface 点の鍵 → 舗装の状態
 * @param {(a,b)=>number} distance  2点の距離（m）
 * @returns {{unpavedMeters, totalMeters, ratio, surface, label}|null}
 */
function measureUnpaved(points, pointSurface, distance) {
  if (!points || points.length < 2 || !pointSurface || !pointSurface.size) return null;
  let unpaved = 0, total = 0;
  // ⚠️ **surface と tracktype を混ぜないこと。** 混ぜたせいで、tracktype しか
  //    無い道の言い方が「grade3」という生の値のまま画面に出た
  const surfaces = [], tracktypes = [];
  for (let i = 0; i < points.length - 1; i++) {
    const d = distance(points[i], points[i + 1]);
    total += d;
    // ⚠️ **両端とも未舗装の道の上にあるときだけ数える。** 片方だけだと、
    //    舗装路から砂利道へ入る手前の1区間まで砂利に数えてしまう
    const a = pointSurface.get(key(points[i]));
    const b = pointSurface.get(key(points[i + 1]));
    if (a && b) {
      unpaved += d;
      for (const x of [a, b]) {
        if (x.surface) surfaces.push(x.surface);
        if (x.tracktype) tracktypes.push(x.tracktype);
      }
    }
  }
  if (unpaved <= 0) return null;
  const worst = worstSurface(surfaces);
  // tracktype は grade の数が大きいほど走りにくい。いちばん大きいものを採る
  const worstTrack = [...new Set(tracktypes)].sort().pop() || "";
  return {
    unpavedMeters: Math.round(unpaved),
    totalMeters: Math.round(total),
    ratio: total > 0 ? Number((unpaved / total).toFixed(3)) : 0,
    surface: worst,
    tracktype: worstTrack || undefined,
    label: labelFor(worst, worstTrack),
  };
}

/** 点の鍵。⚠️ 元の座標そのままで突き合わせる（区間の点は道の点をそのまま繋いだもの） */
const key = (p) => `${p[0]},${p[1]}`;

module.exports = { loadSurfaces, measureUnpaved, labelFor, worstSurface, key,
                   LABELS, TRACKTYPE_LABELS, SEVERITY, DEFAULT_FILE };
