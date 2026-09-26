"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildSapaResponse } = require("../lib/sapa");
const { buildRouteResponse } = require("../lib/buildRoute");
const { encode } = require("../../admin/lib/polyline");

/**
 * `/v1/sapa`: 経路から寄れる高速の SA/PA（設計は app repo `docs/sapa-plan.md`）。
 */
const BASE = process.env.VALHALLA_URL || "http://127.0.0.1:8002";
async function skipIfDown(t) {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return false;
  } catch (e) { /* 落ちている */ }
  t.skip(`Valhalla が居ない（${BASE}）`);
  return true;
}

test("形の崩れた線は Valhalla に渡さず断る", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { json: async () => ({}) }; };
  const tooLong = encode(Array.from({ length: 60_001 }, (_, i) => [139 + i * 1e-5, 35]));
  const outOfRange = encode([[139.0, 95.0], [139.1, 96.0]]);
  for (const body of [{}, { polyline: "" }, { polyline: 12 }, { polyline: encode([[139.0, 35.0]]) },
                      { polyline: tooLong }, { polyline: outOfRange }]) {
    const out = await buildSapaResponse(body, { fetch, areas: [] });
    assert.strictEqual(out.status, 400, `${JSON.stringify(body)} を通した`);
  }
  assert.strictEqual(calls, 0);
});

test("高速に乗れない排気量には SA/PA を探さない（Valhalla を呼ばない）", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { json: async () => ({}) }; };
  const line = encode(Array.from({ length: 101 }, (_, i) => [139.0 + i * 0.001, 35.0]));
  const areas = [{ name: "一つ目SA (下り)", kind: "SA", fuel: "unknown", lat: 35.0011, lon: 139.05, ring: [] }];
  for (const d of ["moped50", "small125"]) {
    const out = await buildSapaResponse({ polyline: line, displacement: d }, { fetch, areas });
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(out.body.sapa, [], d);
  }
  assert.strictEqual(calls, 0, "原付でも寄り道を引いた");
  // 大型なら探す（材料の確かめ）
  await buildSapaResponse({ polyline: line, displacement: "large" }, { fetch, areas });
  assert.ok(calls > 0, "材料が悪い: 大型でも探していない");
});

test("SA/PA の出典（OSM）を必ず入れる", async () => {
  const out = await buildSapaResponse({ polyline: encode([[139.0, 35.0], [139.1, 35.0]]) }, { areas: [] });
  assert.strictEqual(out.status, 200);
  assert.ok(/OpenStreetMap contributors/.test(out.body.attribution.join("\n")));
});

test("窓口に認証が掛かっている", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/app\.post\("\/v1\/sapa", requireAuth/.test(server), "SA/PA の窓口に認証が掛かっていない");
  const docker = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.ok(docker.includes("COPY admin/data/sapa.json /app/admin/data/sapa.json"), "SA/PA の一覧をイメージに入れていない（黙って空を返す）");
});

test("アプリの線（5桁）から、寄れる SA/PA を経路の順に返す（東名の上り）", async (t) => {
  if (await skipIfDown(t)) return;
  const route = await buildRouteResponse({ from: [136.9066, 35.1709], to: [139.6334, 35.6264], displacement: "large", guidance: false },
                                         { baseUrl: BASE });
  assert.strictEqual(route.status, 200, route.body.error);
  const out = await buildSapaResponse({ polyline: route.body.route.polyline, displacement: "large" }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const names = out.body.sapa.map((x) => x.name);
  for (const n of ["海老名SA (上り)", "足柄SA (上り)", "港北PA (上り)"]) assert.ok(names.includes(n), `${n} が無い（${names}）`);
  assert.ok(!names.some((n) => /下り/.test(n)), "反対側を出した");
  for (const x of out.body.sapa) {
    assert.ok(["SA", "PA"].includes(x.kind) && ["yes", "unknown"].includes(x.fuel), JSON.stringify(x));
    assert.ok(Number.isFinite(x.alongMeters) && x.alongMeters >= 0 && x.alongMeters <= route.body.route.totalDistanceMeters + 1000);
    assert.ok(Array.isArray(x.stop) && x.stop.length === 2 && x.stop.every(Number.isFinite), "足す点が無い");
  }
});
