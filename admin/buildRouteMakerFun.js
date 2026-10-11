/**
 * buildRouteMakerFun.js
 *
 * Web のルート作成（public/route-maker.html）で使う「楽しい道・距離ガバ」の部品を、
 * 調整ツールの部品（admin/lib）から **1つのブラウザ用ファイル**（public/route-maker-fun.js）にまとめる。
 *
 * ⚠️ 利用者の判断（2026-10-09）: Web のルート作成に「楽しい道＋距離ガバ」を持ってくる。
 *    選び方はアプリの FunRouteBuilder と答え合わせ済みの `lib/appFunRoute.js` をそのまま使う
 *    （Web 用に書き写すと、アプリ・調整ツール・Web の3つがずれていく）。
 * ⚠️ **生成物は直接直さないこと。** admin/lib を直したら、これを走らせて作り直す:
 *      node admin/buildRouteMakerFun.js
 *    作り忘れは admin/test/buildRouteMakerFun.test.js が落とす。
 * ⚠️ fs・path など Node だけの部品は空の箱にする（読み込むだけで、Web では使わない関数の中でしか使っていない）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LIB = path.join(__dirname, "lib");
const OUT = path.join(__dirname, "..", "public", "route-maker-fun.js");
/** Web が使う入口（ここから require をたどって全部入れる） */
const ENTRIES = ["appFunRoute", "navGeometry", "riderInsights"];

/** `require("./x")` の x を全部拾う（関数の中で呼んでいるものも） */
function localRequires(source) {
  return [...source.matchAll(/require\(\s*["']\.\/([A-Za-z0-9_]+)(?:\.js)?["']\s*\)/g)].map((m) => m[1]);
}

/** 生成物の中身（文字列）。テストが今のファイルと比べる */
function build() {
  const order = [];
  const sources = {};
  const visit = (name) => {
    if (sources[name] !== undefined) return;
    const source = fs.readFileSync(path.join(LIB, name + ".js"), "utf8");
    sources[name] = source;
    for (const dep of localRequires(source)) visit(dep);
    order.push(name);
  };
  ENTRIES.forEach(visit);

  const modules = order.map((name) =>
    `  // ---- admin/lib/${name}.js ----\n  ${JSON.stringify(name)}: function (require, module, exports) {\n` +
    sources[name].replace(/^#!.*\n/, "") + `\n  },`).join("\n");

  return `/*
 * route-maker-fun.js — 生成物。⚠️ 直接直さないこと（node admin/buildRouteMakerFun.js で作り直す）。
 * 中身は admin/lib の ${order.join(", ")}。
 * Web のルート作成の「楽しい道・距離ガバ」が使う（アプリの FunRouteBuilder と答え合わせ済みの選び方）。
 * ブラウザでは window.TSSFun、テスト（node）では module.exports
 */
(function (root) {
  var defs = {
${modules}
  };
  var cache = {};
  function load(name) {
    if (cache[name]) return cache[name].exports;
    var module = { exports: {} };
    cache[name] = module;
    defs[name](function (id) {
      var m = /^\\.\\/([A-Za-z0-9_]+)(?:\\.js)?$/.exec(id);
      // ⚠️ Node だけの部品（fs など）は空の箱。Web では使わない関数の中でしか使っていない
      return m && defs[m[1]] ? load(m[1]) : {};
    }, module, module.exports);
    return module.exports;
  }
  var api = { appFun: load("appFunRoute"), geometry: load("navGeometry"), rider: load("riderInsights") };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSFun = api;
})(typeof window !== "undefined" ? window : this);
`;
}

if (require.main === module) {
  fs.writeFileSync(OUT, build());
  console.log(`作りました: ${path.relative(process.cwd(), OUT)}`);
}

module.exports = { build, OUT, ENTRIES, localRequires };
