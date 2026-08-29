"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { APP_MANEUVER, toAppManeuver } = require("../lib/navManeuver");
const { SPOKEN_PHRASE } = require("../lib/navGuide");

/**
 * 曲がり方の名前が、アプリの `NavManeuver` と噛み合っているか。
 *
 * ⚠️ **ここがずれると、エラーも出ないまま曲がり角の案内が全部消える。**
 *    `NavManeuver.from` は知らない値を `.none` にするだけなので気づけない。
 *    実測で18種類中13種類が一致していなかった（Node は camelCase、
 *    アプリの生値は kebab-case）。
 */
const SWIFT = path.join(__dirname, "..", "..", "..",
  "Xcode/biketeilen_iOS_clean/touringSpotShare/saveRoute/nav/NavRoute.swift");

/** アプリの enum の生値を、Swift のソースから読む */
function appRawValues() {
  const src = fs.readFileSync(SWIFT, "utf8");
  const at = src.indexOf("enum NavManeuver: String {");
  assert.ok(at > 0, "NavManeuver が見つからない");
  const body = src.slice(at, src.indexOf("\n}", at));
  return new Set([...body.matchAll(/case\s+\w+\s*=\s*"([^"]*)"/g)].map((m) => m[1]));
}

test("アプリの enum を読めている", { skip: !fs.existsSync(SWIFT) && "iOS のソースが無い" }, () => {
  const raws = appRawValues();
  assert.ok(raws.size >= 15, `生値が ${raws.size} 個しか読めていない（材料が悪い）`);
  assert.ok(raws.has("turn-left") && raws.has(""), "代表的な生値が読めていない");
});

test("出す値が、ぜんぶアプリに実在する", { skip: !fs.existsSync(SWIFT) && "iOS のソースが無い" }, () => {
  // ⚠️ **これが本体。** アプリに無い値を出すと、その曲がり角は黙って無視される
  const raws = appRawValues();
  for (const [camel, raw] of Object.entries(APP_MANEUVER)) {
    assert.ok(raws.has(raw), `アプリに無い値を出そうとしている: ${camel} → "${raw}"`);
  }
});

test("読み上げ文を持つ曲がり方は、ぜんぶ変換できる", () => {
  // ⚠️ 案内文があるのに変換表に無いと、その曲がり方だけ静かになる
  for (const name of Object.keys(SPOKEN_PHRASE)) {
    assert.ok(Object.prototype.hasOwnProperty.call(APP_MANEUVER, name),
      `読み上げ文はあるのに変換できない: ${name}`);
  }
});

test("知らない名前を素通しさせない", () => {
  // ⚠️ 素通しするとアプリ側で黙って .none になる。ここで空にして意図を明示する
  assert.strictEqual(toAppManeuver("でたらめ"), "");
  assert.strictEqual(toAppManeuver(undefined), "");
  assert.strictEqual(toAppManeuver("turn-left"), "", "変換済みの値を二度通していない");
});

test("曲がり角でないステップは空文字にする", () => {
  // ⚠️ アプリの `case none = ""`。"none" という文字列ではない
  assert.strictEqual(toAppManeuver("none"), "");
  assert.strictEqual(APP_MANEUVER.none, "");
});

test("アプリへ出す口が、ぜんぶ変換を通している", () => {
  // ⚠️ **片方だけ直しても意味が無い。** アプリが叩きうる口はどれも通すこと
  const files = [
    ["admin/server.js", path.join(__dirname, "..", "server.js")],
    ["service/lib/buildRoute.js",
     path.join(__dirname, "..", "..", "service", "lib", "buildRoute.js")],
  ];
  for (const [label, file] of files) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    assert.ok(/toAppManeuver\(step\.maneuver\)/.test(src),
      `${label} が変換を通していない`);
    assert.ok(!/^\s*maneuver: step\.maneuver,\s*$/m.test(src),
      `${label} に変換していない出口が残っている`);
  }
});
