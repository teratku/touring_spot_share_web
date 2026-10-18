"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildMichiNoEkiResponse, INTERVALS } = require("../lib/michiNoEki");
const { encode } = require("../../admin/lib/polyline");

/**
 * `/v1/michinoeki`: 休憩に寄る道の駅（判断は `admin/lib/michiNoEki.js`）。
 * ⚠️ 利用者の要望（2026-10-01）:「途中で道の駅によるモードあったらいいなー」
 */
const LINE = encode(Array.from({ length: 1111 }, (_, i) => [139.0, 35.0 + i / 1110]));   // 北へ約111km

test("形の崩れた入力は Valhalla に渡さず断る（線・間隔・走る時間）", async () => {
  let calls = 0;
  const ask = async () => { calls++; return {}; };
  const ok = { polyline: LINE, intervalMinutes: 60, durationSeconds: 3 * 3600 };
  for (const body of [{}, { ...ok, polyline: "" }, { ...ok, polyline: encode([[139.0, 35.0]]) },
                      { ...ok, polyline: encode([[139.0, 95.0], [139.1, 96.0]]) },
                      { ...ok, intervalMinutes: 45 }, { ...ok, intervalMinutes: undefined },
                      { ...ok, durationSeconds: 0 }, { ...ok, durationSeconds: "x" }]) {
    const out = await buildMichiNoEkiResponse(body, { ask, stations: [] });
    assert.strictEqual(out.status, 400, `${JSON.stringify(body).slice(0, 80)} を通した`);
  }
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(INTERVALS, [60, 90, 120], "アプリのつまみと間隔が違う");
});

test("乗り手の乗り物で寄り道を引き、休憩の道の駅と出典を返す", async () => {
  const bodies = [];
  const shape = "_p~iF~ps|U_ulLnnqC";
  const ask = async (b) => { bodies.push(b); return { trip: { summary: { length: 2.2 }, legs: [{ shape }, { shape }] } }; };
  const stations = [{ name: "道の駅テスト", lat: 35.0 + 60 / 180, lon: 139.002 }];
  const out = await buildMichiNoEkiResponse({ polyline: LINE, intervalMinutes: 60, durationSeconds: 3 * 3600,
                                              displacement: "small125", excludedRanges: [[1, 2]], stepTimes: [[555, 5400]] },
                                            { ask, stations });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.stops.map((s) => s.name), ["道の駅テスト"]);
  assert.ok(["stop", "index", "alongMeters", "atSeconds", "extraMeters"].every((k) => k in out.body.stops[0]), "返す項目が足りない");
  assert.ok(Math.abs(out.body.stops[0].index - 370) <= 3, `線の点の番号が違う: ${out.body.stops[0].index}`);
  assert.strictEqual(bodies[0].costing, "motor_scooter", "原付なのに大型の乗り物で寄り道を引いた");
  assert.ok(/OpenStreetMap contributors/.test(out.body.attribution.join("\n")), "出典が無い");
});

test("窓口に認証が掛かり、道の駅の一覧をイメージに入れている", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/app\.post\("\/v1\/michinoeki", requireAuth/.test(server), "道の駅の窓口に認証が掛かっていない");
  const docker = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.ok(docker.includes("COPY admin/data/michinoeki.json /app/admin/data/michinoeki.json"),
            "道の駅の一覧をイメージに入れていない（黙って空を返す）");
});

// ---- ナビ中の「道の駅に寄る」（利用者の要望 2026-10-18）----
const { buildMichiNoEkiAheadResponse } = require("../lib/michiNoEki");
const { stationsAhead, AHEAD_MAX_RESULTS, AHEAD_MAX_METERS } = require("../../admin/lib/michiNoEki");

test("この先の線のそばの道の駅を、着く順に寄り道つきで返す（後ろ・遠すぎ・寄れない駅は出さない）", async () => {
  const pts = Array.from({ length: 1111 }, (_, i) => [139.0, 35.0 + i / 1110]);   // 北へ約111km
  const st = (name, lat, lon) => ({ name, lat, lon });
  const stations = [st("道の駅 北", 35.30, 139.003), st("道の駅 南", 35.05, 139.010), st("道の駅 遠く", 35.20, 139.20),
                    st("道の駅 先すぎ", 35.95, 139.0), st("道の駅 寄れない", 35.40, 139.001), st("道の駅 南", 35.051, 139.010),
                    // 線から約2.5km（休憩の1.5kmより遠いが、ナビ中の一覧には出す）
                    st("道の駅 少し離れ", 35.50, 139.0275)];
  const shape = "_p~iF~ps|U_ulLnnqC";
  const ask = async (b) => {
    const lat = b.locations[1].lat;
    // 寄れない駅は遠回りが大きい
    const length = Math.abs(lat - 35.40) < 1e-6 ? 25 : 2.5;
    return { trip: { summary: { length }, legs: [{ shape }, { shape }] } };
  };
  const out = await stationsAhead(pts, { ask, stations });
  assert.deepStrictEqual(out.map((s) => s.name), ["道の駅 南", "道の駅 北", "道の駅 少し離れ"], "着く順でない／遠い・先すぎ・寄れない駅を出した／同じ駅を2回出した");
  assert.ok(out[0].alongMeters < out[1].alongMeters);
  assert.ok(out.every((s) => Array.isArray(s.stop) && s.stop.length === 2 && s.extraMeters >= 0), "寄る点・寄り道が無い");
  assert.ok(AHEAD_MAX_RESULTS >= 5 && AHEAD_MAX_METERS >= 50_000, "一覧が少なすぎる／近すぎる");
  // 多くても上限まで（着く順の先頭から）
  const many = Array.from({ length: 20 }, (_, k) => st("道の駅" + k, 35.02 + k * 0.02, 139.001));
  const capped = await stationsAhead(pts, { ask, stations: many });
  assert.strictEqual(capped.length, AHEAD_MAX_RESULTS);
  assert.strictEqual(capped[0].name, "道の駅0");
});

test("窓口: 形の崩れた線は断り、乗り手の乗り物で寄り道を引く・認証が掛かる", async () => {
  let calls = 0;
  const ask = async (b) => { calls++; return { trip: { summary: { length: 1 }, legs: [{ shape: "_p~iF~ps|U_ulLnnqC" }, { shape: "" }] }, costing: b.costing }; };
  for (const body of [{}, { polyline: "" }, { polyline: encode([[139.0, 35.0]]) }]) {
    assert.strictEqual((await buildMichiNoEkiAheadResponse(body, { ask, stations: [] })).status, 400);
  }
  assert.strictEqual(calls, 0);
  const bodies = [];
  const out = await buildMichiNoEkiAheadResponse({ polyline: LINE, displacement: "small125" },
    { ask: async (b) => { bodies.push(b); return { trip: { summary: { length: 1 }, legs: [{ shape: "_p~iF~ps|U_ulLnnqC" }, { shape: "" }] } }; },
      stations: [{ name: "道の駅テスト", lat: 35.1, lon: 139.001 }] });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.stations.map((s) => s.name), ["道の駅テスト"]);
  assert.strictEqual(bodies[0].costing, "motor_scooter", "原付なのに大型の乗り物で寄り道を引いた");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/app\.post\("\/v1\/michinoeki\/ahead", requireAuth/.test(server), "窓口に認証が掛かっていない");
});
