"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 通行規制の一覧・地図の見え方。
 *
 * ⚠️ 実機で報告：「登録したのに、リストの文字が薄く、マーカーも表示されない」。
 *    どちらも**「元データに形があったか」で判断していた**のが原因。
 *    手で形を作って登録したものは、元データに形が無いので薄いままだった。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const js = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((s) => s.replace(/<\/?script>/g, "")).join("\n");

test("薄くするかは「いま形を持っているか」で決める", () => {
  const m = js.match(/const hasShape = [^\n]*/);
  assert.ok(m, "hasShape の判定が無い");
  // ⚠️ 登録した区間（R.saved 側の形）も見ること。元データだけ見ると薄いまま
  assert.ok(m[0].includes("R.saved.get(c.id)"), "登録した区間を見ていない");
  assert.ok(m[0].includes("c.polyline"), "元データの形を見ていない");
});

test("道筋が無くても「始」「終」を出す", () => {
  // ⚠️ 両端をつないで作った区間・CSVに合わせた区間は道筋を持たない。
  //    道筋が要る作りだと、つまみが出ず動かせない
  assert.ok(js.includes("rAddHandles(chain || segPath"),
            "道筋が無いとつまみを出していない");
});

test("長さは登録した区間のものを出す", () => {
  // ⚠️ **一覧が実際にそれを使っているかまで見ること。** 関数があるかだけ確かめると、
  //    使うのをやめても通ってしまう（実際にそういうテストを書いてしまった）
  assert.ok(js.includes("function rShownLength"), "長さの計算が無い");
  const m = js.match(/function rShownLength\(c\) \{[\s\S]*?\n\}/);
  assert.ok(m[0].includes("R.saved.get(c.id)"), "登録した区間の長さを見ていない");

  const row = js.match(/const rows = \$\("rRows"\);[\s\S]*?rows\.appendChild\(div\);/);
  assert.ok(row, "一覧の描画を取り出せない");
  assert.ok(row[0].includes("rShownLength(c)"), "一覧が登録した区間の長さを使っていない");
});

test("長さの単位を切り替える", () => {
  const m = js.match(/function rShownLength\(c\) \{[\s\S]*?\n\}/);
  // 1km を超えるものを 1298m のように出すと桁が読みにくい
  assert.ok(m[0].includes("1000"), "kmに切り替えていない");
});

test("登録済みは印で分かる", () => {
  // ⚠️ 薄さを直したので、登録済みかどうかは印で見分ける
  assert.ok(js.includes('${done ? "✅"'), "登録済みの印が無い");
});
