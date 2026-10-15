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

test("特定の UID はアプリと同じく加入の記録が無くてもサブスクとして通す（画面・経路サーバ・アプリで同じ顔ぶれ）", async () => {
  // 利用者の要望（2026-10-16）:「アプリの特定の uid だけフルを使用できるようにしているが、同じように web もしたい」
  const [internal] = [...W.INTERNAL_USER_IDS];
  let read = false;
  const db = { collection: () => ({ doc: () => ({ get: async () => { read = true; return { exists: false }; } }) }) };
  const mw = W.makeRequireSubscription(db, { now: () => now });
  let status = 200, nexted = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  await mw({ user: { uid: internal } }, res, () => { nexted = true; });
  assert.deepStrictEqual({ status, nexted }, { status: 200, nexted: true }, "特定の UID を 403 にした");
  assert.strictEqual(read, false);
  assert.strictEqual(W.isInternalUser("someone-else"), false);
  assert.strictEqual(W.isInternalUser(undefined), false, "ログインしていない人を通した");
  assert.ok(W.INTERNAL_USER_IDS.size > 0, "空の一覧（「空なら全員」に緩めない）");

  const ids = (text) => (text.match(/"[A-Za-z0-9]{28}"/g) || []).map((x) => x.slice(1, -1)).sort();
  const client = fs.readFileSync(path.join(__dirname, "..", "..", "public", "subscription.js"), "utf8");
  const block = client.slice(client.indexOf("const INTERNAL_USER_IDS = ["), client.indexOf("];", client.indexOf("const INTERNAL_USER_IDS = [")));
  assert.deepStrictEqual(ids(block), [...W.INTERNAL_USER_IDS].sort(), "画面と経路サーバで顔ぶれが違う");
  assert.match(client, /if \(INTERNAL_USER_IDS\.indexOf\(user\.uid\) >= 0\) \{\n\s+cache = \{ loggedIn: true, isSubscribed: true, tier: "pro"/,
    "画面で特定の UID をサブスクとして扱っていない");
  // アプリ（別のリポジトリ）が手元にあれば突き合わせる
  const app = path.join(require("os").homedir(), "Documents/Xcode/biketeilen_iOS_clean/touringSpotShare/saveRoute/nav/InternalUsers.swift");
  if (fs.existsSync(app)) {
    const swift = fs.readFileSync(app, "utf8");
    assert.deepStrictEqual(ids(swift.slice(swift.indexOf("static let userIDs"))).slice(0, W.INTERNAL_USER_IDS.size).sort(),
      [...W.INTERNAL_USER_IDS].sort(), "アプリの InternalUsers と顔ぶれが違う");
  }

  // ⚠️ .js は1年キャッシュ。変えたら読み込みの版を上げる（全ページ）
  for (const page of ["index", "detail", "user", "roads", "route-maker", "my-routes", "touring-plan"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", page + ".html"), "utf8");
    assert.match(html, /src="\/subscription\.js\?v=([2-9]|\d{2,})"/, page + ".html が古い subscription.js を読む（1年キャッシュ）");
  }
  // プラン画面はサブスクの上限（スポット10・プラン無制限）を使う
  const plan = fs.readFileSync(path.join(__dirname, "..", "..", "public", "touring-plan.html"), "utf8");
  assert.match(plan, /spotLimit\.value = sub\.isSubscribed \? SPOT_LIMIT_SUBSCRIBED : SPOT_LIMIT_FREE;/, "プラン画面がサブスクを見ていない");
  assert.match(plan, /const SPOT_LIMIT_SUBSCRIBED = 10;/);
  assert.match(plan, /planLimit\.value = sub\.isSubscribed \? Infinity : PLAN_LIMIT_FREE;/);
});
