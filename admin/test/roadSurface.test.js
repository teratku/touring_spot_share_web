"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadSurfaces, measureUnpaved, labelFor, worstSurface, key,
  LABELS, TRACKTYPE_LABELS, SEVERITY,
} = require("../lib/roadSurface");
const { distanceMeters } = require("../lib/roadCsv");

/**
 * 道が舗装されているかを扱うところ。
 *
 * ⚠️ 元データは pbf から抜いた data/road-surface.csv。
 *    そこに何が入っているかではなく、**読み替えと測り方**を確かめる。
 */

// MARK: 言い方

test("砂利と未舗装を区別する", () => {
  // ⚠️ **ひとまとめにしないこと。** 砂利道は走れるが気を使う、
  //    土や草は状況次第で入れない。判断が変わる
  assert.strictEqual(labelFor("gravel", ""), "砂利");
  assert.strictEqual(labelFor("unpaved", ""), "未舗装");
  assert.strictEqual(labelFor("dirt", ""), "土");
  assert.notStrictEqual(labelFor("gravel", ""), labelFor("unpaved", ""));
});

test("tracktype しか無くても日本語で出る", () => {
  // ⚠️ 一度ここで間違えた。surface と tracktype を混ぜていたせいで、
  //    画面に「grade3」という生の値がそのまま出た
  for (const grade of Object.keys(TRACKTYPE_LABELS)) {
    const label = labelFor("", grade);
    assert.ok(!/^grade/.test(label), `${grade} が生のまま出ている: ${label}`);
  }
});

test("知らない値は、そのまま出す（黙って捨てない）", () => {
  // ⚠️ OSM には新しい値が増える。知らないからと「未舗装」に丸めると、
  //    何が起きているか分からなくなる
  assert.strictEqual(labelFor("brand_new_surface", ""), "brand_new_surface");
});

test("何も無ければ「未舗装」", () => {
  assert.strictEqual(labelFor("", ""), "未舗装");
});

// MARK: 代表を選ぶ

test("いちばん走りにくいものを代表にする", () => {
  // ⚠️ 「一部が土」なのに「締固め」と出すと、行ってから困る
  assert.strictEqual(worstSurface(["compacted", "dirt"]), "dirt");
  assert.strictEqual(worstSurface(["gravel", "compacted"]), "gravel");
  assert.strictEqual(worstSurface(["mud", "gravel", "compacted"]), "mud");
});

test("知らない値は代表にしない（既知のものを優先）", () => {
  assert.strictEqual(worstSurface(["謎", "dirt"]), "dirt");
});

test("空なら空", () => {
  assert.strictEqual(worstSurface([]), "");
  assert.strictEqual(worstSurface(["", null, undefined]), "");
});

test("走りにくさの順に、砂利より土が前", () => {
  // ⚠️ 順番そのものが判断の中身。入れ替わると代表が変わる
  assert.ok(SEVERITY.indexOf("dirt") < SEVERITY.indexOf("gravel"),
    "土が砂利より後ろになっている");
  assert.ok(SEVERITY.indexOf("gravel") < SEVERITY.indexOf("compacted"),
    "砂利が締固めより後ろになっている");
});

// MARK: 区間のどれだけが未舗装か

//: 東西にまっすぐ並べた点（1点あたり約100m）
const LAT = 35.0;
const line = (n) => Array.from({ length: n }, (_, i) => [139.0 + i * 0.00111, LAT]);

test("一部だけが未舗装でも測れる", () => {
  // ⚠️ **区間は複数の道をつないで作る。** 「この区間の道はどれか」を1つに
  //    決められないので、点をたどって測る
  const pts = line(11);                      // 約1km
  const surface = new Map();
  for (let i = 5; i <= 10; i++) surface.set(key(pts[i]), { surface: "gravel", tracktype: "" });
  const u = measureUnpaved(pts, surface, distanceMeters);
  assert.ok(u, "測れていない");
  assert.strictEqual(u.surface, "gravel");
  // 点5〜10のあいだ＝5区間ぶん。全体は10区間なので約50%
  assert.ok(Math.abs(u.ratio - 0.5) < 0.05, `割合が ${u.ratio}（0.5 のはず）`);
});

