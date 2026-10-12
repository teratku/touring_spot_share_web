"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { overrideKey, applyOverrides, normalizeOverride, isEmptyOverride } = require("../lib/roadOverrides");

const seg = (name, score, lat = 36.75, lng = 139.60, extra = {}) =>
  ({ id: "x", name, score, lengthKm: 10, start: [lat, lng], end: [lat + 0.1, lng], ...extra });

test("鍵: 道路名と丸めた場所から作る", () => {
  assert.strictEqual(overrideKey(seg("いろは坂", 80, 36.7512, 139.4873)), "いろは坂@36.75,139.49");
});

test("鍵: 1km程度のずれなら同じ鍵になる（再生成で区間が動いても外れない）", () => {
  const a = overrideKey(seg("A", 80, 36.750, 139.600));
  const b = overrideKey(seg("A", 80, 36.752, 139.602));
  assert.strictEqual(a, b);
});

test("非表示にすると一覧から消える", () => {
  const out = applyOverrides([seg("良い道", 80), seg("悪い道", 79)],
                             { [overrideKey(seg("悪い道", 79))]: { hidden: true } });
  assert.deepStrictEqual(out.segments.map((s) => s.name), ["良い道"]);
  assert.strictEqual(out.unmatched.length, 0);
});

test("押し上げると順位が上がる（ビーナスライン問題）", () => {
  const list = [seg("一位の道", 84.6), seg("ビーナスライン", 73.9, 36.10, 138.19)];
  const key = overrideKey(list[1]);
  const out = applyOverrides(list, { [key]: { boost: 15 } });
  assert.strictEqual(out.segments[0].name, "ビーナスライン");
  assert.strictEqual(out.segments[0].score, 88.9);
  assert.strictEqual(out.segments[0].boost, 15);
});

test("押し下げもできる", () => {
  const list = [seg("上げたくない道", 84.6), seg("良い道", 80)];
  const out = applyOverrides(list, { [overrideKey(list[0])]: { boost: -20 } });
  assert.strictEqual(out.segments[0].name, "良い道");
});

test("点数は0〜100に収まる", () => {
  const out = applyOverrides([seg("A", 95), seg("B", 5)], {
    [overrideKey(seg("A", 95))]: { boost: 50 },
    [overrideKey(seg("B", 5, 35.0, 138.0))]: { boost: -50 },
  });
  for (const s of out.segments) assert.ok(s.score >= 0 && s.score <= 100, `${s.score}`);
});

test("表示名とひとこと説明を差し替えられる", () => {
  const s = seg("湯河原箱根線", 81.6, 35.15, 139.10);
  const out = applyOverrides([s], {
    [overrideKey(s)]: { title: "椿ライン", note: "相模湾を見下ろす定番", tags: ["絶景"] },
  });
  assert.strictEqual(out.segments[0].title, "椿ライン");
  assert.strictEqual(out.segments[0].name, "湯河原箱根線", "元の名前は残す");
  assert.strictEqual(out.segments[0].note, "相模湾を見下ろす定番");
  assert.deepStrictEqual(out.segments[0].tags, ["絶景"]);
});

test("調整していない区間はそのまま", () => {
  const list = [seg("A", 80), seg("B", 70, 35.0, 138.0)];
  const out = applyOverrides(list, {});
  assert.strictEqual(out.segments.length, 2);
  assert.ok(!("boost" in out.segments[0]));
  assert.ok(!("title" in out.segments[0]));
});

test("区間が3km以内に動いても拾い直す", () => {
  const saved = overrideKey(seg("移動した道", 80, 36.750, 139.600));
  // 再生成で始点が約2.2km 北へ動いた（鍵は変わる）
  const moved = seg("移動した道", 80, 36.770, 139.600);
  assert.notStrictEqual(overrideKey(moved), saved);
  const out = applyOverrides([moved], { [saved]: { boost: 10 } });
  assert.strictEqual(out.segments[0].score, 90, "あいまい照合で当たっていない");
  assert.strictEqual(out.unmatched.length, 0);
});

test("遠すぎる同名の道には当てない（別の場所の同名道路を巻き込まない）", () => {
  const saved = overrideKey(seg("県道1号", 80, 36.75, 139.60));
  const faraway = seg("県道1号", 80, 34.00, 135.00);   // 数百km 離れている
  const out = applyOverrides([faraway], { [saved]: { boost: 30 } });
  assert.strictEqual(out.segments[0].score, 80, "遠い同名道路に当たってしまった");
  assert.deepStrictEqual(out.unmatched, [saved]);
});

