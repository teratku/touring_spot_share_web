/**
 * sapa.js
 *
 * **経路から寄れる高速の SA/PA** を並べる（アプリの「SA/PA の一覧」「次の SA/PA まで」）。
 * 設計と実測は app repo `docs/sapa-plan.md`。
 *
 * 利用者の要望（2026-09-26）: 走行中に次の SA/PA までの距離・経路の上の SA/PA を一覧にして立ち寄れる・
 * ガソリンスタンドの有無。ガソリンスタンドは OSM にある分だけ「あり」、無ければ「不明」（利用者の判断）。
 *
 * 【寄れるかの決め方】⚠️ **経路からの近さや左右では決められない。** 上り・下りの SA は本線をはさんで
 *   どちらも経路から 50〜200m。左右で見ると新東名の静岡SA（下り）が右に出る・上下線から入れる PA がある。
 *   **実際に引いて確かめる**: 経路の 2km 手前 → 敷地の中 → 2km 先を引き、遠回りが 1.5km 未満で
 *   スマートICを通らなければ寄れる。
 *   実測（8本・107件）: 名前が自分の向きの 49件中 47件を拾い、反対の向き 49件は 0件（取り違え無し）。
 *   寄れる向きの遠回りはほぼ 0.0〜0.1km、反対側は最小でも +9.3km。
 * ⚠️ **スマートIC経由は寄れないとみなす。** 反対側の SA でも、スマートICで一般道へ出て回り込めば
 *   +2.4km で着く（足柄SA）。
 * ⚠️ **敷地の中心だけで試さない。** 中心がドライブスルーの車線に吸い付き、スマートICから出入りする
 *   遠回りになることがある（談合坂SA（上り）: 中心 +3.7km、ほかの点 +0.1〜0.3km）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const smartIcGates = require("./smartIcGates");

const FILE = path.join(__dirname, "..", "data", "sapa.json");

//: SA/PA とみなす名前。⚠️ 名前の無い敷地・道の駅・歩いて入る口（ウォークインゲート）は入れない
//: ⚠️ **大文字小文字を区別すること。** 区別しないと「Sapporo」の Sa を SA とみなす（占冠PA のバス停）
const SAPA_NAME = /SA|PA|サービスエリア|パーキングエリア|ハイウェイオアシス/;
const NOT_SAPA = /道の駅|ウォークイン|ゲート/;
//: 向きのある名前
const DIRECTION = /上り|下り|内回り|外回り|[東西南北]行き/;

//: 経路からこの距離（m）の敷地を候補にする。実測で寄れる SA/PA は経路から 35〜260m
const NEAR_METERS = 350;
//: 寄れるかを確かめる区間（経路の手前と先、m）
const WINDOW_METERS = 2000;
//: これ未満の遠回り（m）なら寄れる。実測で寄れる向きは最大 1.4km、反対側は最小 9.3km
const MAX_EXTRA_METERS = 1500;
//: これ以上の遠回り（m）なら反対側とみなして、ほかの点を試さない
const OPPOSITE_METERS = 8000;
//: 同時に引く数（Cloud Run の中の Valhalla を詰まらせない）
const CONCURRENCY = 4;
const TIMEOUT_MS = 15_000;

function meters(lat1, lon1, lat2, lon2) {
  const k = Math.cos((lat1 * Math.PI) / 180) * 111320;
  return Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * k);
}

function isSapaName(name) {
  const s = String(name || "").normalize("NFKC");
  return SAPA_NAME.test(s) && !NOT_SAPA.test(s);
}

/** SA か PA か。名前を先に見る（`highway=services` の PA が多い） */
function kindOf(name, highway) {
  const s = String(name || "").normalize("NFKC");
  if (/PA|パーキングエリア/i.test(s)) return "PA";
  if (/SA|サービスエリア/i.test(s)) return "SA";
  return highway === "rest_area" ? "PA" : "SA";
}

/** 点が輪（[[経度, 緯度], ...]）の中か */
function pointInRing(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 輪の広さ（度の2乗。比べるだけ） */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = (ring || []).length - 1; i < (ring || []).length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) / 2;
}

const directionOf = (name) => (String(name || "").match(DIRECTION) || [null])[0];

/**
 * 重なった SA/PA を1つにする。
 * - **ほかの敷地の中心を含む、それより大きい敷地**を落とす。⚠️「佐野サービスエリア」（上下線をまとめた敷地）が
 *   「佐野SA（上り）」「佐野SA（下り）」を含む。大きい方を残すと上り・下りの区別が消え、反対側の SA まで出る。
 *   ⚠️ 「中心を含む」だけで落とさないこと。まとめた敷地の中心が「佐野SA（上り）」の中に落ち、上りを落としていた
 * - **向きの違う2つは両方残す**（京橋PA（上り）の敷地に京橋PA（下り）の中心が入る）
 * - **点だけの SA/PA は、囲む敷地があれば落とす**（同じ SA/PA を二重に数える）
 */
