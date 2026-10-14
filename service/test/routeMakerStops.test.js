"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const RM = require("../../public/route-maker-lib.js");

/**
 * Web のルート作成の行き先の並び（Google マップ・Yahoo! カーナビの行き先画面のような縦の並び。利用者の要望 2026-10-15）。
 * 並べ替え・削除・逆にするはプランに保存する（判断: 並べ替え・削除もでき、プランに保存）
 */
const spots = [
  { name: "猪苗代", order: 0 },
  { name: "ぶどうまつたけライン", order: 1, isRoad: true },
  { name: "蔵王町", order: 2 },
];

test("並べ替えは元のスポットを動かし、order を振り直す（元のスポットは書き換えない）", () => {
  const sorted = RM.sortedSpots([spots[2], spots[0], spots[1]]);
  assert.deepStrictEqual(sorted.map((s) => s.name), ["猪苗代", "ぶどうまつたけライン", "蔵王町"], "order の順に並べていない");
  const moved = RM.movedSpots(sorted, spots[0], spots[2]);
  assert.deepStrictEqual(moved.map((s) => s.name), ["ぶどうまつたけライン", "蔵王町", "猪苗代"]);
  const saved = RM.withOrder(moved);
  assert.deepStrictEqual(saved.map((s) => s.order), [0, 1, 2], "order を振り直していない（開き直すと元の並びに戻る）");
  assert.strictEqual(spots[0].order, 0, "元のスポットを書き換えた");
  assert.deepStrictEqual(RM.movedSpots(sorted, { name: "無い" }, spots[2]).map((s) => s.name), sorted.map((s) => s.name), "見つからないのに動かした");
});

test("区間ごとの設定も行き先と一緒に並べ替える（足りない分は空）", () => {
  assert.deepStrictEqual(RM.movedList(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepStrictEqual(RM.movedList(["a"], 0, 2), [undefined, undefined, "a"], "区間の設定が別の行き先へずれる");
});

test("画面: 縦の並び・↑↓・✕・⇅・ドラッグで、プランに保存する", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "route-maker.html"), "utf8");
  assert.ok(/\.rm-stop::before \{ content: ""; position: absolute;/.test(html), "印を線でつないでいない");
  assert.ok(/data-move="' \+ i \+ '" data-delta="-1"/.test(html) && /data-delta="1"/.test(html), "↑↓が無い");
  assert.ok(/data-remove="' \+ i \+ '"' \+ \(editable <= 1 \? " disabled" : ""\)/.test(html), "最後の1つまで消せる");
  assert.ok(/window\.confirm\("「" \+ d\.name \+ "」をプランから外しますか？"\)/.test(html), "確かめずにプランから外す");
  assert.ok(/id="reverseStops"/.test(html) && /if \(rev\) rev\.onclick = guarded\(reverseStops\);/.test(html), "並びを逆にできない");
  assert.ok(/li\.ondrop = function \(ev\) \{/.test(html), "ドラッグで並べ替えられない");
  assert.ok(/var spots = RM\.withOrder\(nextSpots\);\n\s+await fb\.db\.collection\("users"\)\.doc\(fb\.user\.uid\)\.collection\("touringPlans"\)\.doc\(plan\.id\)\.update\(\{/.test(html),
    "並べ替えをプランに保存していない");
  assert.ok(/return savePlanOrder\(moved, RM\.movedList\(planLegs\(\), from, to\)\);/.test(html), "区間ごとの設定が別の行き先へずれる");
  assert.ok(/<span class="rm-stop__legarrow" aria-hidden="true">↓<\/span>/.test(html), "区間の設定を行き先の上に出していない");
  assert.ok(/route-maker-lib\.js\?v=8"/.test(html), "ブラウザに古い route-maker-lib.js が残る");
});
