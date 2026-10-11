"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { HOSTING_ORIGIN, firebaseReservedTarget, mountPublicSite } = require("../lib/publicSite");

/**
 * 管理ツール（4317）で公開サイトも開ける（利用者の要望 2026-10-11: 5002 の Web を 4317 で）。
 * ⚠️ 管理ツールの画面と窓口が先。公開サイトは無いパスだけを受ける
 */
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

test("Firebase の予約 URL は本番のホスティングへ回し、知らない形は回さない", () => {
  assert.strictEqual(firebaseReservedTarget("/__/firebase/init.js"), `${HOSTING_ORIGIN}/__/firebase/init.js`);
  assert.strictEqual(firebaseReservedTarget("/__/firebase/12.4.0/firebase-auth-compat.js"),
                     `${HOSTING_ORIGIN}/__/firebase/12.4.0/firebase-auth-compat.js`);
  assert.strictEqual(HOSTING_ORIGIN, "https://biketeilen.web.app", "本番のホスティング以外へ回している");
  assert.strictEqual(firebaseReservedTarget("/__/firebase/12.4.0/evil.js"), null, "SDK でないものまで回した");
  assert.strictEqual(firebaseReservedTarget("/__/firebase/latest/firebase-app.js"), null, "版の決まっていない SDK を回した");
  assert.strictEqual(firebaseReservedTarget("/__/firebase/init.json"), null);
  assert.strictEqual(firebaseReservedTarget("/conquest/conquest.html"), null);
});

test("管理ツールの画面が先で、無いパスだけ公開サイトが受ける（制覇マップ・SDK の転送）", async (t) => {
  const app = express();
  app.get("/", (_req, res) => res.send("管理ツール"));
  mountPublicSite(app, PUBLIC_DIR);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.strictEqual(await (await fetch(`${base}/`)).text(), "管理ツール", "公開サイトが管理ツールの画面を奪った");
  const conquest = await fetch(`${base}/conquest/conquest.html`);
  assert.strictEqual(conquest.status, 200);
  assert.match(await conquest.text(), /都道府県制覇マップ/);
  assert.strictEqual((await fetch(`${base}/conquest/japan-prefectures.geojson`)).status, 200, "県境データが出ない");
  assert.strictEqual((await fetch(`${base}/menu.js`)).status, 200, "共通メニューが出ない");

  const init = await fetch(`${base}/__/firebase/init.js`, { redirect: "manual" });
  assert.strictEqual(init.status, 302);
  assert.strictEqual(init.headers.get("location"), `${HOSTING_ORIGIN}/__/firebase/init.js`);
  const sdk = await fetch(`${base}/__/firebase/12.4.0/firebase-app-compat.js`, { redirect: "manual" });
  assert.strictEqual(sdk.headers.get("location"), `${HOSTING_ORIGIN}/__/firebase/12.4.0/firebase-app-compat.js`);
  assert.strictEqual((await fetch(`${base}/__/firebase/12.4.0/evil.js`, { redirect: "manual" })).status, 404);
});

test("管理ツール（server.js）は無い .html を次へ回し、公開サイトを最後に付ける", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const html = src.indexOf("app.get(/^\\/[\\w-]+\\.html$/");
  assert.ok(html >= 0, "管理ツールの .html の受け口が見つからない");
  const htmlRoute = src.slice(html, src.indexOf("\n});", html));
  assert.match(htmlRoute, /if \(!fs\.existsSync\(path\.join\(__dirname, "public", file\)\)\) return next\(\);/,
               "管理ツールに無い .html を 404 にしている（公開サイトのページが開けない）");

  const mount = src.indexOf("mountPublicSite(app, path.join(__dirname, \"..\", \"public\"));");
  const listen = src.indexOf("app.listen(");
  assert.ok(mount > 0 && mount < listen, "公開サイトを付けていない");
  const lastRoute = Math.max(...["app.get(", "app.post(", "app.put(", "app.delete(", "app.use("]
    .map((s) => src.lastIndexOf(s, listen)));
  assert.ok(lastRoute < mount, "公開サイトのあとに管理ツールの窓口がある（公開サイトが先に受けうる）");
});