function dropUmbrellas(areas) {
  const hasRing = (x) => Array.isArray(x.ring) && x.ring.length >= 3;
  return areas.filter((a) => {
    if (!hasRing(a)) return !areas.some((b) => b !== a && hasRing(b) && pointInRing(a.lat, a.lon, b.ring));
    const size = ringArea(a.ring);
    return !areas.some((b) => {
      if (b === a || !hasRing(b) || !pointInRing(b.lat, b.lon, a.ring)) return false;
      const da = directionOf(a.name);
      const db = directionOf(b.name);
      if (da && db && da !== db) return false;
      return size > ringArea(b.ring);
    });
  });
}

/** 敷地の中にガソリンスタンドがあるか。⚠️ 無いときは「不明」（OSM に載っていないだけのことが多い） */
function fuelOf(area, fuels) {
  return (fuels || []).some(([lat, lon]) => pointInRing(lat, lon, area.ring)) ? "yes" : "unknown";
}

let cached = null;

/** 一覧を読む（1回だけ）。無ければ空（一覧を出さないだけ。経路は止めない） */
function load(file = FILE) {
  if (cached && cached.file === file) return cached.areas;
  let areas = [];
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    areas = (doc.areas || []).map(([lat, lon, kind, name, fuel, ring]) => ({
      lat, lon, kind, name, fuel: fuel ? "yes" : "unknown", ring: ring || [],
    }));
  } catch (e) {
    areas = [];
  }
  cached = { file, areas };
  return areas;
}

/** 線（[[経度, 緯度], ...]）の始まりからの距離（m） */
function cumulative(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + meters(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]));
  }
  return out;
}

/**
 * 経路のそばの SA/PA（候補）。経路のいちばん近い点の番号と、始まりからの距離を付ける。
 * ⚠️ 出発・到着から 2km 以内は確かめる区間が取れないので入れない
 */
function candidatesAlong(points, areas, cum = cumulative(points)) {
  const total = cum[cum.length - 1] || 0;
  const out = [];
  for (const area of areas || []) {
    let best = Infinity;
    let index = -1;
    for (let i = 0; i < points.length; i++) {
      const [lon, lat] = points[i];
      if (Math.abs(lat - area.lat) > 0.01 || Math.abs(lon - area.lon) > 0.012) continue;
      const d = meters(lat, lon, area.lat, area.lon);
      if (d < best) { best = d; index = i; }
    }
    if (index < 0 || best > NEAR_METERS) continue;
    if (cum[index] < WINDOW_METERS || total - cum[index] < WINDOW_METERS) continue;
    out.push({ area, index, alongMeters: Math.round(cum[index]) });
  }
  return out.sort((a, b) => a.alongMeters - b.alongMeters);
}

/**
 * 敷地の中で試す点（試す順）。中心 → 経路にいちばん近い端（少し内側）→ 敷地の内側の点。
 * ⚠️ 外接四角の点は使わない。隣り合う反対側の SA の敷地に落ちる（海老名SA）
 */
function trialPoints(area, routePoint) {
  const out = [{ lat: area.lat, lon: area.lon }];
  const ring = area.ring || [];
  if (ring.length < 3) return out;
  let nearest = null;
  let best = Infinity;
  for (const [lon, lat] of ring) {
    const d = meters(routePoint[1], routePoint[0], lat, lon);
    if (d < best) { best = d; nearest = [lon, lat]; }
  }
  out.push({ lat: nearest[1] * 0.75 + area.lat * 0.25, lon: nearest[0] * 0.75 + area.lon * 0.25 });
  const lats = ring.map((p) => p[1]);
  const lons = ring.map((p) => p[0]);
  const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  for (const [fy, fx] of [[0.3, 0.3], [0.3, 0.7], [0.7, 0.3], [0.7, 0.7], [0.5, 0.5]]) {
    const p = { lat: s + (n - s) * fy, lon: w + (e - w) * fx };
    if (pointInRing(p.lat, p.lon, ring)) out.push(p);
  }
  return out;
}

/**
 * 1回の試しの判定。遠回り（m）とスマートICを通ったかから「寄れる」「反対側」「分からない（次を試す）」。
 * ⚠️ スマートIC経由は寄れない（反対側の SA でも一般道へ出て回り込めば着く）。
 *    ⚠️ ただし反対側とも決めない（中心がスマートIC側の道に吸い付いただけのことがある）
 */
