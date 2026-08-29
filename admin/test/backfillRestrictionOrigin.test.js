"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { decideOrigin, draftIds } = require("../backfillRestrictionOrigin");
const { SELLABLE_ORIGINS } = require("../lib/restrictionOrigin");

/**
 * 登録済み279件に、あとから出どころを書き戻す判断。
 *
 * ⚠️ **ここを緩めると、転用の許諾が無いデータを売ることになる。**
 */

const drafts = draftIds();

test("取り込みの前置きが付いた id は、その出どころになる", () => {
  assert.strictEqual(decideOrigin({ id: "osm-aichi-171309600" }, drafts), "osm");
  assert.strictEqual(decideOrigin({ id: "jartic-2320260600002" }, drafts), "jartic");
});

test("二普協の下書きに実在する id は、二普協由来にする", () => {
  // ⚠️ **形で決めていない。** 下書きのファイルに同じ id があることを確かめている
  assert.ok(drafts.has("ibaraki-1"), "下書きが読めていない（材料が悪い）");
  assert.strictEqual(decideOrigin({ id: "ibaraki-1" }, drafts), "jmpsa");
  assert.strictEqual(decideOrigin({ id: "tochigi-1" }, drafts), "jmpsa");
});

test("形が似ているだけの id を、二普協にしない", () => {
  // ⚠️ 下書きに無い連番。憶測で埋めると、売れるはずのものまで売れなくなる
  assert.ok(!drafts.has("ibaraki-99999"), "材料が悪い（下書きに在ってはいけない）");
  assert.strictEqual(decideOrigin({ id: "ibaraki-99999" }, drafts), null);
});

test("手で引いたものは、安全側に倒して売らない", () => {
  // ⚠️ **自前調査とは限らない。** 実測で 100/118 が二普協の下書きと道路名が一致し、
  //    作成日も連番のものと同じ。逆に振ると許諾の無いデータを売ることになる
  assert.strictEqual(decideOrigin({ id: "manual-tokyo-1786844309516" }, drafts), "jmpsa");
  assert.ok(!SELLABLE_ORIGINS.has(decideOrigin({ id: "manual-tokyo-1786844309516" }, drafts)),
    "手で引いたものを販売対象にしている");
});

test("決められないものは、埋めない", () => {
  assert.strictEqual(decideOrigin({ id: "2024-kanagawa-01" }, drafts), null);
  assert.strictEqual(decideOrigin({ id: "" }, drafts), null);
  assert.strictEqual(decideOrigin({}, drafts), null);
  assert.strictEqual(decideOrigin(null, drafts), null);
});

test("埋め戻しても、登録済みが全部そのまま売れるようにはならない", () => {
  // ⚠️ **これが判断の本体。** 二普協ぶんは残り、そこは JARTIC から作り直すしかない
  const dir = path.join(__dirname, "..", "data", "road-restrictions");
  if (!fs.existsSync(dir)) return;
  let total = 0, sellable = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const r of j.restrictions || []) {
      total++;
      const o = r.origin || decideOrigin(r, drafts);
      if (SELLABLE_ORIGINS.has(o)) sellable++;
    }
  }
  assert.ok(total > 0, "規制が1件も無い（材料が悪い）");
  assert.ok(sellable > 0, "埋め戻しが1件も効いていない");
  assert.ok(sellable < total, `${total}件すべてが販売対象になっている。二普協ぶんが混ざる`);
});
