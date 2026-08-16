"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 通行規制の削除と、名前検索の下見。
 *
 * ⚠️ 削除には2種類ある。取り違えると「消したのに戻る」ことになる。
 *    ・登録を消す   … 規制としての登録を外す。候補は一覧に残る
 *    ・一覧から削除 … 候補ごと消す。**手で足したものだけ**
 *      （二普協から取り込んだ候補を消しても、取り込み直すと復活する）
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const js = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((s) => s.replace(/<\/?script>/g, "")).join("\n");

test("一覧から削除できる", () => {
  assert.ok(html.includes("一覧から削除"), "削除のボタンが無い");
  assert.ok(js.includes("R.candidates.splice"), "候補を一覧から外していない");
});

test("削除は手で足したものだけに出す", () => {
  // ⚠️ 取り込んだ候補に出すと、消しても取り込み直しで戻ってきて混乱する
  const m = js.match(/\$\{c\.manual \? '<button class="danger" id="r-delete">[^}]*\}/);
  assert.ok(m, "手で足したものだけに出す作りになっていない");
});

test("削除は確認してから消す", () => {
  const m = js.match(/if \(del\) del\.onclick = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, "削除の処理を取り出せない");
  assert.ok(m[0].includes("confirm("), "確認なしで消している");
});

test("削除したら登録も外す", () => {
  // ⚠️ 候補だけ消して登録が残ると、保存したときに幽霊の規制が書き込まれる
  const m = js.match(/if \(del\) del\.onclick = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(m[0].includes("R.saved.delete(c.id)"), "登録が残ってしまう");
});

test("削除は未保存として数える", () => {
  const m = js.match(/if \(del\) del\.onclick = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(m[0].includes("rSetDirty("), "保存し忘れても気付けない");
});

test("名前で探した道は選ぶ前に地図へ出す", () => {
  // ⚠️ 同じ名前の道が何本も出る。選んでから違ったと気付くと作り直しになる
  assert.ok(js.includes("function rPreviewRoad"), "下見の処理が無い");
  assert.ok(js.includes("div.onmouseenter = () => rPreviewRoad(road)"), "指しても地図に出ない");
});

test("下見では候補を作らない", () => {
  // ⚠️ 下見で `rStartFromRoad` を呼ぶと、指しただけで一覧に候補が増えていく
  const m = js.match(/function rPreviewRoad\(road\) \{[\s\S]*?\n\}/);
  assert.ok(m, "rPreviewRoad を取り出せない");
  assert.ok(!m[0].includes("rStartFromRoad"), "下見のつもりで候補を作っている");
});

test("下見は離れたら消す", () => {
  assert.ok(js.includes("div.onmouseleave = () => rClearRoadPreview()"), "下見が残り続ける");
});
