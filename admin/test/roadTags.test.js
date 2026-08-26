"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { TAG_LABELS_JA, PRESET_TAGS, toKey, toKeys, labelJa, isTagKey }
  = require("../lib/roadTags");

/**
 * おすすめ道路の「札」を鍵にするところ。
 *
 * ⚠️ 札は配信データに入り、アプリで音声案内にそのまま乗る。
 *    日本語のまま配ると、海外で日本語が読み上げられる。
 */

test("実際に使われている7語がすべて鍵になる", () => {
  // ⚠️ **実データの語彙。** 手で付けた1,281件で使われているのはこの7つだけ（実測）
  const used = ["快走", "ワインディング", "要注意", "林道ぎみ", "絶景", "砂利道", "行き止まり"];
  for (const ja of used) {
    const key = toKey(ja);
    assert.ok(isTagKey(key), `「${ja}」が鍵にならない（${key} のまま）`);
  }
});

test("鍵から日本語に戻せる（往復して変わらない）", () => {
  for (const [key, label] of Object.entries(TAG_LABELS_JA)) {
    assert.strictEqual(labelJa(key), label);
    assert.strictEqual(toKey(label), key, `「${label}」→ 鍵 が合わない`);
  }
});

test("二度掛けても壊れない", () => {
  // ⚠️ 変換が途中で止まったファイルに、もう一度掛けられること
  const once = toKeys(["快走", "ワインディング"]);
  const twice = toKeys(once);
  assert.deepStrictEqual(twice, once, "二度目で変わっている");
});

test("知らない鍵は、表示名もそのまま出す", () => {
  // ⚠️ **空にしないこと。** 自由記述の札（画面で手入力できる）が
  //    画面から消えてしまう。移行期間に古い配信データの日本語が来ても同じ
  assert.strictEqual(labelJa("海沿い"), "海沿い");
  assert.strictEqual(labelJa("unknown_key"), "unknown_key");
  // 空文字も落とさない（呼ぶ側が判断する）
  assert.strictEqual(labelJa(""), "");
});

test("知らない札はそのまま残す", () => {
  // ⚠️ 自由記述（画面で手入力できる）を落とさないこと
  assert.strictEqual(toKey("海沿いが気持ちいい"), "海沿いが気持ちいい");
  assert.deepStrictEqual(toKeys(["快走", "謎の札"]), ["flowing", "謎の札"]);
});

test("同じ札が二つ入らない", () => {
  assert.deepStrictEqual(toKeys(["快走", "flowing", "快走"]), ["flowing"]);
});

test("空や壊れた値で落ちない", () => {
  assert.deepStrictEqual(toKeys(null), []);
  assert.deepStrictEqual(toKeys([]), []);
  assert.deepStrictEqual(toKeys(["", "  "]), []);
  assert.strictEqual(toKey(null), null);
  assert.strictEqual(toKey(123), 123);
});

test("画面に出す並びは、すべて鍵", () => {
  for (const t of PRESET_TAGS) {
    assert.ok(isTagKey(t), `画面の並びに鍵でないものがある: ${t}`);
  }
  assert.strictEqual(new Set(PRESET_TAGS).size, PRESET_TAGS.length, "並びに重複がある");
});

test("鍵に日本語が混ざっていない", () => {
  // ⚠️ 鍵は配信データに入る。ここが日本語だと鍵にした意味がない
  const japanese = /[぀-ヿ一-鿿]/;
  for (const key of Object.keys(TAG_LABELS_JA)) {
    assert.ok(!japanese.test(key), `鍵に日本語が入っている: ${key}`);
  }
});

// MARK: 実データ

const OVERRIDE_DIR = path.join(__dirname, "..", "data", "road-overrides");
const hasData = fs.existsSync(OVERRIDE_DIR);

test("実データの札が、すべて鍵に変換できる", (t) => {
  if (!hasData) return t.skip("手元にデータが無い環境");
  // ⚠️ **変換して初めて分かる取りこぼしを、ここで捕まえる。**
  //    自由記述が混ざっていたら、その語を報告する（対応表に足すか決めるため）
  const unknown = new Map();
  let total = 0;
  for (const f of fs.readdirSync(OVERRIDE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const j = JSON.parse(fs.readFileSync(path.join(OVERRIDE_DIR, f), "utf8"));
    // ⚠️ **`added`（手で足した道）も見ること。** `overrides` だけ見ていて、
    //    配信データに日本語が2件残った（ぐるり富士山風景街道）
    for (const bucket of ["overrides", "added"]) {
      for (const o of Object.values(j[bucket] || {})) {
        for (const tag of o.tags || []) {
          total++;
          const key = toKey(tag);
          if (!isTagKey(key)) unknown.set(tag, (unknown.get(tag) || 0) + 1);
        }
      }
    }
  }
  assert.ok(total > 0, "札が1件も無い（データを読めていない）");
  assert.deepStrictEqual([...unknown.entries()], [],
    `対応表に無い札がある: ${[...unknown.entries()].map(([t, n]) => `${t}(${n})`).join(" ")}`);
});

// MARK: 画面と揃っていること

/**
 * ⚠️ **管理画面（road-builder.html）にも同じ対応表がある。** ずれると、
 *    画面で付けた札と配信データが食い違う。
 *    `RoadReviewView.swift` の口コミ用プリセットが既に食い違っている前例があるので、
 *    ここは機械で縛る。
 */
test("管理画面の対応表が、ライブラリと揃っている", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");

  // TAG_LABELS の中身を読む
  const labelsBlock = html.match(/const TAG_LABELS = \{([\s\S]*?)\};/);
  assert.ok(labelsBlock, "画面に TAG_LABELS が無い");
  const pairs = [...labelsBlock[1].matchAll(/(\w+):\s*"([^"]+)"/g)];
  const fromHtml = Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
  assert.deepStrictEqual(fromHtml, TAG_LABELS_JA,
    "画面と lib/roadTags.js の対応表が違う");

  // PRESET_TAGS の並びも揃っていること
  const presetBlock = html.match(/const PRESET_TAGS = \[([^\]]*)\];/);
  assert.ok(presetBlock, "画面に PRESET_TAGS が無い");
  const htmlPresets = [...presetBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(htmlPresets, PRESET_TAGS, "画面の並びが違う");
});

test("配信データに日本語の札が残っていない", (t) => {
  const dir = path.join(__dirname, "..", "data", "road-overrides");
  if (!fs.existsSync(dir)) return t.skip("手元にデータが無い環境");
  // ⚠️ 変換の取りこぼしを捕まえる。**移行後にここが赤くなったら、配信してはいけない**
  const japanese = /[぀-ヿ一-鿿]/;
  const found = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;      // .bak は見ない
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const bucket of ["overrides", "added"]) {
      for (const [key, o] of Object.entries(j[bucket] || {})) {
        for (const tag of o.tags || []) {
          if (japanese.test(tag)) found.push(`${f}: ${bucket}.${key} → ${tag}`);
        }
      }
    }
  }
  assert.deepStrictEqual(found.slice(0, 5), [],
    `日本語の札が残っている（${found.length}件）`);
});
