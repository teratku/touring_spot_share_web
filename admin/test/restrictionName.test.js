"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 規制の道路名の出し方。
 *
 * ⚠️ 実機で報告：「規制道路名が初期のままになってしまう」。
 *    編集パネルだけが登録した名前を見ていて、**一覧は元データの名前のまま**だった。
 *    出す場所ごとに書いていたのが原因なので、`rNameOf` に寄せてある。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const js = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((s) => s.replace(/<\/?script>/g, "")).join("\n");

const nameOf = new Function(
  "R",
  (js.match(/function rNameOf\(c\) \{[\s\S]*?\n\}/) || [""])[0] + "; return rNameOf;"
);

test("画面側に rNameOf がある", () => {
  assert.ok(js.includes("function rNameOf"), "名前の決め方がまとまっていない");
});

test("登録した名前を最優先で使う", () => {
  const R = { saved: new Map([["x", { name: "直した名前" }]]) };
  const fn = nameOf(R);
  assert.strictEqual(fn({ id: "x", matchedName: "元の名前", sourceRoad: "元データ" }), "直した名前");
});

test("登録していなければ元データの名前を使う", () => {
  const fn = nameOf({ saved: new Map() });
  assert.strictEqual(fn({ id: "x", matchedName: "当てた名前", sourceRoad: "元データ" }), "当てた名前");
  assert.strictEqual(fn({ id: "x", sourceRoad: "元データ" }), "元データ");
});

test("名前が何も無ければ空", () => {
  const fn = nameOf({ saved: new Map() });
  assert.strictEqual(fn({ id: "x" }), "");
});

test("登録名が空文字なら元データに戻す", () => {
  // ⚠️ 空で登録されていたときに空欄のままだと、どの道か分からなくなる
  const R = { saved: new Map([["x", { name: "" }]]) };
  const fn = nameOf(R);
  assert.strictEqual(fn({ id: "x", matchedName: "元の名前" }), "元の名前");
});

test("名前を出すところは全部 rNameOf を通す", () => {
  // ⚠️ 1か所でも直書きが残ると、そこだけ古い名前が出て食い違う
  const direct = (js.match(/matchedName \|\| c\.sourceRoad/g) || []).length;
  assert.strictEqual(direct, 1, `直書きが ${direct} か所ある（rNameOf の中の1つだけが正しい）`);
});

test("登録したら一覧を描き直す", () => {
  const m = js.match(/function rApplyEdit\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, "rApplyEdit を取り出せない");
  assert.ok(m[0].includes("rRender()"), "一覧が古い名前のまま残る");
});
