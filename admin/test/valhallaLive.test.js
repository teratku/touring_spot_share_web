"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { routeWithValhalla, BASE } = require("../lib/valhallaRoute");

/**
 * 実際に動いている Valhalla に繋ぐ確認。
 *
 * ⚠️ **Valhalla が居ないときは飛ばす。** 他のテストを巻き込まないこと。
 *    立ち上げ方:
 *      docker run -d --name valhalla-jp -p 8002:8002 valhalla-jp-cloudrun:latest
 */
async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}
const skipIfDown = async (t) => (await up()) ? false : t.skip(`Valhalla が居ない（${BASE}）`);

//: 甲府 → 富士吉田。ほかのテストや文書と同じ2点で揃える
const KOFU = [138.5684, 35.6642];
const FUJI = [138.8087, 35.4876];

test("線と曲がる指示の両方が返る", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI);
  assert.ok(!r.error, r.error);
  // ⚠️ 自前探索との違いがここ。線だけなら roadRoute.js で足りる
  assert.ok(r.steps.length > 5, `曲がる指示が ${r.steps.length} 個しかない`);
  assert.ok(r.points.length > 100, `線の点が ${r.points.length} 個しかない`);
  assert.ok(r.steps.every((s) => s.maneuver), "maneuver が空の指示がある");
});

test("線は指した両端から始まって終わる", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI);
  const m = (a, b) => Math.hypot((b[1] - a[1]) * 110574, (b[0] - a[0]) * 90527);
  assert.ok(m(KOFU, r.points[0]) < 500,
            `始まりが ${Math.round(m(KOFU, r.points[0]))}m 離れている`);
  assert.ok(m(FUJI, r.points[r.points.length - 1]) < 500,
            `終わりが ${Math.round(m(FUJI, r.points[r.points.length - 1]))}m 離れている`);
});

test("点は日本の中に収まる（精度の取り違えが起きていない）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 6桁を5桁として解くと10倍ずれ、必ずここで捕まる
  const r = await routeWithValhalla(KOFU, FUJI);
  const outside = r.points.filter(([lng, lat]) =>
    !(lat > 24 && lat < 46 && lng > 122 && lng < 154));
  assert.strictEqual(outside.length, 0,
    `${outside.length}点が日本の外。最初の1点: ${JSON.stringify(outside[0])}`);
});

test("経由地を通すと大きく遠回りになる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **遠回りを作っているのは経由地。** costing の重みではない（実測で確認済み）
  const plain = await routeWithValhalla(KOFU, FUJI);
  const via = await routeWithValhalla(KOFU, FUJI, {
    vias: [[138.669922, 35.712639], [138.576882, 35.685643]],   // 甲府山梨線の両端
  });
  assert.ok(!via.error, via.error);
  assert.ok(via.lengthMeters > plain.lengthMeters * 1.5,
    `経由させても ${(plain.lengthMeters/1000).toFixed(1)}km → `
    + `${(via.lengthMeters/1000).toFixed(1)}km にしかならない`);
});

test("経由地を通してもUターンが出ない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **これが Google から乗り換える一番の理由。**
  //    いまは Uターンが出るたび最大5回引き直している
  //    （RouteCandidatesView.swift:442 maxFunRouteUTurnRetries = 5）
  const via = await routeWithValhalla(KOFU, FUJI, {
    vias: [[138.669922, 35.712639], [138.576882, 35.685643]],
  });
  assert.strictEqual(via.uTurns, 0, `Uターンが ${via.uTurns} 回出ている`);
});

/**
 * ⚠️ **Uターンの数え方が合っていること。** 「0回だった」を報告する以上、
 *    出るときにちゃんと数えられないと意味がない。
 *    材料は、同じあたりを往復させて実際にUターンが出る組（実測3回）。
 */
test("Uターンが出るときは、ちゃんと数える", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI, {
    vias: [[138.60, 35.68], [138.62, 35.69], [138.60, 35.68]],
  });
  assert.ok(!r.error, r.error);
  assert.ok(r.uTurns > 0, "Uターンが出る組なのに0回と数えている");
  // 指示の中身とも合っていること（数だけ別に作っていないこと）
  const actual = r.steps.filter((x) => x.maneuver.startsWith("uturn")).length;
  assert.strictEqual(r.uTurns, actual,
    `数えた数(${r.uTurns})と指示の中身(${actual})が食い違う`);
});

test("案によって違う経路になる", async (t) => {
  if (await skipIfDown(t)) return;
  const short = await routeWithValhalla(KOFU, FUJI, { variant: "shortest" });
  const fun = await routeWithValhalla(KOFU, FUJI, { variant: "fun" });
  assert.ok(!short.error && !fun.error);
  assert.notStrictEqual(short.polyline, fun.polyline, "最短と楽しいが同じ経路");
  assert.ok(fun.lengthMeters > short.lengthMeters,
    `楽しい(${fun.lengthMeters}m) が 最短(${short.lengthMeters}m) より短い`);
});

