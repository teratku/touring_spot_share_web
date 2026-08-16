"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { blockedSegments } = require("../lib/restrictionOverlap");
const { encode, decode } = require("../lib/polyline");

/**
 * 二輪が通れない道を、おすすめ道路から外せているか。
 *
 * 【なぜこのファイルがあるか】
 * ⚠️ この除外は**一度も働いていなかった**。おすすめ道路の区間は `polyline`
 *    （符号化した文字列）を持っていて `points` は持っていないのに、`seg.points` を
 *    渡していた。`findOverlaps` は形の無い道を黙って飛ばすので、
 *    **エラーも警告も出ず「0本除外」と出るだけ**だった。
 *    栃木で0本だったのを「規制が重ならなかったのだろう」と読んで見落とした。
 *
 * ⚠️ だからこのテストでは、**必ず配信データと同じ形（`polyline` を持ち
 *    `points` を持たない）の区間を渡すこと**。`points` 付きで渡すと、
 *    まさに壊れていた経路を通らずに通ってしまう。
 */

/** 配信データと同じ形の区間を作る（`points` は持たせない） */
function segment(name, points) {
  const seg = { name, polyline: encode(points), pointCount: points.length };
  assert.strictEqual(seg.points, undefined, "テストの材料が配信データの形になっていない");
  return seg;
}

/** 規制1件（`data/road-restrictions/<romaji>.json` の1要素と同じ形） */
function restriction(name, points, kind = "noMotorcycle") {
  return { id: `t-${name}`, name, kind, polyline: encode(points) };
}

/** 南北にまっすぐ伸びる線。1点あたり約111m */
const straight = (lat, lng, count) =>
  [...Array(count)].map((_, i) => [lng, lat + i * 0.001]);

test("規制と重なる区間を外す", () => {
  const road = straight(36.0, 139.0, 20);          // 約2.1km
  const found = blockedSegments([restriction("規制", road)], [segment("おすすめ", road)]);
  assert.ok(found.has(0), "重なっているのに外していない");
  assert.strictEqual(found.get(0)[0].name, "規制");
});

test("区間が polyline しか持たなくても外せる", () => {
  // ⚠️ **これが見落としていた不具合そのもの。** 配信データの区間は `points` を持たない
  const road = straight(35.5, 138.5, 25);
  const seg = segment("おすすめ", road);
  assert.strictEqual(seg.points, undefined, "材料に points が付いている（不具合を再現できない）");
  assert.ok(blockedSegments([restriction("規制", road)], [seg]).has(0),
            "polyline だけの区間を飛ばしている（この除外が空振りする）");
});

test("離れた道は外さない", () => {
  const road = straight(36.0, 139.0, 20);
  const far = straight(36.0, 139.5, 20);           // 約45km east
  assert.strictEqual(blockedSegments([restriction("よその規制", far)], [segment("おすすめ", road)]).size,
                     0, "関係の無い道まで外している");
});

test("二人乗り禁止・冬季閉鎖では外さない", () => {
  // ⚠️ 条件次第では走れる。外すとおすすめが不当に減る（警告で伝えるべきもの）
  const road = straight(36.0, 139.0, 20);
  for (const kind of ["noPassenger", "winterClosure"]) {
    assert.strictEqual(blockedSegments([restriction("規制", road, kind)], [segment("おすすめ", road)]).size,
                       0, `${kind} で外している`);
  }
});

test("通行止めは外す", () => {
  const road = straight(36.0, 139.0, 20);
  assert.ok(blockedSegments([restriction("通行止め", road, "closed")], [segment("おすすめ", road)]).has(0),
            "通行止めを見逃している");
});

test("規制が無い県では何も外さない", () => {
  // ⚠️ 登録していない県のおすすめが黙って減る、ということは起きないこと
  const road = straight(36.0, 139.0, 20);
  for (const saved of [[], null, undefined]) {
    assert.strictEqual(blockedSegments(saved, [segment("おすすめ", road)]).size, 0);
  }
});

test("規制の一部にしか掛からない長い道も外す", () => {
  // ⚠️ ホワイトロードで実際に起きた形。規制18.7kmに対しおすすめ区間8.9km。
  //    規制の側を基準に測るので、割合は約36%になる（下限は30%）
  const long = straight(36.2, 136.7, 60);
  const part = long.slice(0, 25);
  const found = blockedSegments([restriction("長い規制", long)], [segment("一部だけの区間", part)]);
  assert.ok(found.has(0), `一部しか重ならない道を外していない（割合 ${
    found.size ? found.get(0)[0].ratio : "0"}）`);
});

// MARK: 実データ（あれば）

const recDir = path.join(__dirname, "..", "data", "road-recommend");
const resDir = path.join(__dirname, "..", "data", "road-restrictions");

test("配信中のおすすめに、登録済みの規制と重なるものが残っていない", (t) => {
  if (!fs.existsSync(recDir) || !fs.existsSync(resDir)) return t.skip("配信データが未生成");
  const problems = [];
  let checked = 0;
  for (const f of fs.readdirSync(resDir).filter((x) => x.endsWith(".json"))) {
    const rec = path.join(recDir, f);
    if (!fs.existsSync(rec)) continue;
    const saved = JSON.parse(fs.readFileSync(path.join(resDir, f), "utf8")).restrictions || [];
    const segments = JSON.parse(fs.readFileSync(rec, "utf8")).segments || [];
    checked++;
    for (const [index, hits] of blockedSegments(saved, segments)) {
      problems.push(`${f}: ${segments[index].name} ← ${hits.map((h) => h.name).join("・")}`);
    }
  }
  if (!checked) return t.skip("突き合わせられる県が無い");
  // ⚠️ ここが赤くなったら、その県を作り直すこと（buildRoadRecommend.js --build --prefecture）。
  //    走れない道をおすすめとして配信している状態
  assert.deepStrictEqual(problems, [],
    "二輪が通れない道がおすすめに残っている（該当県を作り直すこと）");
});
