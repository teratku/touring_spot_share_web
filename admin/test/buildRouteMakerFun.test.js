"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const B = require("../buildRouteMakerFun");

/**
 * Web のルート作成の「楽しい道・距離ガバ」の部品（public/route-maker-fun.js）は、admin/lib から作る生成物。
 * ⚠️ admin/lib を直して作り直し忘れると、Web だけ古い選び方のままになる（アプリ・調整ツールとずれる）
 */

test("生成物（public/route-maker-fun.js）が admin/lib の今の中身から作ったものと同じ（作り直し忘れ）", () => {
  assert.strictEqual(fs.readFileSync(B.OUT, "utf8"), B.build(),
    "admin/lib を直したあと node admin/buildRouteMakerFun.js を走らせていない");
});

test("生成物はブラウザでも Node でも読め、調整ツールの部品と同じ答えを返す", () => {
  delete require.cache[require.resolve(B.OUT)];
  const bundle = require(B.OUT);
  const direct = require("../lib/appFunRoute");
  assert.deepStrictEqual(Object.keys(bundle), ["appFun", "geometry", "rider"]);
  assert.deepStrictEqual(Object.keys(bundle.appFun).sort(), Object.keys(direct).sort(), "出している部品が違う");
  const fx = require("./fixtures-app-fun-parity.json");
  for (const t of fx.trips) {
    const o = { origin: t.from, destination: t.to, segments: t.segments, funWeight: t.funWeight,
                baselineMeters: t.baselineMeters, referenceAxis: t.referenceAxis };
    assert.deepStrictEqual(bundle.appFun.build({ ...o, choose: bundle.appFun.topChoice }).waypoints,
      direct.build({ ...o, choose: direct.topChoice }).waypoints, `${t.name}: 生成物の選び方が違う`);
  }
  // ⚠️ ブラウザに無いもの（fs・process など）を読み込みの途中で使わない
  const window = {};
  new Function("window", "module", fs.readFileSync(B.OUT, "utf8"))(window, undefined);
  assert.strictEqual(typeof window.TSSFun.appFun.buildSideVariants, "function", "ブラウザで window.TSSFun ができない");
  assert.strictEqual(typeof window.TSSFun.geometry.backtracks, "function");
  assert.ok(B.localRequires('a(require("./x")); require("fs"); require( "./y.js" )').join() === "x,y",
    "require の拾い方が違う（関数の中の require を落とすと、部品が足りずに Web で止まる）");
});
