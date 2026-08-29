"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  ORIGINS, SELLABLE_ORIGINS, ATTRIBUTION,
  originFromId, normalizeOrigin, isSellable,
} = require("../lib/restrictionOrigin");

/**
 * 規制を「どの資料から作ったか」の記録と、販売APIに載せてよいかの判断。
 *
 * ⚠️ **ここを間違えると、売ってはいけないデータを売ることになる。**
 */

test("二普協を販売APIに載せない", () => {
  // ⚠️ **規約は「非営利目的ならリンク自由」で、データ転用の許諾ではない**
  //    （`fetchRestrictions.js` の注意書き）。自社アプリで使うのと売るのは重みが違う
  assert.ok(ORIGINS.has("jmpsa"), "記録できる出どころから二普協が消えている");
  assert.ok(!SELLABLE_ORIGINS.has("jmpsa"), "二普協由来を販売APIに載せている");
});

test("JARTIC は販売APIに載せる", () => {
  // ⚠️ 利用規約 第2条「商用利用も可能です」・第6条で CC BY 4.0 互換
  assert.ok(SELLABLE_ORIGINS.has("jartic"), "商用可の JARTIC を外している");
  assert.ok(SELLABLE_ORIGINS.has("osm"), "ODbL の OSM を外している（商用可）");
  assert.ok(SELLABLE_ORIGINS.has("survey"), "自前の調査を外している");
});

test("由来を憶測で埋めない", () => {
  // ⚠️ **分からないものは null のまま。** 「記録が無いものは売らない」がそこで効く
  assert.strictEqual(originFromId("2024-kanagawa-01"), null);
  assert.strictEqual(originFromId(undefined), null);
  assert.strictEqual(originFromId(""), null);
  assert.strictEqual(normalizeOrigin("でたらめ", "2024-kanagawa-01"), null,
    "知らない値をそのまま記録している");
});

test("候補の id から由来が付く", () => {
  // ⚠️ 画面を変えずに埋めるための仕掛け。取り込み側の前置きを引き継ぐ
  assert.strictEqual(originFromId("jartic-14202606000002800000053700100057"), "jartic");
  assert.strictEqual(originFromId("osm-ishikawa-26827564"), "osm");
  assert.strictEqual(normalizeOrigin(undefined, "jartic-abc"), "jartic");
  // 明示された値が優先される（人が画面で直した場合）
  assert.strictEqual(normalizeOrigin("survey", "jartic-abc"), "survey");
});

test("記録の無いものは販売APIに載らない", () => {
  assert.strictEqual(isSellable({ origin: null }), false);
  assert.strictEqual(isSellable({}), false);
  assert.strictEqual(isSellable(null), false);
  assert.strictEqual(isSellable({ origin: "jmpsa" }), false);
  assert.strictEqual(isSellable({ origin: "jartic" }), true);
});

test("いま登録されているものは、販売APIにほとんど載らない", () => {
  // ⚠️ **これが今回の判断そのもの。** 279件は由来の記録が無いので外れる。
  //    JARTIC の候補から作り直したぶんだけ、順に載っていく
  const dir = path.join(__dirname, "..", "data", "road-restrictions");
  if (!fs.existsSync(dir)) return;
  let total = 0;
  let sellable = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const r of d.restrictions || []) {
      total++;
      if (isSellable(r)) sellable++;
    }
  }
  assert.ok(total > 0, "規制が1件も無い（材料が悪い）");
  assert.ok(sellable < total,
    `${total}件すべてが販売対象になっている。由来の記録を確かめること`);
});

test("出典を応答に載せる用意がある", () => {
  // ⚠️ **義務。** OSM は ODbL で表示が要り、JARTIC は規約で出典と加工の明記を求めている。
  //    ⚠️ 配信物のファイルには入っていなかった（Firestore へ上げるときだけ付いていた）
  const text = ATTRIBUTION.join("\n");
  assert.ok(/OpenStreetMap contributors/.test(text), "OSM の表示が無い");
  assert.ok(/ODbL/.test(text), "ODbL の記載が無い");
  assert.ok(/日本道路交通情報センター/.test(text), "JARTIC の出典が無い");
  assert.ok(/加工/.test(text), "加工した旨が無い（JARTIC の規約が求めている）");
});

test("保存の入口が、由来を記録している", () => {
  // ⚠️ ここが外れると、JARTIC から作ったものまで「記録なし」になり、
  //    販売APIが永久に空のままになる
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(server.includes("origin: normalizeOrigin(r.origin, r.id)"),
    "登録のときに由来を記録していない");
  assert.ok(server.includes("opts.sellableOnly ? out.filter(isSellable)"),
    "販売向けの絞り込みが入っていない");
});