test("1つの調整が2つの区間に当たらない", () => {
  const saved = overrideKey(seg("分割された道", 80, 36.750, 139.600));
  const a = seg("分割された道", 80, 36.752, 139.600);
  const b = seg("分割された道", 70, 36.760, 139.600);
  const out = applyOverrides([a, b], { [saved]: { boost: 15 } });
  const boosted = out.segments.filter((s) => s.boost === 15);
  assert.strictEqual(boosted.length, 1);
  assert.strictEqual(boosted[0].score, 95, "近い方に当たっていない");
});

test("当たらなかった調整を知らせる（道が消えた・名前が変わった）", () => {
  const out = applyOverrides([seg("いまある道", 80)], { "消えた道@36.75,139.60": { boost: 10 } });
  assert.deepStrictEqual(out.unmatched, ["消えた道@36.75,139.60"]);
});

test("壊れた調整でも落ちない", () => {
  const s = seg("A", 80);
  const out = applyOverrides([s], {
    [overrideKey(s)]: { boost: "だめ", title: 123, tags: "配列じゃない", hidden: "yes" },
    "鍵の形が違う": { boost: 10 },
  });
  assert.strictEqual(out.segments.length, 1, "hidden が文字列なら非表示にしない");
  assert.strictEqual(out.segments[0].score, 80);
  assert.ok(!("title" in out.segments[0]));
});

test("正規化: 空白だけの文字列は無視", () => {
  const n = normalizeOverride({ title: "   ", note: "\n", tags: ["", " "] });
  assert.strictEqual(n.title, null);
  assert.strictEqual(n.note, null);
  assert.deepStrictEqual(n.tags, []);
});

test("空の調整を判別できる（ファイルに残さないため）", () => {
  assert.ok(isEmptyOverride({}));
  assert.ok(isEmptyOverride({ boost: 0, tags: [] }));
  assert.ok(!isEmptyOverride({ boost: 5 }));
  assert.ok(!isEmptyOverride({ hidden: true }));
  assert.ok(!isEmptyOverride({ note: "ひとこと" }));
});

test("並び順は点数の降順に保たれる", () => {
  const list = [seg("A", 60), seg("B", 90, 35.0, 138.0), seg("C", 75, 34.0, 137.0)];
  const out = applyOverrides(list, { [overrideKey(list[0])]: { boost: 40 } });
  const scores = out.segments.map((s) => s.score);
  assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a));
});

// ---- 非表示にしても下の順位を繰り上げない（利用者の判断 2026-10-12） ----
const { deliveredTop } = require("../lib/roadOverrides");

test("非表示の道は印を付けて残せ（枠に数えるため）、手を入れた点数で並ぶ。既定では今までどおり外す", () => {
  const list = [seg("A", 90), seg("B", 80), seg("C", 70)];
  const key = overrideKey(list[1]);
  const kept = applyOverrides(list, { [key]: { hidden: true, boost: 15 } }, {}, { keepHidden: true }).segments;
  assert.deepStrictEqual(kept.map((s) => s.name), ["B", "A", "C"], "非表示の道を加点したあとの点数で並べていない");
  assert.strictEqual(kept[0].hidden, true, "非表示の印を付けていない");
  assert.ok(!("hidden" in kept[1]), "非表示でない道に印を付けた");
  assert.deepStrictEqual(applyOverrides(list, { [key]: { hidden: true } }).segments.map((s) => s.name), ["A", "C"],
                         "既定でも非表示の道を残した（ほかの呼び出し元が困る）");
});

test("配信する道は、非表示も枠に数えた上位から非表示を外したもの（下の順位を繰り上げない）", () => {
  const ranked = [{ name: "a" }, { name: "b", hidden: true }, { name: "c" }, { name: "d" }, { name: "e", hidden: true }];
  const r = deliveredTop(ranked, 3);
  assert.deepStrictEqual(r.list.map((s) => s.name), ["a", "c"], "非表示の分を下の順位の道で埋めた");
  assert.deepStrictEqual(r.visible.map((s) => s.name), ["a", "c", "d"]);
  assert.strictEqual(r.hiddenCount, 2);
  assert.ok(r.list.every((s) => !("hidden" in s)), "配信に非表示の印が残る");
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "buildRoadRecommend.js"), "utf8");
  assert.match(src, /applyOverrides\(segments, overrides\.overrides, overrides\.added, \{ keepHidden: true \}\)/,
               "生成で非表示の道を残していない（枠に数えられない）");
  assert.match(src, /const delivered = deliveredTop\(adjusted\.segments, TOP\);\n    const top = delivered\.list\.map\(/,
               "生成で配信する道を枠に数えて決めていない");
});