test("通れない範囲を渡すと避ける", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 手で直した規制（data/road-restrictions/*.json・279件）を
  //    exclude_polygons として渡す道が使えるか
  const plain = await routeWithValhalla(KOFU, FUJI);
  const mid = plain.points[Math.floor(plain.points.length / 2)];
  const d = 0.0015;
  const box = [[mid[0]-d, mid[1]-d], [mid[0]+d, mid[1]-d],
               [mid[0]+d, mid[1]+d], [mid[0]-d, mid[1]+d], [mid[0]-d, mid[1]-d]];
  const avoided = await routeWithValhalla(KOFU, FUJI, { excludePolygons: [box] });
  assert.ok(!avoided.error, avoided.error);
  const inside = avoided.points.filter(([lng, lat]) =>
    lng >= mid[0]-d && lng <= mid[0]+d && lat >= mid[1]-d && lat <= mid[1]+d);
  assert.strictEqual(inside.length, 0,
    `避けたはずの範囲を ${inside.length} 点通っている`);
});

test("繋がらないときは原因が分かる文言で返す", async (t) => {
  // ⚠️ Valhalla が居ないのが圧倒的に多い。ここは居ても居なくても確かめられる
  const { routeWithValhalla: broken } = require("../lib/valhallaRoute");
  const kept = process.env.VALHALLA_URL;
  process.env.VALHALLA_URL = "http://127.0.0.1:9";   // 誰も居ないポート
  delete require.cache[require.resolve("../lib/valhallaRoute")];
  const fresh = require("../lib/valhallaRoute");
  try {
    const r = await fresh.routeWithValhalla(KOFU, FUJI);
    assert.ok(r.error, "繋がらないのにエラーが返っていない");
    assert.ok(r.error.includes("docker run"),
      "立ち上げ方が書かれていない: " + r.error);
  } finally {
    if (kept === undefined) delete process.env.VALHALLA_URL;
    else process.env.VALHALLA_URL = kept;
    delete require.cache[require.resolve("../lib/valhallaRoute")];
  }
});

// MARK: バイク（motorcycle）

/** その経路が高速道路を何m走るか */
function highwayMeters(route) {
  return (route.steps || [])
    .filter((s) => /自動車道|Expressway|圏央|高速道路/.test(s.roadName || ""))
    .reduce((a, s) => a + s.distanceMeters, 0);
}

//: 新座 → 愛川。バイクの既定だと関越道・圏央道・中央道を66.5km走る組
const NIIZA = [139.57376, 35.79677];
const AIKAWA = [139.26171, 35.55400];

test("バイクの楽しい案が高速道路を走らない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **これが実機で報告された不具合そのもの。**
  //    原付と同じ設定を渡していて、`use_primary` がバイクに効かず、
  //    77.8km のうち 66.5km が高速道路になっていた
  const r = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motorcycle", variant: "fun" });
  assert.ok(!r.error, r.error);
  const hw = highwayMeters(r);
  assert.ok(hw < 1000,
    `楽しい案が高速道路を ${(hw / 1000).toFixed(1)}km 走っている`);
});

test("バイクの楽しい案は、ふつうより高速が少ない", async (t) => {
  if (await skipIfDown(t)) return;
  const normal = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motorcycle", variant: "normal" });
  const fun = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motorcycle", variant: "fun" });
  assert.ok(!normal.error && !fun.error);
  assert.ok(highwayMeters(fun) < highwayMeters(normal),
    `楽しい${(highwayMeters(fun) / 1000).toFixed(1)}km が `
    + `ふつう${(highwayMeters(normal) / 1000).toFixed(1)}km より高速が多い`);
});

test("原付は、そもそも高速に乗らない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 原付・原二は法律で高速に乗れない。Valhalla の motor_scooter も乗せない。
  //    ここが崩れたら costing の取り違えを疑うこと
  for (const variant of ["shortest", "normal", "fun"]) {
    const r = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motor_scooter", variant });
    assert.ok(!r.error, r.error);
    assert.strictEqual(highwayMeters(r), 0, `原付の${variant}が高速に乗っている`);
  }
});

test("バイクの最短は高速を使わずに済んでいる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 最短は距離を詰めるので、結果として高速から降りる。
  //    ここが変わったら shortest が効いていない
  const r = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motorcycle", variant: "shortest" });
  assert.ok(!r.error, r.error);
  assert.ok(highwayMeters(r) < 1000, `最短が高速を ${highwayMeters(r)}m 走っている`);
});
