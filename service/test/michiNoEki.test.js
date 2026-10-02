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
