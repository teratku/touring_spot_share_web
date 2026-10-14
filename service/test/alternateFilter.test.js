"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { keepsAlternate } = require("../lib/alternateFilter");
const RM = require("../../public/route-maker-lib.js");

/**
 * 条件に合わない別の道を外す（利用者の報告・判断 2026-10-14: Web で有料・高速を避ける設定なのに、
 * 別の道の候補が高速 34.5km を通っていた）。サーバ・Web（・アプリ）で同じ決まり
 */
const r = (expressway, tollLeft) => ({ kindMeters: { expressway, toll: 0, surface: 100000 }, tollUnavoidableMeters: tollLeft });
const main = r(0, 148);

for (const [who, keeps] of [["サーバ", keepsAlternate], ["Web", RM.keepsAlternate]]) {
  test(`${who}: 避ける設定で本命より高速・有料を多く通る別の道は外す`, () => {
    const avoid = { avoidTolls: true, avoidHighways: true };
    assert.strictEqual(keeps(r(34500, 148), main, avoid), false, "高速を避けるのに高速 34.5km の別の道を残した（報告の例）");
    assert.strictEqual(keeps(r(0, 6800), main, avoid), false, "有料を避けるのに有料を多く通る別の道を残した");
    assert.strictEqual(keeps(r(200, 300), main, avoid), true, "わずかな違い（300m 以内）で外した");
    assert.strictEqual(keeps(r(0, 148), main, avoid), true, "本命と同じだけ避けきれない有料を通る別の道を外した");
    // 本命も避けきれずに通っているなら、同じくらいは許す
    assert.strictEqual(keeps(r(5000, 0), r(4900, 0), avoid), true, "本命も通る高速を理由に外した");
  });

  test(`${who}: 使う設定・区間ごとに違うときは外さない`, () => {
    assert.strictEqual(keeps(r(34500, 0), main, { avoidTolls: false, avoidHighways: false }), true, "高速を使う設定なのに外した");
    assert.strictEqual(keeps(r(34500, 0), main, { avoidTolls: true, avoidHighways: false }), true, "高速を使う設定なのに外した");
    assert.strictEqual(keeps(r(0, 6800), main, { avoidTolls: false, avoidHighways: true }), true, "有料を使う設定なのに外した");
    assert.strictEqual(keeps(r(34500, 6800), main, { avoidTolls: true, avoidHighways: true, mixedLegs: true }), true,
      "区間ごとに条件が違うのに外した（高速を使ってよい区間を見分けられない）");
  });
}

test("サーバの応答と Web の受け取りで外している", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "lib", "buildRoute.js"), "utf8");
  assert.ok(/\.filter\(\(alt\) => keepsAlternate\(alt, app, \{/.test(server), "サーバで外していない");
  assert.ok(/mixedLegs: hasMixedConditions\(opts\.legConditions \|\| \[\]\)/.test(server), "区間ごとに違うかを見ていない");
  const page = fs.readFileSync(path.join(__dirname, "..", "..", "public", "route-maker.html"), "utf8");
  assert.ok(/return out\.route && RM\.keepsAlternate\(alt, out\.route, \{ avoidTolls: body\.avoidTolls, avoidHighways: body\.avoidHighways,/.test(page),
    "Web の受け取りで外していない（古いサーバのまま）");
  assert.ok(/route-maker-lib\.js\?v=([6-9]|\d{2,})"/.test(page), "ブラウザに古い route-maker-lib.js が残る（?v= を上げる）");
});
