"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { routeOptionsFromBody, buildRouteResponse } = require("../../service/lib/buildRoute");
const { routeWithValhallaSegmented } = require("../lib/segmentedRoute");
const { BASE } = require("../lib/valhallaRoute");
const { decode } = require("../lib/polyline");

/**
 * Web（調整ツールの /valhalla）とアプリ（配信API route-api）が**同じ条件で経路を引く**こと。
 *
 * ⚠️ 利用者の要望（2026-09-27）:「web のルート生成とアプリのルート生成が同じ条件で生成されるか確認してほしい」。
 *    実測: 画面が別に条件を組んでいたため、既定が違い（目的地の手前の車線側・未確認の規制候補・二普協の規制）、
 *    同じ出発地・目的地24本のうち5本で道が違った。条件を作る関数を1つにして 24/24 で同じになった
 */

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");

test("アプリの依頼から作る条件の既定", () => {
  const base = { from: [139.0, 35.0], to: [139.1, 35.1] };
  const o = routeOptionsFromBody(base);
  assert.strictEqual(o.variant, "normal");
  assert.strictEqual(o.avoidFerries, true, "渡さなければ船を避ける（古いアプリと同じ）");
  assert.strictEqual(o.avoidEtcOnly, false, "渡さなければ車載器ありとみなす");
  assert.strictEqual(o.alternates, 0);
  assert.strictEqual(o.withRoadClass, true, "車線数を測らない");
  assert.deepStrictEqual([o.vias, o.stopAt, o.throughStopAt], [[], [], []]);
  assert.strictEqual(o.at, undefined, "日時を渡さないのに時間で判断する");
  assert.strictEqual(o.legConditions, undefined);
  // 渡したとき
  const g = routeOptionsFromBody({ ...base, avoidFerries: false, etc: false, alternates: "2", variant: "shortest",
    throughStopAt: [1, "x", 2.5, 3], at: "2026-09-27T09:00:00+09:00", isHoliday: 1,
    legConditions: [{ avoidTolls: true, avoidHighways: false }] });
  assert.strictEqual(g.avoidFerries, false);
  assert.strictEqual(g.avoidEtcOnly, true);
  assert.strictEqual(g.alternates, 2);
  assert.strictEqual(g.variant, "shortest");
  assert.deepStrictEqual(g.throughStopAt, [1, 3], "番号でないものを通した");
  assert.ok(g.at instanceof Date && g.isHoliday === true);
  assert.deepStrictEqual(g.legConditions, [{ avoidTolls: true, avoidHighways: false }]);
  // ⚠️ 崩れた区間の条件は使わない（全体の条件で引く）
  assert.strictEqual(routeOptionsFromBody({ ...base, legConditions: [{ avoidTolls: "yes" }] }).legConditions, undefined);
  assert.strictEqual(routeOptionsFromBody({ to: [139, 35] }), null, "出発地が無いのに条件を作った");
});

test("配信APIと調整ツールが、同じ関数で条件を作って同じ引き方をする", () => {
  const svc = read("service", "lib", "buildRoute.js");
  assert.ok(svc.includes("const opts = routeOptionsFromBody(body, deps);"), "配信APIが条件を別に組んでいる");
  assert.ok(svc.includes("route = await routeWithValhallaSegmented(from, to, opts);"), "配信APIの引き方が違う");
  const admin = read("admin", "server.js");
  assert.ok(admin.includes("const opts = routeOptionsFromBody(req.body,"), "画面の口が条件を別に組んでいる");
  assert.ok(admin.includes("const out = await routeWithValhallaSegmented(from, to, { ...opts, costing, excludePolygons });"),
    "画面の口の引き方がアプリと違う（区間ごとの条件・経由地の行き方違いが抜ける）");
  // 楽しい道の口も、条件の土台は同じ
  assert.ok(admin.includes("const baseOpts = routeOptionsFromBody({ ...req.body, alternates: 0 },"), "楽しい道の条件の土台が違う");
  assert.ok(admin.includes("{ ...baseOpts, vias: handVias.concat(autoVias), variant: \"fun\""), "楽しい道で土台を使っていない");
});

test("画面の既定はアプリと同じで、アプリの設定を渡せる", () => {
  const html = read("admin", "public", "valhalla.html");
  assert.ok(/id="arriveOnNearSide" checked/.test(html), "目的地の手前の車線側の既定がアプリと違う");
  assert.ok(/<option value="app" selected>/.test(html), "避ける規制の既定がアプリと違う");
  // ⚠️ **「引く」の設定だけを見ること。** 引き直しの欄も同じ書き方で送るので、ページ全体で探すと
  //    「引く」から消えても見逃す（変異テストで素通りした）
  const at = html.indexOf("  const bike = {");
  const bike = html.slice(at, html.indexOf("\n  };", at));
  assert.ok(at > 0, "「引く」の設定が見つからない");
  assert.ok(bike.includes("restrictionScope: val(\"restrictionScope\"),"), "避ける規制の範囲を送っていない");
  assert.ok(bike.includes("...(checked(\"noEtc\") ? { etc:false } : {}),"), "ETC車載器なしを送っていない");
  assert.ok(bike.includes("...(checked(\"allowFerry\") ? { avoidFerries:false } : {}),"), "フェリーの設定を送っていない");
  assert.ok(html.includes("{ key:\"normal\",   label:\"ふつう\", color:\"#1c7ed6\", alternates:2 }"), "ふつうで代替を頼んでいない（アプリは頼む）");
  assert.ok(html.includes("(got && !got.error && Array.isArray(got.alternates) ? got.alternates : []).forEach((alt, i) => {"),
    "代替を並べていない");
});

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}

test("同じ依頼なら、画面の口とアプリの口で同じ道と同じ代替になる（Valhalla）", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  // 規制は同じものを渡す（どちらも「アプリと同じ」）
  const restrictionsFor = async () => ({ restrictions: [], prefectures: [] });
  for (const [from, to, displacement] of [[[139.5693, 35.7936], [139.085, 35.992], "large"],
                                          [[139.7016, 35.6580], [139.7757, 35.6250], "moped50"]]) {
    const body = { from, to, displacement, arriveOnNearSide: true, alternates: 2 };
    const web = await routeWithValhallaSegmented(from, to, routeOptionsFromBody(body, { restrictionsFor }));
    const app = await buildRouteResponse({ ...body, guidance: false }, { restrictionsFor });
    assert.strictEqual(app.status, 200, app.body.error);
    const a = decode(app.body.route.polyline);
    assert.ok(Math.abs(a.length - web.points.length) <= 1, `線の点の数が違う: ${a.length} / ${web.points.length}`);
    assert.strictEqual(app.body.route.totalDistanceMeters, web.lengthMeters, "距離が違う");
    assert.strictEqual(app.body.alternates.length, web.alternates.length, "代替の本数が違う");
    assert.ok(web.alternates.length >= 1, "材料が悪い: 代替が無い");
  }
});
