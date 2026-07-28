/**
 * prefectureLocator.js
 *
 * 座標から都道府県を判定する。
 *
 * ⚠️ 全国をカバーしているグリッドCSV（grid_csvs_japan_empty）は
 *    列が osm_id,name,highway,ref,geometry の5つしかなく prefecture を持たない。
 *    そのため県は座標から自前で当てる。
 *
 * 判定にはアプリに同梱済みの県境ポリゴンをそのまま使う
 *   touringSpotShare/biketeilen_firebase/NewTabs/japan-prefectures.geojson
 *   （Natural Earth 1:10m 由来・パブリックドメイン。出どころと加工内容は
 *     docs/japan-prefectures-data.md）
 * バウンディングボックスで当てる方式（アプリの PrefectureBounds）だと
 * 矩形が重なる県境で取り違えるので、ポリゴンで判定する。
 *
 * 県境そのものは間引いてあるので、境界から数百m以内の道路は
 * 隣県に振れることがある。「どの県のおすすめに出すか」の用途では許容範囲。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_GEOJSON = path.resolve(
  __dirname, "..", "..", "..",
  "Xcode/biketeilen_iOS_clean/touringSpotShare/biketeilen_firebase/NewTabs/japan-prefectures.geojson"
);

/** ISO 3166-2 の "JP-13" → 13 */
function isoCode(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.split("-");
  if (parts.length !== 2 || parts[0].toUpperCase() !== "JP") return null;
  const id = Number(parts[1]);
  return Number.isInteger(id) && id >= 1 && id <= 47 ? id : null;
}

const PREFECTURE_NAMES = [
  null,
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

/**
 * 県の緯度経度の範囲。最後の受け皿として使う。
 *
 * ⚠️ 県境ポリゴンからは小さい島が間引きで消えている。
 * 奄美大島（129.49, 28.38）も宮古島（125.28, 24.81）も、どのポリゴンからも
 * 30km 以上離れていて拾えなかった。そういう離島をここで拾う。
 *
 * 矩形なので重なる（奄美は鹿児島と沖縄の両方の矩形に入る）。
 * アプリの PrefectureData.all と同じ並び（コード順）で先に当たった方を採る。
 * 値もそこから写している:
 *   touringSpotShare/biketeilen_firebase/NewTabs/PrefectureData.swift
 */
const PREFECTURE_BOXES = [
  [1, 41.35, 45.55, 139.30, 145.82], [2, 40.22, 41.55, 139.49, 141.68],
  [3, 38.75, 40.45, 140.65, 142.08], [4, 37.78, 39.00, 140.28, 141.68],
  [5, 39.00, 40.52, 139.70, 140.98], [6, 37.73, 39.22, 139.52, 140.65],
  [7, 36.79, 37.97, 139.17, 141.05], [8, 35.74, 36.97, 139.69, 140.85],
  [9, 36.20, 37.16, 139.33, 140.30], [10, 36.07, 37.06, 138.64, 139.68],
  [11, 35.76, 36.29, 138.72, 139.91], [12, 34.90, 36.00, 139.75, 140.87],
  [13, 35.50, 35.90, 138.94, 139.92], [14, 35.13, 35.67, 138.92, 139.78],
  [15, 36.76, 38.56, 137.84, 140.03], [16, 36.27, 36.99, 136.77, 137.76],
  [17, 36.07, 37.85, 136.23, 137.40], [18, 35.37, 36.29, 135.53, 136.82],
  [19, 35.20, 35.93, 138.18, 139.16], [20, 35.18, 37.03, 137.32, 138.72],
  [21, 35.14, 36.47, 136.26, 137.65], [22, 34.58, 35.64, 137.47, 139.18],
  [23, 34.58, 35.43, 136.67, 137.83], [24, 33.73, 35.18, 135.85, 136.98],
  [25, 34.76, 35.70, 135.76, 136.45], [26, 34.56, 35.78, 134.85, 136.06],
  [27, 34.27, 34.98, 135.10, 135.75], [28, 34.15, 35.67, 134.25, 135.47],
  [29, 33.85, 34.79, 135.57, 136.22], [30, 33.43, 34.38, 135.07, 136.00],
  [31, 35.07, 35.62, 133.14, 134.51], [32, 34.30, 36.08, 131.67, 133.39],
  [33, 34.35, 35.35, 133.26, 134.42], [34, 34.05, 35.12, 132.04, 133.40],
  [35, 33.74, 34.77, 130.79, 132.27], [36, 33.72, 34.26, 133.62, 134.80],
  [37, 34.03, 34.50, 133.46, 134.45], [38, 32.90, 34.00, 132.01, 133.69],
  [39, 32.71, 33.88, 132.47, 134.30], [40, 33.00, 33.97, 130.02, 131.19],
  [41, 32.96, 33.60, 129.74, 130.56], [42, 32.57, 34.73, 128.60, 130.35],
  [43, 32.08, 33.19, 130.11, 131.26], [44, 32.71, 33.75, 130.82, 132.11],
  [45, 31.36, 32.94, 130.69, 131.88], [46, 27.02, 32.32, 128.40, 131.32],
  [47, 24.05, 27.89, 122.93, 131.33],
];

/** GeoJSON の geometry から外周リング（[lng, lat] の配列）を取り出す。穴は無視 */
function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates.slice(0, 1);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((poly) => poly[0]);
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(ringsOf);
  return [];
}

