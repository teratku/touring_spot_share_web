"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const M = require("../lib/michiNoEki");
const { buildStations } = require("../buildMichiNoEki");

/**
 * 休憩に寄る道の駅（`lib/michiNoEki.js`）と、道の駅の一覧づくり（`buildMichiNoEki.js`）。
 *
 * ⚠️ 利用者の要望（2026-10-01）:「途中で道の駅によるモードあったらいいなー」。判断: 休憩の間隔で足す
 */

/** 北へまっすぐの線（点は [経度, 緯度]・約100m おき） */
const north = (lat0, lat1, lng = 139.0) => {
  const n = Math.max(2, Math.round(Math.abs(lat1 - lat0) * 1110));
  return Array.from({ length: n + 1 }, (_, k) => [lng, lat0 + ((lat1 - lat0) * k) / n]);
};
// 北へ約111km を 300分で走る（1分で約370m）
const ROUTE = north(35.0, 36.0);
const DURATION = 300 * 60;
/** 出発から `minutes` 分のあたり（緯度）に、経路から `offMeters` 東の道の駅 */
const stationAt = (name, minutes, offMeters = 200) => ({ name, lat: 35.0 + minutes / 300, lon: 139.0 + offMeters / 91_000 });

/** Valhalla の代わり。寄り道の距離（km）を道の駅の名前から決める */
function fakeAsk(extraKmByName, calls = []) {
  const shape = "_p~iF~ps|U_ulLnnqC";
  return async (body) => {
    calls.push(body);
    const st = body.locations[1];
    const name = Object.keys(extraKmByName).find((n) => Math.abs(stationLat[n] - st.lat) < 1e-9);
    // まっすぐ行く距離（経路の手前 → 先）。経路は北へまっすぐなので緯度の差から出す（`cumulative` と同じ係数）
    const direct = (Math.abs(body.locations[2].lat - body.locations[0].lat) * 111320) / 1000;
    return { trip: { summary: { length: direct + (extraKmByName[name] ?? 0) }, legs: [{ shape }, { shape }] } };
  };
}
const stationLat = {};
const stations = (...list) => { list.forEach((s) => { stationLat[s.name] = s.lat; }); return list; };

test("前の休憩から間隔ぶん走ったあたりの、寄り道の少ない道の駅に寄る（寄ったところから次を数える）", async () => {
  const st = stations(stationAt("A", 55), stationAt("B", 67), stationAt("C", 103), stationAt("C2", 131),
                      stationAt("D", 250), stationAt("E", 290));
  const out = await M.restStopsAlongRoute(ROUTE, { intervalMinutes: 60, durationSeconds: DURATION, stations: st,
    ask: fakeAsk({ A: 0.5, B: 0.3, C: 0.4, C2: 0.4, D: 0.2, E: 0.1 }) });
  // 60分 → A(55)（B の67分より目標に近い）→ ⚠️ A から数えて 115 → C(103)（C2 の131分より近い。60分から数えると C2 になる）
  // → 163 のまわりに無い（C2 は 103+30=133 より前）→ その先の D(250)。E は着く20分前より後
  assert.deepStrictEqual(out.map((o) => o.name), ["A", "C", "D"], "選び方が違う（次の休憩を寄ったところから数えていない？）");
  assert.ok(Math.abs(out[0].atSeconds - 55 * 60) < 60, `着く時刻が違う: ${out[0].atSeconds}`);
  assert.strictEqual(out[0].extraMeters, 500);
  assert.ok(Array.isArray(out[0].stop) && out[0].stop.length === 2, "立ち寄り先に足す点を返していない");
});

test("遠回りが3km 以上の道の駅には寄らず、次に近い道の駅を試す", async () => {
  const st = stations(stationAt("近いが遠回り", 60), stationAt("少しずれるが寄れる", 66));
  const calls = [];
  const out = await M.restStopsAlongRoute(ROUTE, { intervalMinutes: 60, durationSeconds: DURATION, stations: st,
    ask: fakeAsk({ "近いが遠回り": 3.2, "少しずれるが寄れる": 2.9 }, calls) });
  assert.deepStrictEqual(out.map((o) => o.name), ["少しずれるが寄れる"]);
  assert.strictEqual(calls.length, 2, "目標に近い順に試していない");
  assert.strictEqual(M.MAX_EXTRA_METERS, 3000);
});

test("目標の前後に無ければ範囲を広げ、それでも無ければその先で最初に寄れる駅にする", async () => {
  // 目標60分のまわりに無い。1.25倍（75分）までにも無い → 1.5倍（90分）までの 88分 → 次の目標148分のまわりに無い → その先の 240分
  const st = stations(stationAt("P", 88), stationAt("Q", 240), stationAt("早すぎる", 20));
  const out = await M.restStopsAlongRoute(ROUTE, { intervalMinutes: 60, durationSeconds: DURATION, stations: st,
    ask: fakeAsk({ P: 0.1, Q: 0.1, "早すぎる": 0.1 }) });
  assert.deepStrictEqual(out.map((o) => o.name), ["P", "Q"], "範囲を広げていない／早すぎる駅に寄った");
  assert.deepStrictEqual([M.WINDOW_EARLY, M.WINDOW_LATE, M.WINDOW_LATER], [0.5, 1.25, 1.5]);
});

