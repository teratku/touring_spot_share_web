"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  meters, coverage, sampled, normalizeName, sameRoadName,
  rankCandidates, tierOf, TIERS,
} = require("../lib/restrictionRebuild");

/**
 * 二普協由来の規制を JARTIC の候補で置き換えるための突き合わせ。
 *
 * ⚠️ **ここが甘いと、別の道の規制を登録することになる。**
 */

/** 東へ伸びる直線。[経度, 緯度] を n 点 */
function line(startLng, lat, n, stepDeg = 0.001) {
  return Array.from({ length: n }, (_, i) => [startLng + i * stepDeg, lat]);
}

test("距離が実寸で出る", () => {
  // 緯度35度で経度0.001度 ≒ 91m
  const d = meters([139.0, 35.0], [139.001, 35.0]);
  assert.ok(d > 85 && d < 95, `91m のはずが ${d.toFixed(1)}m`);
});

test("短い区間が長い道に丸ごと収まっても、名前が違えば強い一致にしない", () => {
  // ⚠️ **実際に起きた誤り。** 短い「市道」が長い「首都圏中央連絡自動車道」に
  //    100%重なった。片側だけ見ていると通ってしまう
  const short = line(139.000, 35.0, 5);        // 約 0.4km
  const long  = line(138.950, 35.0, 120);      // 約 10km（short を丸ごと含む）
  // ⚠️ 数える側だけ間引く。相手側を間引くと解像度が落ちて取りこぼす
  const fwd = coverage(sampled(short), long);
  const bwd = coverage(sampled(long), short);
  assert.ok(fwd >= 0.9, `順方向が重なっていない（${fwd}）材料が悪い`);
  assert.ok(bwd < 0.6, `逆方向まで重なってしまう（${bwd}）材料が悪い`);
  assert.strictEqual(tierOf(fwd, bwd, false), TIERS.REVIEW, "誤りを強い一致に入れている");
});

test("名前が一致すれば、区間の長さが違っても強い一致にする", () => {
  // ⚠️ **実測「日立有料道路」→「日立有料道路」順100%/逆59%。**
  //    両方向で切ると、正しいものまで落ちる
  assert.strictEqual(tierOf(1.0, 0.59, true), TIERS.STRONG, "名前が一致するものを落としている");
  assert.strictEqual(tierOf(0.75, 0.16, true), TIERS.STRONG, "「下早見菖蒲線」の形を落としている");
});

test("総称同士を一致とみなさない", () => {
  // ⚠️ 「市道」が「市道」に一致しても、同じ道である証拠にならない
  assert.strictEqual(sameRoadName("市道", "市道"), false);
  assert.strictEqual(sameRoadName("県道", "県道"), false);
  assert.strictEqual(sameRoadName("その他の道路", "その他の道路"), false);
  assert.strictEqual(sameRoadName("市道", "首都圏中央連絡自動車道"), false);
});

test("表記のゆれを同じ道とみなす", () => {
  assert.strictEqual(normalizeName("一般国道23号線"), "国道23号");
  assert.ok(sameRoadName("一般国道23号線", "国道23号"), "国道の表記ゆれを別物にしている");
  assert.ok(sameRoadName("日立有料道路", "日立有料道路"));
  assert.ok(!sameRoadName("日立有料道路", "牧山道路"), "違う道を同じとみなしている");
  assert.strictEqual(sameRoadName("向野橋線", null), false);
});

test("重ならないものを候補に出さない", () => {
  const reg = { name: "向野橋線", points: line(139.0, 35.0, 20) };
  const far = { id: "jartic-x", name: "向野橋線", points: line(140.0, 36.0, 20) };
  assert.deepStrictEqual(rankCandidates(reg, [far]), [], "遠い道を候補に出している");
  assert.deepStrictEqual(rankCandidates({ name: "x", points: [] }, [far]), [],
    "線が無いのに候補を返している");
});

test("名前が一致する候補を先に出す", () => {
  const reg = { name: "湯袋観光道路", points: line(139.0, 35.0, 20) };
  const sameShape = { id: "a", name: "別の道", points: line(139.0, 35.0, 20) };
  const named     = { id: "b", name: "湯袋観光道路", points: line(139.0, 35.0, 18) };
  const ranked = rankCandidates(reg, [sameShape, named]);
  assert.strictEqual(ranked[0].id === undefined ? ranked[0].candidate.id : ranked[0].id, "b",
    "名前が一致する候補を先に出していない");
  assert.ok(ranked[0].nameAgrees);
});

test("実データで、二普協由来が全部そのまま置き換わりはしない", () => {
  // ⚠️ **これが判断の本体。** 全部が強い一致になるなら、閾値が緩すぎる
  const dir = path.join(__dirname, "..", "data", "restriction-rebuild");
  if (!fs.existsSync(dir)) return;
  let total = 0, strong = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const it of j.items || []) { total++; if (it.tier === TIERS.STRONG) strong++; }
  }
  assert.ok(total > 0, "突き合わせの結果が無い（材料が悪い）");
  assert.ok(strong > 0, "強い一致が1件も無い。閾値が厳しすぎる");
  assert.ok(strong < total, `${total}件すべてが強い一致。閾値が緩すぎる`);
});

test("短い区間でも、長い候補の上に乗っていれば見つかる", () => {
  // ⚠️ **実装のバグを捕まえた形。** 相手側まで間引くと、長い道ほど点の間隔が
  //    開いて（27kmを25点＝1.1km間隔）、実際には乗っている短い区間を取りこぼす
  const short = { name: "湯袋観光道路", points: line(139.100, 35.0, 5) };   // 約0.4km
  const long  = { id: "jartic-long", name: "湯袋観光道路", points: line(139.000, 35.0, 300) }; // 約27km
  const ranked = rankCandidates(short, [long]);
  assert.strictEqual(ranked.length, 1, "長い道に乗っている短い区間を見つけられていない");
  assert.ok(ranked[0].forward >= 0.9, `重なりが低い（${ranked[0].forward}）`);
});

test("逆向きの重なりも、間引かずに測る", () => {
  // ⚠️ 同じ道で始点だけずれている場合。両方を間引くと、点の位置がずれて
  //    重なっていないように見える（名前が違うと「要確認」に落ちてしまう）
  const reg  = { name: "牧山道路",   points: line(139.000, 35.0, 300) };
  const cand = { id: "jartic-shift", name: "別名の道", points: line(139.006, 35.0, 294) };
  const ranked = rankCandidates(reg, [cand]);
  assert.strictEqual(ranked.length, 1, "同じ道を候補に出せていない");
  assert.ok(ranked[0].backward >= 0.9,
    `逆向きの重なりが低い（${ranked[0].backward}）。間引きで位置がずれている`);
  assert.strictEqual(ranked[0].tier, TIERS.STRONG, "同じ道を強い一致にできていない");
});
