"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/**
 * JARTIC の取り込み結果を見る画面。
 *
 * ⚠️ 音や地図そのものは node では確かめられない。ここで押さえるのは
 *    **規約が求める出典が消えていないこと**と、画面の配線が生きていること。
 */
const FILE = path.join(__dirname, "..", "public", "jartic.html");
const html = fs.readFileSync(FILE, "utf8");
const inlineScripts = () => {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
};

test("画面のコードが構文として通る", () => {
  for (const [i, code] of inlineScripts().entries()) {
    assert.doesNotThrow(() => new vm.Script(code), `${i} 番目の script が構文で落ちる`);
  }
});

test("配線を `<script src=…>` の中に置いていない", () => {
  // ⚠️ 一度やった。src 付きの script に中身を入れると丸ごと無視され、
  //    エラーも出ないまま画面が動かなくなる
  const re = /<script[^>]*\bsrc=[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    assert.strictEqual(m[1].trim(), "", `src 付きの script に中身が入っている`);
  }
});

test("出典を画面に出している", () => {
  // ⚠️ **JARTIC の規約が求めている。** 消すと規約違反になる
  assert.ok(/id="attr"/.test(html), "出典を出す場所が無い");
  assert.ok(/d\.attribution/.test(inlineScripts().join("\n")),
    "取り込みファイルの出典を読んでいない");
});

test("候補であることを画面に書いている", () => {
  // ⚠️ **配信物と取り違えさせない。** ここに出ているのは未確認の下書き
  assert.ok(/配信物ではありません|そのまま配信しない/.test(html),
    "「候補であって配信物ではない」と書いていない");
  assert.ok(/道路名は推定/.test(html), "道路名が推定であることを書いていない");
});

test("排気量の区切りが Node 側と揃っている", () => {
  const { DISPLACEMENT_RANGES } = require("../lib/restrictionOverlap");
  const code = inlineScripts().join("\n");
  const m = code.match(/const RANGES = (\[\[[^;]+\]\]);/);
  assert.ok(m, "画面側に排気量の区切りが無い");
  // ⚠️ 片方だけ変えると、画面の「全員が通れない」と生成の判断が食い違う
  assert.deepStrictEqual(JSON.parse(m[1]), DISPLACEMENT_RANGES);
});
