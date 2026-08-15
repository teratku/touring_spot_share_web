"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 登録済みの通行規制の道路名を直せるようにしたときの確認。
 *
 * ⚠️ **保存APIは名前の無い規制を黙って捨てる**（server.js の
 *    `if (!r || !r.id || !r.polyline || !r.name) continue;`）。
 *    名前を消したまま保存すると、その規制が**エラーも出ないまま消える**。
 *    画面側で空を通さないことを、ここで固定する。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("保存APIは名前の無い規制を捨てる（前提の確認）", () => {
  // ⚠️ ここが変わったら、画面側の歯止めの理由も変わる
  assert.ok(server.includes("!r.name) continue;"),
            "保存APIの前提が変わっている。画面側の歯止めを見直すこと");
});

test("画面に道路名の入力欄がある", () => {
  assert.ok(html.includes('id="r-name"'), "道路名を直せない");
});

test("空のまま保存しない", () => {
  const m = html.match(/function rApplyEdit\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, "rApplyEdit を取り出せない");
  const body = m[0];
  // 空なら元の名前へ戻し、それも無ければ保存させない
  assert.ok(body.includes("R.saved.get(c.id) || {}).name"), "元の名前に戻していない");
  assert.ok(body.includes("if (!name)"), "空のまま保存できてしまう");
  // ⚠️ 名前の判定は R.saved.set より前にあること。後ろだと空のまま入る
  assert.ok(body.indexOf("if (!name)") < body.indexOf("R.saved.set"),
            "空の判定が保存より後ろにある");
});

test("見出しと保存名が食い違わない", () => {
  const m = html.match(/function rRenderEditor\(c\) \{[\s\S]*?<h3>[^<]*<\/h3>/);
  assert.ok(m, "見出しを取り出せない");
  // ⚠️ 直した名前が見出しに出ないと、直したのに反映されていないように見える
  assert.ok(m[0].includes("saved.name"), "見出しが元データの名前のまま");
});
