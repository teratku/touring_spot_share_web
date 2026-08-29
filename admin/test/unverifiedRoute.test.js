"use strict";
const test = require("node:test");
const assert = require("node:assert");

/**
 * 未確認の JARTIC 候補を混ぜた経路生成を、**窓口ごしに**確かめる。
 *
 * ⚠️ **ここを部品のテストだけで済ませてはいけない。** 実際に2つ見落とした:
 *    ① 登録が無い県で `continue` して、候補を読む前に抜けていた
 *       （＝混ぜる機能が、いちばん要る14県で効かなかった）
 *    ② `restrictionHits` を組み立てるときに `verified` を捨てていた
 *       （＝未確認がすべて「確認済」に見えていた）
 *    どちらも部品のテストは通っていた。**通しで見ないと分からない。**
 */
const BASE = process.env.ADMIN_URL || "http://127.0.0.1:4317";

async function up() {
  try {
    const r = await fetch(`${BASE}/api/valhalla/status`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()).up === true;
  } catch { return false; }
}
const skipIfDown = async (t) => (await up()) ? false
  : t.skip(`管理ツールか Valhalla が居ない（${BASE}）`);

const route = (body) => fetch(`${BASE}/api/valhalla/route`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
}).then((r) => r.json());

/** 福岡「冷水道路」（原付通行止め・登録が1件も無い県）を跨ぐ区間 */
const FUKUOKA = { from: [130.5775014969902, 33.48010935742584],
                  to:   [130.6336834151258, 33.52171938813786] };

test("登録が1件も無い県でも、未確認を混ぜれば規制を避ける", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **福岡には `data/road-restrictions/fukuoka.json` が無い。**
  //    ここで効かないなら、混ぜる機能そのものに意味が無い
  const off = await route({ ...FUKUOKA, displacement: "moped50", includeUnverified: false });
  const on  = await route({ ...FUKUOKA, displacement: "moped50", includeUnverified: true });
  assert.ok(!off.error && !on.error, `経路が引けない: ${off.error || on.error}`);
  assert.strictEqual(off.restrictionTries, 0, "混ぜていないのに避けている（材料が悪い）");
  assert.ok(on.restrictionTries > 0, "混ぜても規制を避けていない");
  assert.ok(on.lengthMeters > off.lengthMeters,
    `迂回していない（${off.lengthMeters}m → ${on.lengthMeters}m）`);
});

test("避けた規制が未確認だと分かる形で返る", async (t) => {
  if (await skipIfDown(t)) return;
  const on = await route({ ...FUKUOKA, displacement: "moped50", includeUnverified: true });
  const hits = on.restrictionHits || [];
  assert.ok(hits.length > 0, "避けきれなかった規制が無い（材料が悪い）");
  // ⚠️ 候補由来なのだから、確認済みと言ってはいけない
  assert.ok(hits.every((h) => h.verified === false),
    `未確認を確認済みとして返している: ${JSON.stringify(hits)}`);
});

test("混ぜないのが既定", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **黙って避けすぎないこと。** 旗を渡さなければ、渡して false と同じ
  const bare = await route({ ...FUKUOKA, displacement: "moped50" });
  const off  = await route({ ...FUKUOKA, displacement: "moped50", includeUnverified: false });
  assert.strictEqual(bare.lengthMeters, off.lengthMeters, "旗を渡さないと挙動が変わる");
  assert.strictEqual(bare.restrictionTries, 0, "既定で未確認を避けている");
});

test("排気量で当たらない候補は避けない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 冷水道路の候補は 0〜50cc。大型に当ててはいけない
  const big = await route({ ...FUKUOKA, displacement: "large", includeUnverified: true });
  assert.ok(!big.error, `経路が引けない: ${big.error}`);
  assert.strictEqual(big.restrictionTries, 0,
    "原付だけの規制を大型でも避けている");
});
