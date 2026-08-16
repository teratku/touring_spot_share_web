"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 保存済みの規制を一覧へ戻す処理。
 *
 * ⚠️ 実機で報告：「保存した規制道路が消えている」。**データは残っていた**。
 *    一覧を二普協の候補ファイルから作っていたので、手で足した規制（候補が無い）が
 *    再読み込みで見えなくなっていた。候補ファイルの無い県（北海道など）では
 *    登録済みが全部消えて見える。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const js = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((s) => s.replace(/<\/?script>/g, "")).join("\n");

const m = js.match(/function restoreSavedAsCandidates\(\) \{[\s\S]*?\n\}/);

test("画面側に復元の処理がある", () => {
  assert.ok(m, "restoreSavedAsCandidates を取り出せない");
});

/** R を差し替えて関数だけ動かす */
function run(candidates, saved, prefName = "北海道") {
  const R = { candidates, saved: new Map(saved.map((s) => [s.id, s])), prefName };
  new Function("R", `${m[0]}; restoreSavedAsCandidates();`)(R);
  return R.candidates;
}

test("候補が無くても登録済みは一覧に出る", () => {
  const out = run([], [{ id: "manual-1", name: "国道238号", polyline: "abc" }]);
  assert.strictEqual(out.length, 1, "登録済みが一覧に出ていない");
  assert.strictEqual(out[0].matchedName, "国道238号");
});

test("候補にあるものは二重に出さない", () => {
  const out = run([{ id: "a", matchedName: "既にある道" }],
                  [{ id: "a", name: "既にある道", polyline: "abc" }]);
  assert.strictEqual(out.length, 1, "同じ規制が2つ並んでいる");
});

test("戻したものは一覧の先頭に出す", () => {
  // 探しにいかなくて済むように
  const out = run([{ id: "a", matchedName: "候補" }],
                  [{ id: "manual-1", name: "手で足した道", polyline: "abc" }]);
  assert.strictEqual(out[0].matchedName, "手で足した道");
});

test("戻したものは手で足した扱いにする", () => {
  // ⚠️ 二普協由来と混ざると、取り込み直しの扱いが変わる
  const out = run([], [{ id: "manual-1", name: "道", polyline: "abc" }]);
  assert.strictEqual(out[0].manual, true);
});

test("区間を道筋としても持たせる", () => {
  // ⚠️ 道筋は保存していない。無いと「始」「終」のつまみが出ず動かせない
  const out = run([], [{ id: "manual-1", name: "道", polyline: "abc" }]);
  assert.strictEqual(out[0].polyline, "abc");
  assert.strictEqual(out[0].chainPolyline, "abc");
});

test("排気量の指定も引き継ぐ", () => {
  const out = run([], [{ id: "m", name: "道", polyline: "abc", minCc: 126, maxCc: 400 }]);
  assert.strictEqual(out[0].minCc, 126);
  assert.strictEqual(out[0].maxCc, 400);
});

test("県名が保存側に無ければ画面の県を使う", () => {
  const out = run([], [{ id: "m", name: "道", polyline: "abc" }], "北海道");
  assert.strictEqual(out[0].prefecture, "北海道");
});

test("候補が未生成でも件数を出す", () => {
  // ⚠️ エラーだけ出すと「データが消えた」ように見える
  assert.ok(js.includes("cand.error && !R.saved.size"), "登録済みがあるときもエラーだけ出している");
});
