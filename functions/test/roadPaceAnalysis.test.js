"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { pendingSince, computeOffline } = require("../roadPaceOffline");

/**
 * 走りの速さの解析（ページから始める・前回からの変化）。2026-10-26 利用者の要望
 */
const inputs = (shared, backups = {}, consent = [], exclude = []) => ({ shared, backups, consent, exclude });

test("初めては解析が要る", () => {
  const p = pendingSince(null, inputs({ a: { uid: "u1", at: 1 } }), { docs: 2, since: 0, latest: 5 });
  assert.strictEqual(p.needsRun, true);
  assert.strictEqual(p.lastRunAt, null);
  assert.strictEqual(p.appSince, 2);
});

test("前回からの変化を数える（増えた・消えた共有ルート、更新されたバックアップ、同意の変化）", () => {
  const last = { ranAt: 1000, inputs: { shared: { a: 1, b: 1 }, backups: { "u1/x": 10 }, consent: ["u1"], exclude: [] } };
  const now = inputs({ a: { uid: "u1", at: 1 }, c: { uid: "u2", at: 2000 } },
                     { "u1/x": { uid: "u1", at: 20 }, "u3/y": { uid: "u3", at: 5 } }, ["u1", "u3"], ["u9"]);
  const p = pendingSince(last, now, { docs: 4, since: 1, latest: 1500 });
  assert.deepStrictEqual([p.newShared, p.goneShared, p.newBackups, p.consentAdded, p.excludeAdded], [1, 1, 2, 1, 1]);
  assert.strictEqual(p.needsRun, true);
  assert.strictEqual(p.appSince, 1);
});

test("何も変わっていなければ解析は要らない", () => {
  const last = { ranAt: 1000, inputs: { shared: { a: 1 }, backups: {}, consent: [], exclude: [] } };
  const p = pendingSince(last, inputs({ a: { uid: "u1", at: 1 } }), { docs: 0, since: 0, latest: 0 });
  assert.strictEqual(p.needsRun, false);
});

test("計算: 共有ルートの点から道ごとの数字（線は残さない）", async () => {
  const line = Array.from({ length: 151 }, (_, i) => ({ latitude: 35 + 48 / 3.6 / 111_195 * i, longitude: 139,
    timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString() }));
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ prefectures: { a: { prefecture: "長野県", fileName: "nagano.json" } } }) }) }) }) };
  const segments = [{ id: "長野県:1", name: "テスト峠線", ref: "", highway: "secondary", lengthKm: 3, score: 80,
                      polyline: "", start: [35, 139], end: [35.02, 139] }];
  // 道の線（北へまっすぐ）を polyline に
  const enc = (pts) => { let lat = 0, lng = 0, out = "";
    const e = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ""; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    for (const [a, b] of pts) { const la = Math.round(a * 1e5), ln = Math.round(b * 1e5); out += e(la - lat) + e(ln - lng); lat = la; lng = ln; } return out; };
  segments[0].polyline = enc([[35, 139], [35.02, 139]]);
  const bucket = { file: () => ({ download: async () => [Buffer.from(JSON.stringify({ segments }))] }) };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ routePoints: line }) });
  const { store, stat } = await computeOffline({ db, bucket, fetchImpl,
    inputs: inputs({ s1: { uid: "u1", at: 1, url: "x" } }) });
  assert.strictEqual(stat.sharedUsed, 1);
  const roads = store.get("u1");
  const [key] = Object.keys(roads);
  assert.strictEqual(roads[key].rides[0].kmh, 48);
  assert.strictEqual(roads[key].rides[0].src, "shared");
  assert.ok(!JSON.stringify(roads).includes("latitude"), "線を残している");
});

test("開発者の一覧は規則の isDev と同じ", () => {
  const rules = fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8");
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const ruleEmails = (rules.match(/function isDev\(\)[\s\S]*?\[([\s\S]*?)\]/) || [])[1].match(/"[^"]+"/g);
  const fnEmails = (index.match(/const DEV_EMAILS = \[([^\]]*)\]/) || [])[1].match(/"[^"]+"/g);
  assert.deepStrictEqual(fnEmails, ruleEmails);
});
