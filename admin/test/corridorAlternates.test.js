"use strict";
const test = require("node:test");
const assert = require("node:assert");
const C = require("../lib/corridorAlternates");

/**
 * 道筋の違う候補（`lib/corridorAlternates.js`）。
 *
 * ⚠️ 利用者の要望（2026-09-28）:「ルート生成で google map みたいなルートも生成できるといいな。
 *    現状254号線以降は全く違いがない」。判断: 候補画面の「別の道筋を探す」を押したときだけ探す
 */

/** 北へまっすぐの線（点は [経度, 緯度]・約100m おき） */
const north = (lng, lat0, lat1) => {
  const n = Math.max(2, Math.round(Math.abs(lat1 - lat0) * 1110));
  return Array.from({ length: n + 1 }, (_, k) => [lng, lat0 + ((lat1 - lat0) * k) / n]);
};
const lengthOf = (pts) => {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += Math.hypot((pts[i][0] - pts[i - 1][0]) * 91_000, (pts[i][1] - pts[i - 1][1]) * 111_000);
  return m;
};
const route = (points, minutes, extra = {}) => ({ points, lengthMeters: lengthOf(points), durationSeconds: minutes * 60, uTurns: 0, ...extra });

// 本命: 経度139.0を北へ（約111km）
const MAIN = route(north(139.0, 35.0, 36.0), 100);
/** 本命と `from`〜`to`（緯度）だけ東へ1km 離れて並んで走る線 */
const detour = (from, to) => [
  ...north(139.0, 35.0, from),
  ...north(139.011, from, to),
  ...north(139.0, to, 36.0),
];

test("横へずらす点は、本命の50・65・80% から左右に10・15km（前半は Valhalla の代替に任せる）", () => {
  assert.deepStrictEqual(C.FRACTIONS, [0.5, 0.65, 0.8], "ずらす地点が違う");
  assert.deepStrictEqual(C.OFFSETS_KM, [10, 15], "ずらす距離が違う");
  const pts = C.offsetPoints(MAIN.points);
  assert.strictEqual(pts.length, 12);
  const west10 = pts.find((p) => p.frac === 0.5 && p.side === -1 && p.km === 10);
  assert.ok(Math.abs(west10.point[1] - 35.5) < 0.01, `本命の半分の所からずらしていない: ${west10.point}`);
  assert.ok(Math.abs((139.0 - west10.point[0]) * 91_000 - 10_000) < 300, `10km 西にずらしていない: ${west10.point}`);
  const east15 = pts.find((p) => p.frac === 0.8 && p.side === 1 && p.km === 15);
  assert.ok(Math.abs(east15.point[1] - 35.8) < 0.01 && Math.abs((east15.point[0] - 139.0) * 91_000 - 15_000) < 400,
    `80% の所から15km 東にずらしていない: ${east15.point}`);
});

test("離れて走る一番長い区間と、それが道のりのどこで終わるか", () => {
  const late = C.longestAway(detour(35.5, 36.0), MAIN.points);
  assert.ok(Math.abs(late.meters - 55_500) < 3_000, `後半の離れた区間の長さが違う: ${late.meters}`);
  assert.ok(late.endShare > 0.95, `ゴール寄りまで離れているのに終わりが手前: ${late.endShare}`);
  const early = C.longestAway(detour(35.1, 35.5), MAIN.points);
  assert.ok(early.endShare > 0.45 && early.endShare < 0.55, `中ほどで本命に戻るのに終わりが違う: ${early.endShare}`);
  assert.strictEqual(C.longestAway(MAIN.points, MAIN.points).meters, 0, "同じ線なのに離れていると数えた");
});