/** 交差数判定。リングを横切る回数が奇数なら内側 */
function ringContains(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)) {
      const x = xi + ((lat - yi) / (yj - yi)) * (xj - xi);
      if (lng < x) inside = !inside;
    }
  }
  return inside;
}

class PrefectureLocator {
  constructor(geojsonPath = DEFAULT_GEOJSON) {
    const raw = JSON.parse(fs.readFileSync(geojsonPath, "utf8"));
    // 県 → [{ ring, minLng, maxLng, minLat, maxLat }]
    this.shapes = [];
    for (const feature of raw.features || []) {
      const props = feature.properties || {};
      const id = isoCode(props.iso_3166_2 || props.ISO_3166_2) ||
                 (Number.isInteger(props.id) && props.id >= 1 && props.id <= 47 ? props.id : null);
      if (!id) continue;
      const name = PREFECTURE_NAMES[id];
      for (const ring of ringsOf(feature.geometry)) {
        if (!ring || ring.length < 4) continue;
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const [lng, lat] of ring) {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
        this.shapes.push({ id, name, ring, minLng, maxLng, minLat, maxLat });
      }
    }
    if (this.shapes.length === 0) {
      throw new Error(`県境ポリゴンを読めなかった: ${geojsonPath}`);
    }
    // 直近の判定結果を覚えておく。道路の頂点は近い座標が連続するのでよく当たる
    this.lastHit = null;
    this.stats = { hits: 0, cacheHits: 0, nearby: 0, boxed: 0, misses: 0 };
  }

  /** 収録されている県の数（47 揃っているかの確認用） */
  get prefectureCount() {
    return new Set(this.shapes.map((s) => s.id)).size;
  }

  /**
   * 座標がどの県か。海上・国外なら null。
   * @returns {string|null} 正式名（"栃木県" など）
   */
  locate(lng, lat) {
    if (this.lastHit && this.#inShape(this.lastHit, lng, lat)) {
      this.stats.cacheHits++;
      return this.lastHit.name;
    }
    for (const shape of this.shapes) {
      if (this.#inShape(shape, lng, lat)) {
        this.lastHit = shape;
        this.stats.hits++;
        return shape.name;
      }
    }
    // ポリゴンの外だった場合は一番近い県に寄せる。
    //
    // ⚠️ これが無いと海沿いの道と離島の道が丸ごと落ちる。
    // 県境データは 0.008度（約890m）まで間引いてあるので海岸線が内側に痩せており、
    // 海沿いの道路は簡単にポリゴンの外に出る。離島はさらに顕著で、
    // 奄美大島の中心（129.494, 28.378）ですらどのポリゴンにも入らなかった。
    const near = this.#nearest(lng, lat);
    if (near) {
      this.stats.nearby++;
      return near.name;
    }
    // 最後の受け皿。ポリゴンから消えた離島をここで拾う
    const boxed = this.#byBox(lng, lat);
    if (boxed) {
      this.stats.boxed++;
      return boxed;
    }
    this.stats.misses++;
    return null;
  }

  /** 県の矩形で当てる。重なる場合はコード順で先に当たった方 */
  #byBox(lng, lat) {
    for (const [id, latMin, latMax, lngMin, lngMax] of PREFECTURE_BOXES) {
      if (lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax) {
        return PREFECTURE_NAMES[id];
      }
    }
    return null;
  }

  /** 一番近いポリゴンを探す。遠すぎる（国外・外洋）なら null */
  #nearest(lng, lat, maxKm = 30) {
    // 緯度1度=111km。経度は緯度で縮む
    const lngScale = Math.cos((lat * Math.PI) / 180);
    const maxDeg = maxKm / 111;
    let best = null;
    let bestDist = Infinity;
    for (const shape of this.shapes) {
      // bbox からの距離で粗く弾いてから頂点を見る
      const dx = Math.max(shape.minLng - lng, 0, lng - shape.maxLng) * lngScale;
      const dy = Math.max(shape.minLat - lat, 0, lat - shape.maxLat);
      if (Math.hypot(dx, dy) > maxDeg || Math.hypot(dx, dy) > bestDist) continue;
      for (const [vlng, vlat] of shape.ring) {
        const d = Math.hypot((vlng - lng) * lngScale, vlat - lat);
        if (d < bestDist) { bestDist = d; best = shape; }
      }
    }
    return bestDist <= maxDeg ? best : null;
  }

  /**
   * 道路（点列）がどの県か。
   * 県境をまたぐ道路があるので、多数決ではなく「代表点＋端点」で決める。
   * 全部海上判定になったら null。
   */
  locatePolyline(points) {
    if (!points || points.length === 0) return null;
    const candidates = [
      points[Math.floor(points.length / 2)],
      points[0],
      points[points.length - 1],
      points[Math.floor(points.length / 4)],
      points[Math.floor((points.length * 3) / 4)],
    ];
    const votes = new Map();
    for (const [lng, lat] of candidates) {
      const name = this.locate(lng, lat);
      if (name) votes.set(name, (votes.get(name) || 0) + 1);
    }
    if (votes.size === 0) return null;
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  #inShape(shape, lng, lat) {
    return lng >= shape.minLng && lng <= shape.maxLng &&
           lat >= shape.minLat && lat <= shape.maxLat &&
           ringContains(shape.ring, lng, lat);
  }
}

module.exports = { PrefectureLocator, PREFECTURE_NAMES, isoCode };
