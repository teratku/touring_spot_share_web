"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildRouteResponse } = require("../lib/buildRoute");
const { isSellable } = require("../../admin/lib/restrictionOrigin");

/**
 * 配信APIの応答。
 *
 * ⚠️ **実際に叩くには Firebase の ID トークンが要り、手元では作れない**
 *    （サービスアカウント鍵が無いと custom token に署名できない）。
 *    通信の入口（認証）は手で確かめ、中身はここで確かめる。
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

const TOKYO = [139.7671, 35.6812];
const HAKONE = [139.1069, 35.2324];

test("両端が無ければ断る", async () => {
  for (const body of [{}, { from: TOKYO }, { from: TOKYO, to: [1] }, { from: "x", to: HAKONE }]) {
    const out = await buildRouteResponse(body, {});
    assert.strictEqual(out.status, 400, `${JSON.stringify(body)} を通している`);
  }
});

test("出典を必ず入れる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **義務。** OSM は ODbL で表示が要り、JARTIC は規約が出典と加工の明記を求めている。
  //    ⚠️ 配信物のファイルには入っていなかった（Firestore へ上げるときだけ付いていた）
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const text = (out.body.attribution || []).join("\n");
  assert.ok(/OpenStreetMap contributors/.test(text), "OSM の表示が無い");
  assert.ok(/ODbL/.test(text), "ODbL の記載が無い");
  assert.ok(/日本道路交通情報センター/.test(text), "JARTIC の出典が無い");
  assert.ok(/加工/.test(text), "加工した旨が無い");
});

test("アプリが読む形で返す", async (t) => {
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, displacement: "large" }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const r = out.body.route;
  for (const key of ["totalDistanceMeters", "totalDurationSeconds", "polyline", "steps"]) {
    assert.ok(r[key] != null, `${key} が無い`);
  }
  const step = r.steps[0];
  for (const key of ["maneuver", "instruction", "roadName", "spokenRoad", "distanceMeters"]) {
    assert.ok(key in step, `steps に ${key} が無い`);
  }
  assert.ok(Array.isArray(out.body.guidance) && out.body.guidance.length > 0, "案内が付いてこない");
});

test("案内は要らないと言えば付けない", async (t) => {
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false }, { baseUrl: BASE });
  assert.strictEqual(out.body.guidance, undefined);
});

test("線は5桁で返す（10倍ずれない）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ Valhalla は6桁。そのまま渡すと座標が10倍ずれる（過去に踏んだ）
  const { decode } = require("../../admin/lib/polyline");
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false }, { baseUrl: BASE });
  const points = decode(out.body.route.polyline);
  const first = points[0];
  assert.ok(Math.abs(first[0] - TOKYO[0]) < 0.05 && Math.abs(first[1] - TOKYO[1]) < 0.05,
    `始点が ${JSON.stringify(first)}（渡したのは ${JSON.stringify(TOKYO)}）`);
});

test("規制を読んだ県を返す", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 見落としが起きていないか、呼ぶ側が確かめられるように
  const seen = [];
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false },
    { baseUrl: BASE,
      restrictionsFor: (points) => {
        seen.push(points.length);
        return { restrictions: [], prefectures: ["東京都", "神奈川県"] };
      } });
  assert.deepStrictEqual(out.body.route.restrictionPrefectures, ["東京都", "神奈川県"]);
  assert.ok(seen[0] > 100, "経路の点が渡っていない");
});

test("避けきれなかった規制を隠さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **黙って通させない。** 塞ぎきれなかったことは呼ぶ側に伝える
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false }, { baseUrl: BASE });
  const r = out.body.route;
  assert.ok(Array.isArray(r.restrictionHits), "残った規制の欄が無い");
  assert.ok(Array.isArray(r.restrictionSkipped), "渡せなかった規制の欄が無い");
  assert.ok(Number.isFinite(r.restrictionTries), "引き直した回数が無い");
});

test("売ってよい出どころだけを通す", () => {
  // ⚠️ **二普協由来と、記録の無いものは載せない**（`admin/lib/restrictionOrigin.js`）
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(server.includes(".filter(isSellable)"),
    "配信側で出どころを絞っていない");
  assert.strictEqual(isSellable({ origin: "jmpsa" }), false);
  assert.strictEqual(isSellable({ origin: null }), false);
});

test("管理の窓口を載せていない", () => {
  // ⚠️ 規制の編集・取り込み・道路データの生成は admin の仕事。外に出さない
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = [...server.matchAll(/app\.(get|post|put|delete)\("([^"]+)"/g)].map((m) => m[2]);
  assert.deepStrictEqual(routes.sort(), ["/health", "/v1/route"],
    `余計な窓口が載っている: ${routes.join(", ")}`);
});

test("認証を外していない", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/app\.post\("\/v1\/route", requireAuth/.test(server),
    "ルート生成に認証が掛かっていない");
  assert.ok(/verifyIdToken/.test(server), "トークンを確かめていない");
});

test("外から繋がる待ち方をしている", () => {
  // ⚠️ Cloud Run は 0.0.0.0 で待つこと。127.0.0.1 だと外から繋がらない
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/const HOST = "0\.0\.0\.0"/.test(server), "0.0.0.0 で待っていない");
});
