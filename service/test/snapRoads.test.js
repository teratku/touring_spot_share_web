"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildSnapResponse, SNAP_ATTRIBUTION } = require("../lib/snapRoads");

/**
 * `/v1/snap` の中身（なぞった線を道路に載せる）。
 * ⚠️ 実際に叩くには Firebase の ID トークンが要るので、中身をここで確かめる
 */
function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: reply.status === 200, status: reply.status, json: async () => reply.json };
  };
  f.calls = calls;
  return f;
}
const TWO = [[139.1, 35.2], [139.2, 35.3]];
const OK = { status: 200, json: { matched_points: [
  { lat: 35.2, lon: 139.1, type: "matched" }, { lat: 35.3, lon: 139.2, type: "unmatched" }] } };

test("崩れた点の並びは Valhalla に渡さず 400 で返す", async () => {
  const f = fakeFetch(OK);
  for (const points of [undefined, "x", [], [[139, 35]], [[139, 35], [139]], [[139, 35], ["139", 35]],
    [[139, 35], [NaN, 35]], [[139, 35], [200, 35]], [[139, 35], [139, 95]],
    Array.from({ length: 101 }, () => [139, 35])]) {
    const out = await buildSnapResponse({ points }, { fetch: f });
    assert.strictEqual(out.status, 400, `${JSON.stringify(points)?.slice(0, 40)} を通した`);
  }
  assert.strictEqual(f.calls.length, 0, "崩れた入力を Valhalla に渡した");
  assert.strictEqual((await buildSnapResponse(undefined, { fetch: f })).status, 400);
});

test("載せた点を入力と同じ並びで返し、出典を付ける", async () => {
  const out = await buildSnapResponse({ points: TWO }, { fetch: fakeFetch(OK) });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.points, [[139.1, 35.2], null]);
  // ⚠️ OSM は ODbL で表示が義務
  assert.deepStrictEqual(out.body.attribution, SNAP_ATTRIBUTION);
  assert.ok(SNAP_ATTRIBUTION.some((s) => s.includes("OpenStreetMap")), "OSM の出典が無い");
  // ⚠️ JARTIC は使っていないので「加工して作成」とは書かない
  assert.ok(!SNAP_ATTRIBUTION.some((s) => s.includes("JARTIC") || s.includes("jartic")), "使っていない出典を書いている");
});

test("排気量を渡し、知らない排気量は無視する", async () => {
  const f = fakeFetch(OK);
  await buildSnapResponse({ points: TWO, displacement: "moped50" }, { fetch: f });
  await buildSnapResponse({ points: TWO, displacement: "でたらめ" }, { fetch: f });
  await buildSnapResponse({ points: TWO, displacement: 50 }, { fetch: f });
  assert.deepStrictEqual(f.calls.map((b) => b.costing), ["motor_scooter", "motorcycle", "motorcycle"]);
});

test("Valhalla が失敗したら 502 で理由を返す", async () => {
  const out = await buildSnapResponse({ points: TWO },
    { fetch: fakeFetch({ status: 400, json: { error_code: 154, error: "距離の上限を超えています" } }) });
  assert.strictEqual(out.status, 502);
  assert.match(out.body.error, /上限/);
});

test("窓口は認証の内側に置く", () => {
  // ⚠️ 無認証で出すと、Valhalla の CPU をだれでも使える
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(server.includes('app.post("/v1/snap", requireAuth, async (req, res) => {'),
    "/v1/snap が認証を通っていない");
  assert.ok(server.includes("buildSnapResponse(req.body || {}, { baseUrl: VALHALLA_URL })"),
    "/v1/snap が Valhalla の居場所を渡していない");
});
