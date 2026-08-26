"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { ROMAJI } = require("../lib/prefectureRomaji");

/**
 * 配信データの「地域」の持ち方。
 *
 * ⚠️ **海外を足すときに、IDの形を変えなくて済むようにするためのもの。**
 *    出荷済みアプリは `山梨県:0` を `:` で割って県名を取り出しているので、
 *    IDを変えると表示が壊れる。地域は別の項目で持つ。
 */

const DIR = path.join(__dirname, "..", "data", "road-recommend");
const hasData = fs.existsSync(DIR);
const skipIfNoData = (t) => (hasData ? false : t.skip("配信データが無い環境"));

const files = () => fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));

test("区間IDの形を変えていない", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ **これが変わったら出荷済みアプリが壊れる。**
  //    `RoadRecommendStore.swift:60-65` が `:` で割って県名を取り出している
  for (const f of files()) {
    const j = load(f);
    for (const s of (j.segments || []).slice(0, 3)) {
      const [head] = String(s.id).split(":");
      assert.strictEqual(head, j.prefecture,
        `${f} の id が「${s.id}」。頭は県名（${j.prefecture}）のままであること`);
    }
  }
});

test("すべての区間が region と regionName を持つ", (t) => {
  if (skipIfNoData(t)) return;
  const missing = [];
  let total = 0;
  for (const f of files()) {
    for (const s of load(f).segments || []) {
      total++;
      if (!s.region || !s.regionName) missing.push(`${f}: ${s.id}`);
    }
  }
  assert.ok(total > 0, "区間が1件も無い");
  assert.deepStrictEqual(missing.slice(0, 3), [],
    `region が無い区間が ${missing.length}件`);
});

test("region は不透明な小文字ローマ字", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ ここに日本語が入ると、海外の地域を足したとき形が揃わない
  for (const f of files()) {
    const j = load(f);
    const s = (j.segments || [])[0];
    if (!s) continue;
    assert.match(s.region, /^[a-z][a-z0-9-]*$/,
      `${f} の region が「${s.region}」。小文字ローマ字であること`);
  }
});

test("region はファイル名と揃っている", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ 配信のファイル名が鍵なので、中身とずれていると探せなくなる
  for (const f of files()) {
    const j = load(f);
    const s = (j.segments || [])[0];
    if (!s) continue;
    assert.strictEqual(s.region, f.replace(/\.json$/, ""),
      `${f} の region が中身とずれている`);
  }
});

test("regionName は表示用の名前", (t) => {
  if (skipIfNoData(t)) return;
  for (const f of files()) {
    const j = load(f);
    const s = (j.segments || [])[0];
    if (!s) continue;
    assert.strictEqual(s.regionName, j.prefecture,
      `${f} の regionName がファイルの prefecture と違う`);
    // 日本の県なので、ローマ字表に載っていること
    assert.strictEqual(ROMAJI[s.regionName], s.region,
      `${f} の regionName と region の対応が違う`);
  }
});

test("札が鍵になっている（日本語が無い）", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ 札は音声案内にそのまま乗る。日本語のまま配ると海外で読み上げられる
  const japanese = /[぀-ヿ一-鿿]/;
  const found = [];
  for (const f of files()) {
    for (const s of load(f).segments || []) {
      for (const tag of s.tags || []) if (japanese.test(tag)) found.push(`${f}: ${s.name} → ${tag}`);
    }
  }
  assert.deepStrictEqual(found.slice(0, 3), [],
    `日本語の札が残っている（${found.length}件）`);
});