test("入口の1区間まで未舗装に数えない", () => {
  // ⚠️ **両端とも未舗装の道の上にあるときだけ数える。** 片方だけで数えると、
  //    舗装路から砂利道へ入る手前の1区間まで砂利になる
  const pts = line(11);
  const surface = new Map();
  for (let i = 5; i <= 10; i++) surface.set(key(pts[i]), { surface: "gravel", tracktype: "" });
  const u = measureUnpaved(pts, surface, distanceMeters);
  // 点4→点5 は片方だけなので数えない。数えていたら6区間＝60%になる
  assert.ok(u.ratio < 0.55, `手前の1区間まで数えている（${u.ratio}）`);
});

test("未舗装が無ければ null", () => {
  assert.strictEqual(measureUnpaved(line(11), new Map(), distanceMeters), null);
});

test("点が足りなければ null（落ちない）", () => {
  assert.strictEqual(measureUnpaved([[139, 35]], new Map(), distanceMeters), null);
  assert.strictEqual(measureUnpaved(null, new Map(), distanceMeters), null);
});

test("複数の種類が混じったら、走りにくい方を出す", () => {
  const pts = line(11);
  const surface = new Map();
  for (let i = 2; i <= 5; i++) surface.set(key(pts[i]), { surface: "compacted", tracktype: "" });
  for (let i = 6; i <= 9; i++) surface.set(key(pts[i]), { surface: "dirt", tracktype: "" });
  const u = measureUnpaved(pts, surface, distanceMeters);
  assert.strictEqual(u.surface, "dirt", `代表が ${u.surface}（走りにくい dirt のはず）`);
  assert.strictEqual(u.label, "土");
});

test("tracktype だけの道でも、生の値を出さない", () => {
  const pts = line(6);
  const surface = new Map();
  for (const p of pts) surface.set(key(p), { surface: "", tracktype: "grade3" });
  const u = measureUnpaved(pts, surface, distanceMeters);
  assert.ok(u, "測れていない");
  assert.ok(!/^grade/.test(u.label), `生の値が出ている: ${u.label}`);
  assert.strictEqual(u.label, TRACKTYPE_LABELS.grade3);
});

test("tracktype は数の大きい方（走りにくい方）を採る", () => {
  const pts = line(11);
  const surface = new Map();
  for (let i = 0; i <= 5; i++) surface.set(key(pts[i]), { surface: "", tracktype: "grade2" });
  for (let i = 6; i <= 10; i++) surface.set(key(pts[i]), { surface: "", tracktype: "grade5" });
  const u = measureUnpaved(pts, surface, distanceMeters);
  assert.strictEqual(u.tracktype, "grade5", `${u.tracktype} を採っている`);
});

// MARK: 読み込み

test("名前にカンマが入っていても壊れない", () => {
  // ⚠️ CSV の最後の列は道路名。「A, B線」のような名前で列がずれる
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-"));
  const file = path.join(dir, "s.csv");
  fs.writeFileSync(file,
    "osm_id,surface,tracktype,highway,name\n"
    + "111,gravel,,secondary,あ, い線\n"
    + "222,,grade3,track,ふつうの名前\n");
  try {
    const m = loadSurfaces(file);
    assert.strictEqual(m.size, 2, `${m.size}件しか読めていない`);
    assert.strictEqual(m.get("111").surface, "gravel");
    assert.strictEqual(m.get("222").tracktype, "grade3");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ファイルが無くても落ちない（印が付かないだけ）", () => {
  // ⚠️ 舗装のデータが無いだけで、おすすめ道路の生成を止めないこと
  const m = loadSurfaces("/tmp/絶対に無いファイル.csv");
  assert.strictEqual(m.size, 0);
});