test("時間が1.25倍を超える・Uターンが多い・離れて走る区間が2割未満の案は選ばない", () => {
  const ok = { route: route(detour(35.5, 36.0), 110), via: [139.0, 35.7] };
  const slow = { route: route(detour(35.5, 36.0), 126), via: [139.0, 35.7] };
  const uturn = { route: route(detour(35.5, 36.0), 105, { uTurns: 1 }), via: [139.0, 35.7] };
  const tiny = { route: route(detour(35.5, 35.6), 101), via: [139.0, 35.55] };
  const broken = { route: { error: "No path" }, via: [139.0, 35.5] };
  const picked = C.pickDistinct(MAIN, [slow, uturn, tiny, broken, ok]);
  assert.deepStrictEqual(picked.map((p) => p.route.durationSeconds), [110 * 60], "外すべき案を選んだ／選ぶべき案を落とした");
  assert.deepStrictEqual([C.MAX_TIME_RATIO, C.MIN_AWAY_SHARE], [1.25, 0.2], "しきい値が違う");
  assert.ok(picked[0].awayMeters > 50_000 && picked[0].awayEndShare > 0.95, "離れて走る区間を返していない");
});

test("ゴール寄りまで別の道を走る案を先に、似た案は1本に、最大2本", () => {
  // 早く戻る速い案・ゴール寄りまで別の遅い案・それとほぼ同じ案・別の後半案
  const earlyFast = { route: route(detour(35.1, 35.5), 101), via: 1 };
  const lateSlow = { route: route(detour(35.5, 36.0), 115), via: 2 };
  const lateTwin = { route: route(detour(35.5, 36.0), 116), via: 3 };
  const lateOther = { route: route([...north(139.0, 35.0, 35.4), ...north(138.989, 35.4, 36.0)], 118), via: 4 };
  const picked = C.pickDistinct(MAIN, [earlyFast, lateTwin, lateSlow, lateOther]);
  assert.deepStrictEqual(picked.map((p) => p.via), [2, 4], "並べ方か、似た案の除き方が違う");
  assert.strictEqual(C.MAX_RESULTS, 2);
});

test("本命を引き、ずらした点を幹線に乗せて、通るだけの点として引く（同時に4本まで）", async () => {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const routeFn = async (from, to, opts) => {
    calls.push(opts);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (!opts.vias || !opts.vias.length) return { ...MAIN, costing: "motorcycle" };
    return route(detour(35.5, 36.0), 110);
  };
  const located = [];
  const locateFn = async (p, costing) => { located.push(costing); return located.length % 3 === 0 ? null : [p[0], p[1]]; };
  // ⚠️ 本命の条件に止まる場所があっても、ずらした点は「通るだけ」にする
  const out = await C.corridorAlternates([139.0, 35.0], [139.0, 36.0],
    { vias: [], stopAt: [0], throughStopAt: [0], avoidTolls: true }, { routeFn, locateFn });
  assert.strictEqual(located.length, 12, "ずらした点を全部幹線に乗せていない");
  assert.ok(located.every((c) => c === "motorcycle"), "本命と違う乗り物で幹線を探した");
  const viaCalls = calls.filter((o) => o.vias && o.vias.length);
  assert.strictEqual(viaCalls.length, 8, "幹線に乗らなかった点まで引いた（または引いていない）");
  assert.ok(viaCalls.every((o) => o.stopAt.length === 0 && o.throughStopAt.length === 0 && o.avoidTolls === true),
    "止まる点にした／条件を引き継いでいない");
  assert.ok(maxInFlight <= C.CONCURRENCY && C.CONCURRENCY === 4, `同時に ${maxInFlight} 本引いた`);
  assert.strictEqual(out.tried, 8);
  assert.strictEqual(out.alternates.length, 1, "似た案を1本にまとめていない");
});

test("本命が引けなければ、何も探さない（線が付いていても）", async () => {
  let n = 0, located = 0;
  const out = await C.corridorAlternates([139.0, 35.0], [139.0, 36.0], {},
    { routeFn: async () => { n++; return { ...MAIN, error: "No path" }; }, locateFn: async () => { located++; return [0, 0]; } });
  assert.strictEqual(n, 1, "本命が無いのに探した");
  assert.strictEqual(located, 0, "本命が無いのに幹線を探した");
  assert.deepStrictEqual(out.alternates, []);
});

