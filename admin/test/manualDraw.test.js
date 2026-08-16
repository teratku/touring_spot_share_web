"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 手で線を引く（CSVに道が無い場所のための最後の手段）。
 *
 * ⚠️ **道に沿っているかは誰も確かめない。** つないだ線と違い完全に手作業で、
 *    地図の道からずれていても気付けない。CSVで作れるならそちらを使うこと。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const js = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((s) => s.replace(/<\/?script>/g, "")).join("\n");

test("手で線を引ける", () => {
  assert.ok(html.includes("手で線を引く"), "ボタンが無い");
  assert.ok(js.includes("function rBeginDraw"), "引く処理が無い");
});

test("2点未満では決められない", () => {
  // ⚠️ 1点だけで確定させると、線にならないものを区間として保存してしまう
  const m = js.match(/function rRenderDrawPanel\(replacing\) \{[\s\S]*?\n\}/);
  assert.ok(m, "パネルの描画を取り出せない");
  assert.ok(m[0].includes('n >= 2 ? "" : "disabled"'), "点が足りなくても押せる");
});

test("1つ戻せる", () => {
  // ⚠️ 押し間違えたときに最初からやり直しでは使えない
  const m = js.match(/function rRenderDrawPanel\(replacing\) \{[\s\S]*?\n\}/);
  assert.ok(m[0].includes("R.drawPoints.pop()"), "点を戻せない");
  assert.ok(m[0].includes("R.drawMarkers.pop()"), "印だけ残ってしまう");
});

test("やめたら地図から消える", () => {
  const m = js.match(/function rCancelDraw\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, "片付けが無い");
  for (const what of ["drawListener", "drawLine", "drawMarkers", "drawPoints"]) {
    assert.ok(m[0].includes(what), `${what} を片付けていない`);
  }
});

test("他の操作を始めたら引きかけを片付ける", () => {
  // ⚠️ 地図のクリックが取り合いになる。引きかけの線も残って紛らわしい
  for (const fn of ["function rPickEnd(which) {",
                    "async function rConnectEnds(replacing) {",
                    "function rBeginPickOnMap({ replacing = null } = {}) {",
                    "function rSelect(c) {"]) {
    const at = js.indexOf(fn);
    assert.ok(at >= 0, fn + " が無い");
    const body = js.slice(at, at + 400);
    assert.ok(body.includes("rCancelDraw()"), fn + " で片付けていない");
  }
});