test("おすすめ道路を走っている途中・経路から離れた・着く直前の道の駅には寄らない", async () => {
  const onRoad = stationAt("道の途中", 60);
  const far = stationAt("離れている", 120, 2000);       // 経路から2km
  const late = stationAt("着く直前", 290);
  const st = stations(onRoad, far, late);
  const index = Math.round((onRoad.lat - 35.0) * 1110);
  const out = await M.restStopsAlongRoute(ROUTE, { intervalMinutes: 60, durationSeconds: DURATION, stations: st,
    excludedRanges: [[index - 50, index + 50]], ask: fakeAsk({ "道の途中": 0, "離れている": 0, "着く直前": 0 }) });
  assert.deepStrictEqual(out, [], `寄ってはいけない道の駅に寄った: ${out.map((o) => o.name)}`);
  assert.deepStrictEqual([M.NEAR_METERS, M.MIN_TAIL_SECONDS], [1500, 1200]);
});

test("指示ごとの時刻があれば、距離ではなくそれで休憩の時刻を決める", () => {
  const cum = require("../lib/sapa").cumulative(ROUTE);
  // 前半（半分の距離）に240分かかり、後半は60分
  const half = Math.floor(ROUTE.length / 2);
  const secs = M.timeline(ROUTE, cum, DURATION, [[half, 240 * 60]]);
  assert.ok(Math.abs(secs[half] - 240 * 60) < 1, "指示の時刻を使っていない");
  assert.ok(Math.abs(secs[Math.floor(half / 2)] - 120 * 60) < 60, "指示の間を距離で割り振っていない");
  const even = M.timeline(ROUTE, cum, DURATION, []);
  assert.ok(Math.abs(even[half] - 150 * 60) < 60, "時刻が無いときに距離で割り振っていない");
});

// MARK: 道の駅の一覧づくり

const feature = (name, props, geometry) => ({ properties: { name, ...props }, geometry });
const point = (lat, lon) => ({ type: "Point", coordinates: [lon, lat] });

test("一覧づくり: 交差点・バス停を外し、敷地の近くの付属施設は同じ駅にまとめ、同じ名前でも離れていれば別の駅", () => {
  const out = buildStations([
    feature("道の駅しもにた", { highway: "services" }, point(36.2243, 138.8026)),
    feature("道の駅しもにた 物産館", { building: "yes" }, point(36.2253, 138.8030)),     // 約120m
    feature("道の駅入口", { highway: "traffic_signals" }, point(36.22, 138.80)),
    feature("道の駅しもにた", { highway: "bus_stop" }, point(36.2244, 138.8027)),
    feature("道の駅みかわ", { highway: "services" }, point(36.40, 136.50)),               // 石川
    feature("道の駅みかわ", { highway: "services" }, point(33.80, 132.90)),               // 愛媛
    feature("道の駅前", { amenity: "parking" }, point(35.0, 139.0)),
    // ⚠️ 名前の終わりで見分ける（駐車場の地物でも、交差点の名前なら駅ではない）
    feature("道の駅しもにた入口", { amenity: "parking" }, point(36.30, 138.90)),
  ]);
  assert.deepStrictEqual(out.map((s) => s[2]).sort(), ["道の駅しもにた", "道の駅みかわ", "道の駅みかわ"]);
});

test("配信する一覧: 実データから作った道の駅が千駅を超え、名前と位置がそろっている", () => {
  const file = path.join(__dirname, "..", "data", "michinoeki.json");
  const { stations: list } = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(list.length > 1000, `少なすぎる: ${list.length}`);
  assert.ok(list.every(([lat, lon, name]) => lat > 20 && lat < 46 && lon > 122 && lon < 154 && name.startsWith("道の駅")));
  assert.ok(list.some(([, , name]) => name === "道の駅しもにた"), "材料が悪い（しもにたが無い）");
});

// MARK: 実際の経路で

const { BASE } = require("../lib/valhallaRoute");
async function up() {
  try { return (await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) })).ok; } catch (e) { return false; }
}

test("実際の経路: 新座→長野原→渋川→赤城大沼（125cc以下）で、60分ごとに寄り道3km 未満の道の駅を選ぶ（Valhalla）", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  const { routeWithValhallaSegmented } = require("../lib/segmentedRoute");
  const { routeOptionsFromBody } = require("../../service/lib/buildRoute");
  const from = [139.57398429344204, 35.79681815622602];
  const vias = [[138.68447833333335, 36.547171666666664], [139.07755, 36.51429]];
  const to = [139.184589469935, 36.54828517235494];
  const opts = routeOptionsFromBody({ from, to, vias, stopAt: [0, 1], displacement: "small125", avoidTolls: true,
    avoidHighways: true, arriveOnNearSide: true }, { restrictionsFor: async () => ({ restrictions: [], prefectures: [] }) });
  const route = await routeWithValhallaSegmented(from, to, opts);
  assert.ok(!route.error, route.error);
  let at = 0;
  const stepTimes = route.steps.map((s) => [s.endIndex, (at += s.durationSeconds || 0)]);
  const out = await M.restStopsAlongRoute(route.points, { intervalMinutes: 60, durationSeconds: route.durationSeconds,
    stepTimes, costing: "motor_scooter", baseUrl: BASE });
  assert.ok(out.length >= 2, `休憩が少なすぎる: ${out.map((o) => o.name)}`);
  assert.ok(out.every((o) => o.extraMeters < 3000), "遠回りが大きい");
  assert.ok(out.every((o, i) => i === 0 || o.atSeconds - out[i - 1].atSeconds >= 30 * 60), "休憩が詰まりすぎ");
  assert.ok(out.at(-1).atSeconds < route.durationSeconds - 20 * 60, "着く直前に休憩した");
});