// MARK: 実際の経路で

const { BASE } = require("../lib/valhallaRoute");
async function up() {
  try { return (await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) })).ok; } catch (e) { return false; }
}

test("実際の経路: 赤城大沼→新座（251cc以上）で、後半を国道17号で走る案が出る（Valhalla）", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  const { routeWithValhallaSegmented } = require("../lib/segmentedRoute");
  const { routeOptionsFromBody } = require("../../service/lib/buildRoute");
  const { distanceToLine } = require("../lib/restrictionOverlap");
  const from = [139.184589, 36.548285], to = [139.573984, 35.796818];
  const opts = routeOptionsFromBody({ from, to, displacement: "large", arriveOnNearSide: true, avoidTolls: true, avoidHighways: true },
    { restrictionsFor: async () => ({ restrictions: [], prefectures: [] }) });
  const out = await C.corridorAlternates(from, to, opts, { routeFn: routeWithValhallaSegmented, locateFn: C.makeLocate(BASE) });
  const AGEO = [139.593, 35.977];   // 国道17号・上尾
  const KAWAGOE = [139.485, 35.925]; // 国道254号・川越
  assert.ok(distanceToLine(KAWAGOE, out.main.points) < 1500, "材料が悪い（本命が254号・川越を通らない）");
  const via17 = out.alternates.find((a) => distanceToLine(AGEO, a.route.points) < 1500);
  assert.ok(via17, `17号・上尾を通る案が無い: ${out.alternates.map((a) => `+${Math.round(100 * (a.timeRatio - 1))}%`).join(", ")}`);
  assert.ok(via17.timeRatio <= 1.25);
});

// MARK: 調整ツールの画面と窓口

const fs = require("fs");
const path = require("path");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("窓口: アプリと同じ条件（避ける規制の範囲・画面で変えた数値）で探し、立ち寄り先があれば探さない", () => {
  const server = read("server.js");
  const at = server.indexOf('app.post("/api/valhalla/corridors"');
  assert.ok(at > 0, "窓口が無い");
  const body = server.slice(at, server.indexOf("\n});", at));
  assert.ok(body.includes("{ restrictionsFor: restrictionsForScope(restrictionScope, includeUnverified) });"), "画面の規制の範囲で引いていない");
  assert.ok(body.includes("const routeFn = (f, t, o) => routeWithValhallaSegmented(f, t, { ...o, tuning });"), "画面で変えた数値を重ねていない");
  assert.ok(body.includes('if ((opts.vias || []).length) return res.json({ routes: [], skipped: "stops" });'), "立ち寄り先があっても探す");
  assert.ok(body.includes("await corridorAlternates(from, to, { ...opts, alternates: 0 },"), "本命に代替まで頼んでいる");
});

test("画面: 引いたときと同じ条件で探し、引き終えるまでは押せない", () => {
  const html = read("public", "valhalla.html");
  assert.ok(html.includes("state.lastBike = bike;"), "引いたときの条件を控えていない");
  assert.ok(html.includes('body:JSON.stringify({ from:state.from, to:state.to, vias:[], variant:"normal", ...state.lastBike }) });'),
    "引いたときと違う条件で探している");
  assert.ok(html.includes('document.getElementById("corridorRun").onclick = corridorRun;'), "ボタンを押しても何も起きない");
  assert.ok(html.includes('document.getElementById("run").disabled = false; document.getElementById("corridorRun").disabled = false;'),
    "引き終えても押せない");
  assert.ok(html.includes('// ⚠️ 地点が変わったら、引き直すまで探させない（前の条件で探すことになる）\n  document.getElementById("corridorRun").disabled = true;'),
    "地点を変えても前の条件のまま押せる");
});
