"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * App Store へのリンクを、どこから来た人がどこで押したか分かるようにする（public/app-link.js・利用者の要望 2026-11-04）
 */
const L = require("../../public/app-link.js");
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const OWN = "biketeilen.web.app";

test("来た経路: utm_source が先・X の短縮 URL は x・サイトの中や直接は direct", () => {
  assert.strictEqual(L.landingSource("?utm_source=x&utm_medium=social", "https://t.co/abc", OWN), "x");
  assert.strictEqual(L.landingSource("?utm_source=LINE", "", OWN), "line");
  assert.strictEqual(L.landingSource("", "https://t.co/abc", OWN), "x", "X の短縮 URL を X と見ていない");
  assert.strictEqual(L.landingSource("", "https://x.com/biketeilen/status/1", OWN), "x");
  assert.strictEqual(L.landingSource("", "https://mobile.twitter.com/", OWN), "x");
  assert.strictEqual(L.landingSource("", "https://www.google.co.jp/", OWN), "google-co-jp");
  assert.strictEqual(L.landingSource("", `https://${OWN}/roads.html`, OWN), "direct", "サイトの中の移動を経路にした");
  assert.strictEqual(L.landingSource("", "", OWN), "direct");
  assert.strictEqual(L.landingSource("", "not a url", OWN), "direct");
});

test("ページの名前とストアのキャンペーン名（40文字まで）", () => {
  assert.strictEqual(L.pageName("/winter-closures.html"), "winter-closures");
  assert.strictEqual(L.pageName("/"), "top");
  assert.strictEqual(L.pageName("/index.html"), "top");
  assert.strictEqual(L.campaignToken("winter-closures", "x"), "web-winter-closures-x");
  assert.ok(L.campaignToken("a".repeat(30), "b".repeat(30)).length <= 40, "ストアの上限を超えた");
});

test("キャンペーンは提供元トークンがあるときだけ・このアプリの App Store のリンクだけに付ける", () => {
  const store = "https://apps.apple.com/jp/app/id1466607921";
  assert.strictEqual(L.withCampaign(store, "", "web-top-x"), store, "pt が無いのに書き換えた");
  const url = new URL(L.withCampaign(store, "123456", "web-top-x"));
  assert.strictEqual(url.searchParams.get("pt"), "123456");
  assert.strictEqual(url.searchParams.get("ct"), "web-top-x");
  assert.strictEqual(url.searchParams.get("mt"), "8");
  assert.strictEqual(L.withCampaign("https://example.com/id1466607921", "123456", "c"), "https://example.com/id1466607921");
  assert.strictEqual(L.withCampaign("https://apps.apple.com/jp/app/id999", "123456", "c"), "https://apps.apple.com/jp/app/id999");
});

test("App Store へのリンクがあるページ・X から来るページで読み込んでいる", () => {
  const pages = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".html"));
  for (const f of pages) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, f), "utf8");
    if (!html.includes("analytics.js")) continue;
    assert.match(html, /<script defer src="\/app-link\.js\?v=\d+"><\/script>/, `${f} で app-link.js を読み込んでいない`);
    assert.ok(html.indexOf("/analytics.js") < html.indexOf("/app-link.js"), `${f} で analytics.js より先に読み込んでいる`);
  }
  const winter = fs.readFileSync(path.join(PUBLIC_DIR, "winter-closures.html"), "utf8");
  assert.match(winter, /data-app-cta="[^"]+"/, "冬季閉鎖のページにアプリの案内が無い");
});
