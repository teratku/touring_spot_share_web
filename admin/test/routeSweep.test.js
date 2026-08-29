"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/**
 * 回り込み・寄り道を変えて案を並べる機能。
 *
 * ⚠️ **同じ経路を何本も並べない。** 実測で回り込み ×3 と ×5、寄り道 2.0倍と 3.0倍が
 *    同じ経路になった。並べると「設定を変えたのに効いている」と誤解する。
 * ⚠️ **ただし消しすぎてもいけない。** 距離が近いだけの別経路を消すと、
 *    比べたかったものが出てこない。
 */
const FILE = path.join(__dirname, "..", "public", "valhalla.html");
const html = fs.readFileSync(FILE, "utf8");
const code = (() => {
  const out = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join("\n");
})();

/** 画面の `routeSignature` をそのまま取り出して動かす */
function loadSignature() {
  const at = code.indexOf("function routeSignature(r)");
  assert.ok(at > 0, "routeSignature が見つからない");
  const src = code.slice(at, code.indexOf("\n}", at) + 2);
  const ctx = {};
  vm.runInNewContext(src + "\nthis.routeSignature = routeSignature;", ctx);
  return ctx.routeSignature;
}
const routeSignature = loadSignature();

/** 東へ伸びる直線（lat をずらすと別の道になる） */
const line = (lat, n = 50) =>
  Array.from({ length: n }, (_, i) => [139.0 + i * 0.001, lat]);

test("同じ経路は同じ印になる", () => {
  const a = { lengthMeters: 12345, points: line(35.0), funRoads: [1] };
  const b = { lengthMeters: 12345, points: line(35.0), funRoads: [1] };
  assert.strictEqual(routeSignature(a), routeSignature(b));
});

test("距離が同じでも、通る道が違えば別の印になる", () => {
  // ⚠️ **両端は常に同じ**（始点と終点は変えていない）。両端と距離だけで見ると
  //    別の経路を消してしまう
  const north = { lengthMeters: 12345, points: line(35.10), funRoads: [1] };
  const south = { lengthMeters: 12345, points: line(35.00), funRoads: [1] };
  // 始終点をわざと揃える（実際の比較と同じ状況にする）
  north.points[0] = south.points[0] = [139.0, 35.05];
  north.points[north.points.length - 1] = south.points[south.points.length - 1] = [139.05, 35.05];
  assert.notStrictEqual(routeSignature(north), routeSignature(south),
    "通る道が違うのに同じ経路とみなしている");
});

test("通すおすすめ道路の本数が違えば、別の印になる", () => {
  const one = { lengthMeters: 12345, points: line(35.0), funRoads: [1] };
  const three = { lengthMeters: 12345, points: line(35.0), funRoads: [1, 2, 3] };
  assert.notStrictEqual(routeSignature(one), routeSignature(three));
});

test("線が無いものは印を作らない", () => {
  assert.strictEqual(routeSignature({ lengthMeters: 1, points: [] }), null);
  assert.strictEqual(routeSignature({ lengthMeters: 1, points: [[139, 35]] }), null);
});

test("比べる値は、画面の選択肢から採る", () => {
  // ⚠️ **二重に持たない。** 選択肢を増やしたときに比べる側だけ古い値のまま残る
  assert.ok(/const stepsOf = \(id\) =>/.test(code), "選択肢から採る仕組みが無い");
  assert.ok(/for \(const c of stepsOf\("corridor"\)\)/.test(code), "回り込みを選択肢から回していない");
  assert.ok(/for \(const b of stepsOf\("budget"\)\)/.test(code), "寄り道を選択肢から回していない");
  assert.ok(!/\[1, *2, *3, *5\]/.test(code), "回り込みの値を二重に持っている");
});

test("いま使った値は、比べるときに繰り返さない", () => {
  // ⚠️ 同じ呼び出しを2度すると、その1本ぶん（実測で最大8.7秒）が無駄になる
  assert.ok(/if \(c === corridorScale\) continue;/.test(code), "回り込みの重複呼び出しを避けていない");
  assert.ok(/if \(b === budgetRatio\) continue;/.test(code), "寄り道の重複呼び出しを避けていない");
});

test("比べるのは、明示したときだけ", () => {
  // ⚠️ **時間が掛かる**（実測: 回り込み4通りで23秒、寄り道3通りで9秒）。既定で走らせない
  assert.ok(/id="sweep"/.test(html), "切り替えが無い");
  assert.ok(!/id="sweep" checked/.test(html), "既定で比べるようになっている");
  assert.ok(/if \(checked\("sweep"\)\) \{/.test(code), "切り替えを見ていない");
});
