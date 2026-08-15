"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 通行規制の保存まわり。
 *
 * ⚠️ 実機で報告：「この区間で登録したのに、F5で消えている」。
 *    原因は**離脱の警告が区間の手直し側（state.dirty）しか見ていなかった**こと。
 *    「登録」は画面の中だけの操作で、残すには「保存」が要る。警告が出ないので
 *    保存し忘れたまま再読み込みして消えていた。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");

test("未保存の規制があれば離脱を止める", () => {
  const m = html.match(/window\.onbeforeunload = [\s\S]*?\n\};/);
  assert.ok(m, "onbeforeunload を取り出せない");
  assert.ok(m[0].includes("state.dirty"), "区間の手直しの未保存を見ていない");
  assert.ok(m[0].includes("R.dirty"), "通行規制の未保存を見ていない");
});

test("「登録」だけでは残らないと画面に書いてある", () => {
  // ⚠️ 文言で防ぐしかない部分。ボタン名（登録）だけだと保存済みに読める
  assert.ok(html.includes("右上の「保存」（S）まで押すと残ります"),
            "登録が未保存であることが画面に出ていない");
});

test("保存に失敗したら未保存のままにする", () => {
  const m = html.match(/async function rSave\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, "rSave を取り出せない");
  const body = m[0];
  // ⚠️ 失敗時に dirty を落とすと、保存できていないのに保存済みに見える
  const catchAt = body.indexOf("catch");
  const returnAt = body.indexOf("return;", catchAt);
  const dirtyAt = body.indexOf("rSetDirty(0)");
  assert.ok(catchAt >= 0, "通信の失敗を捕まえていない");
  assert.ok(returnAt >= 0 && returnAt < dirtyAt, "失敗しても未保存にしていない");
});

test("送った数より少なく保存されたら知らせる", () => {
  const m = html.match(/async function rSave\(\) \{[\s\S]*?\n\}/);
  const body = m[0];
  // 保存APIは形の足りない規制を黙って捨てるので、件数を突き合わせる
  assert.ok(body.includes("j.count < sending.length"), "件数を突き合わせていない");
});

test("保存APIは足りない規制を捨てる（前提の確認）", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(server.includes("!r.name) continue;"),
            "保存APIの前提が変わっている。画面側の突き合わせを見直すこと");
});

// MARK: タブごとのボタンの出し分け

/**
 * ⚠️ 実機で報告：「規制を登録しても保存ボタンが押せない」「配信を押したら
 *    茨城を選んでいるのに栃木の内容が出る」。
 *
 *    どちらも**ヘッダの「保存」「配信」が区間の手直し専用**なのに、規制タブでも
 *    押せたことが原因。保存は `state.dirty`（別の数え方）で有効になり、
 *    配信は `state.romaji`（区間の手直しで選んでいる県）を使う。
 */
test("タブごとにヘッダのボタンを出し分ける", () => {
  const m = html.match(/function showTab\(which\) \{[\s\S]*?\n\}/);
  assert.ok(m, "showTab を取り出せない");
  const body = m[0];
  assert.ok(body.includes('$("save").style.display'), "区間の手直しの保存を出し分けていない");
  assert.ok(body.includes('$("publish").style.display'), "配信を出し分けていない");
  assert.ok(body.includes('$("rSaveHeader").style.display'), "規制の保存を出し分けていない");
});

test("規制の保存はヘッダにも置く", () => {
  // ⚠️ 左の一覧バーだけだと幅からはみ出して見えない（それで「押せない」になった）
  assert.ok(html.includes('id="rSaveHeader"'), "ヘッダに規制の保存が無い");
  const js = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
    .map((s) => s.replace(/<\/?script>/g, "")).join("\n");
  assert.ok(js.includes('$("rSaveHeader").onclick'), "ヘッダの保存が繋がっていない");
});

test("未保存の数は2つのボタン両方に反映する", () => {
  const m = html.match(/function rSetDirty\(n\) \{[\s\S]*?\n\}/);
  assert.ok(m, "rSetDirty を取り出せない");
  // ⚠️ 片方だけ更新すると、見えている方がいつまでも押せないままになる
  assert.ok(m[0].includes('["rSave", "rSaveHeader"]'), "両方を更新していない");
});

test("配信はおすすめ道路のものだと分かる文言にする", () => {
  // ⚠️ 規制タブの県ではなく、区間の手直しで選んでいる県が使われる
  assert.ok(html.includes("を配信（おすすめ道路）"), "何を配信するのか分からない");
});