function judge(extraMeters, viaSmartIc) {
  if (!Number.isFinite(extraMeters)) return "unknown";
  if (viaSmartIc) return "unknown";
  if (extraMeters < MAX_EXTRA_METERS) return "reachable";
  if (extraMeters >= OPPOSITE_METERS) return "opposite";
  return "unknown";
}

function decode6(text) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < text.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, byte;
      do {
        byte = text.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    points.push([lng / 1e6, lat / 1e6]);
  }
  return points;
}

/**
 * その SA/PA に寄れるか。寄れるなら、立ち寄り先に足す点（SA/PA の中の道の上）を返す。
 * @param ask (body) => Valhalla の応答
 */
async function checkReachable(points, cum, cand, { ask, costing, gates }) {
  let i0 = cand.index;
  while (i0 > 0 && cum[cand.index] - cum[i0] < WINDOW_METERS) i0--;
  let i1 = cand.index;
  while (i1 < points.length - 1 && cum[i1] - cum[cand.index] < WINDOW_METERS) i1++;
  const direct = cum[i1] - cum[i0];
  const loc = ([lon, lat]) => ({ lat, lon });
  for (const [k, p] of trialPoints(cand.area, points[cand.index]).entries()) {
    const body = {
      locations: [loc(points[i0]),
        // ⚠️ SA/PA の中の道に寄せる。寄せないと本線に吸い付いて、寄ったことにならない
        { lat: p.lat, lon: p.lon, type: "break", search_filter: { max_road_class: "service_other" } },
        loc(points[i1])],
      costing,
      directions_type: "none",
    };
    let json;
    try { json = await ask(body); } catch (e) { json = null; }
    if (!json || !json.trip || !Array.isArray(json.trip.legs) || json.trip.legs.length < 2) continue;
    const legs = json.trip.legs.map((l) => decode6(l.shape || ""));
    const all = legs.flat();
    const extra = (json.trip.summary.length || 0) * 1000 - direct;
    const verdict = judge(extra, smartIcGates.gatesOnRoute(all, gates).length > 0);
    if (verdict === "reachable") {
      // ⚠️ 足す点は、寄ると確かめた点が吸い付いた先（区間の切れ目）。中心を返すと本線に吸い付く
      const stop = legs[0][legs[0].length - 1];
      return { ok: true, extraMeters: Math.round(extra), stop: [Number(stop[0].toFixed(6)), Number(stop[1].toFixed(6))] };
    }
    if (verdict === "opposite" && k >= 1) break;      // 反対側。これ以上試さない
  }
  return { ok: false };
}

/**
 * 経路から寄れる SA/PA を経路の順に返す。
 * @param points 経路の線 [[経度, 緯度], ...]
 * @param opts { baseUrl, costing, fetch, areas, gates }
 */
async function sapaAlongRoute(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const areas = opts.areas || load();
  const gates = opts.gates || smartIcGates.load();
  const fetchImpl = opts.fetch || globalThis.fetch;
  const base = opts.baseUrl || process.env.VALHALLA_URL || "http://localhost:8002";
  const ask = async (body) => {
    const res = await fetchImpl(`${base}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.json();
  };
  const cum = cumulative(points);
  const cands = candidatesAlong(points, areas, cum);
  const results = new Array(cands.length);
  let next = 0;
  const worker = async () => {
    while (next < cands.length) {
      const i = next++;
      results[i] = await checkReachable(points, cum, cands[i], { ask, costing: opts.costing || "motorcycle", gates });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cands.length) }, worker));
  const out = [];
  for (const [i, c] of cands.entries()) {
    if (!results[i] || !results[i].ok) continue;
    // ⚠️ 同じ名前が続けて出たら1つにする（敷地が分かれて描かれていることがある）
    const prev = out[out.length - 1];
    if (prev && prev.name === c.area.name && c.alongMeters - prev.alongMeters < 1000) continue;
    out.push({ name: c.area.name, kind: c.area.kind, fuel: c.area.fuel,
               alongMeters: c.alongMeters, stop: results[i].stop });
  }
  return out;
}

module.exports = {
  isSapaName, kindOf, pointInRing, ringArea, dropUmbrellas, fuelOf, load, cumulative, candidatesAlong,
  trialPoints, judge, checkReachable, sapaAlongRoute, decode6,
  NEAR_METERS, WINDOW_METERS, MAX_EXTRA_METERS, OPPOSITE_METERS, FILE,
};
