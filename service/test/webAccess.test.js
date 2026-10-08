"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const W = require("../lib/webAccess");

/**
 * Web からのルート作成はサブスクの人だけ（lib/webAccess.js）。
 * ⚠️ 利用者の判断（2026-10-08）: 経路サーバでも確かめる。アプリの /v1/route には掛けない
 */

const now = new Date("2026-10-08T12:00:00Z");
const ts = (iso) => ({ toDate: () => new Date(iso) });

test("加入中・有料の段・期限内のときだけ通す", () => {
  assert.strictEqual(W.isActiveSubscription({ isSubscribed: true, tier: "plus" }, now), true);
  assert.strictEqual(W.isActiveSubscription({ isSubscribed: true, tier: "pro", expiration: ts("2026-10-09T00:00:00Z") }, now), true);
  assert.strictEqual(W.isActiveSubscription({ isSubscribed: true, tier: "plus", expiration: ts("2026-10-08T11:00:00Z") }, now), false,
    "期限切れを通した（3日間コースが終わったあとも使える）");
  assert.strictEqual(W.isActiveSubscription({ isSubscribed: false, tier: "plus" }, now), false);
  assert.strictEqual(W.isActiveSubscription({ isSubscribed: true, tier: "free" }, now), false, "無料の段を通した");
  assert.strictEqual(W.isActiveSubscription(null, now), false);
});

test("窓口は認証のあとでサブスクを確かめ、加入していなければ 403", async () => {
  const docs = { paid: { isSubscribed: true, tier: "plus" }, free: { isSubscribed: false, tier: "free" } };
  const db = { collection: (c) => ({ doc: (id) => ({ get: async () => {
    assert.strictEqual(c, "subscriptions", "別の置き場を読んだ");
    return { exists: id in docs, data: () => docs[id] };
  } }) }) };
  const mw = W.makeRequireSubscription(db, { now: () => now });
  const run = async (uid) => {
    let status = 200, nexted = false;
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    await mw({ user: { uid } }, res, () => { nexted = true; });
    return { status, nexted };
  };
  assert.deepStrictEqual(await run("paid"), { status: 200, nexted: true });
  assert.deepStrictEqual(await run("free"), { status: 403, nexted: false });
  assert.deepStrictEqual(await run("nobody"), { status: 403, nexted: false });

  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(server.includes('app.post("/v1/web/route", requireAuth, requireSubscription, async (req, res) => {'),
    "Web の窓口でサブスクを確かめていない／認証より前に置いている");
  assert.ok(server.includes('app.post("/v1/route", requireAuth, async (req, res) => {'),
    "アプリの窓口にまでサブスクを掛けた（無料の人がアプリでルートを作れなくなる）");
  const hosting = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "firebase.json"), "utf8")).hosting;
  const rewrite = (hosting.rewrites || []).find((r) => r.source === "/v1/web/**");
  assert.deepStrictEqual(rewrite && rewrite.run, { serviceId: "route-api", region: "asia-northeast1" },
    "ホスティングから Web の窓口へ転送していない");
});
