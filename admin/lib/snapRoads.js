/**
 * admin/lib/snapRoads.js
 *
 * **なぞった線を道路に載せる**（Valhalla の map matching）。
 *
 * アプリの「なぞる」は、指で描いた点を経由地にする。道路の上に無い点をそのまま
 * 渡すと、最寄りの別の道（側道・裏道）へ寄るための「行って戻る」が出る。
 * 先に道路へ載せてから経由地を選ぶ（もとは Google の Roads API でやっていた）。
 *
 * 【実測】（2026-09-17・手元の Valhalla。8コースの実在の道を指のずれ A m でなぞった線）
 *   A=100m  生の座標: 正解の道からのずれ 中央60m・遠回り21.8%・Uターン0.9回
 *           載せる   :                  中央30m・遠回り18.6%・Uターン0.3回
 *   A=250m  生の座標: 中央109m・遠回り28.4%・Uターン1.4回
 *           載せる   : 中央 43m・遠回り22.5%・Uターン0.5回（載らない点は捨てる）
 *   道と無関係な自由曲線（6区間×2）: 生の座標 中央1,876m・Uターン3.7回・1件引けず
 *                                     載せる   中央1,569m・Uターン2.8回・全件引けた
 *
 * ⚠️ **載らなかった点は null で返す**（捨てるかどうかはアプリが決める）。
 *    残して生の座標を経由地にするより、捨てたほうが上の実測で良かった。
 * ⚠️ **探索半径は 100m が上限**（`service_limits.trace.max_search_radius`）。
 *    広げるには valhalla.json を直してタイルのイメージを作り直す必要がある。
 */
"use strict";

const { DISPLACEMENTS, BASE } = require("./valhallaRoute");

/** 点から道路を探す半径（m）。⚠️ 配信側の上限が 100 */
const SNAP_SEARCH_RADIUS = 100;
/**
 * 点の位置の誤差（m）。指で描いた線は GPS よりずっと粗い。
 * ⚠️ 実測で 50 と 100 の差は無かった。既定の 5 だと、ずれ 100m の線で 103点中17点が載らなかった
 */
const SNAP_GPS_ACCURACY = 50;
/** 1回に載せる点の数の上限。アプリも100点ずつに区切って送る */
const MAX_SNAP_POINTS = 100;
/**
 * **どこにも載らなかった**ことを表す Valhalla の番号。失敗ではなく「全部 null」として返す。
 * ⚠️ 実測: 海の上だけ・山の中だけの線は 444 で返る
 *   171 近くに道が無い / 442 経路が無い / 443・444 道筋を合わせられない
 */
const NO_MATCH_CODES = new Set([171, 442, 443, 444]);

/**
 * 点の並びを道路に載せる。
 *
 * @param {Array<[number, number]>} points [経度, 緯度] の並び（2〜100点）
 * @param {{ displacement?: string, baseUrl?: string, fetch?: Function }} opts
 * @returns {Promise<{ points: Array<[number, number] | null> }>} 入力と同じ数・同じ並び
 */
async function snapToRoads(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_SNAP_POINTS) {
    throw new Error(`点は2〜${MAX_SNAP_POINTS}個で渡すこと（${Array.isArray(points) ? points.length : "配列でない"}）`);
  }
  // ⚠️ **排気量で costing を選ぶ。** 経路と同じ道の網で載せないと、
  //    原付が走れない高速の上に載せてしまう
  const bike = DISPLACEMENTS[opts.displacement];
  const body = {
    shape: points.map(([lon, lat]) => ({ lat, lon })),
    costing: bike ? bike.costing : "motorcycle",
    shape_match: "map_snap",
    trace_options: { search_radius: SNAP_SEARCH_RADIUS, gps_accuracy: SNAP_GPS_ACCURACY },
    filters: { attributes: ["matched.point", "matched.type"], action: "include" },
  };
  const doFetch = opts.fetch || fetch;
  const res = await doFetch(`${opts.baseUrl || BASE}/trace_attributes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (NO_MATCH_CODES.has(json.error_code)) return { points: points.map(() => null) };
    throw new Error(json.error || `道路に載せられません（${res.status}）`);
  }
  const matched = json.matched_points || [];
  // ⚠️ **数が合わないときは使わない。** 並びがずれると別の場所の点を経由地にする
  if (matched.length !== points.length) {
    throw new Error(`載せた点の数が合いません（${matched.length}/${points.length}）`);
  }
  return {
    points: matched.map((m) => (m.type === "unmatched"
      || !Number.isFinite(m.lon) || !Number.isFinite(m.lat)
      ? null : [m.lon, m.lat])),
  };
}

module.exports = { snapToRoads, SNAP_SEARCH_RADIUS, SNAP_GPS_ACCURACY, MAX_SNAP_POINTS, NO_MATCH_CODES };
