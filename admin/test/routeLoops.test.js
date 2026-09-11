"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { loops, loopBands, isWasteful, interiorOf, holdsVia, viasToKeep } = require("../lib/routeLoops");

/** 東へ meters ぶん進む線（10m刻み） */
function east(from, meters) {
  const step = 10 / (111320 * Math.cos(from[1] * Math.PI / 180));
  const out = [];
  for (let m = 0; m <= meters; m += 10) out.push([from[0] + step * (m / 10), from[1]]);
  return out;
}

test("走ってきた場所へ戻る形を拾う", () => {
  // 東へ300m → 北へ100m → 西へ300m → 南へ100m（元の場所へ戻る四角）
  const start = [139.0, 35.0];
  const dLat = 100 / 111320;
  const pts = [];
  for (const p of east(start, 300)) pts.push(p);
  const right = pts[pts.length - 1];
  for (let m = 10; m <= 100; m += 10) pts.push([right[0], right[1] + dLat * (m / 100)]);
  const top = pts[pts.length - 1];
  for (let m = 10; m <= 300; m += 10) pts.push([top[0] - (top[0] - start[0]) * (m / 300), top[1]]);
  const left = pts[pts.length - 1];
  for (let m = 10; m <= 100; m += 10) pts.push([left[0], left[1] - dLat * (m / 100)]);

  const found = loops(pts);
  assert.equal(found.length, 1, `輪が ${found.length} 本（1本のはず）`);
  assert.ok(found[0].meters > 700 && found[0].meters < 900,
    `輪の長さが ${Math.round(found[0].meters)}m（約800mのはず）`);
});

test("まっすぐな線は輪にしない", () => {
  assert.equal(loops(east([139.0, 35.0], 3_000)).length, 0, "まっすぐなのに輪と言っている");
});

test("短すぎる折り返しは拾わない", () => {
  // ⚠️ 交差点の中で戻る形（数十m）まで拾うと、全部が輪になる
  const start = [139.0, 35.0];
  const pts = [...east(start, 60)];
  const back = [...pts].reverse();
  assert.equal(loops(pts.concat(back)).length, 0, "60mの折り返しを輪と言っている");
});

test("大きい輪が中の小さい輪を飲み込まない", () => {
  // ⚠️ **これが実機で報告された輪が1本も出てこなかった原因。**
  //    重なる輪をまとめて「一番長いもの」だけ残していたため、26.9kmの輪が
  //    中の小さな輪を全部飲み込んでいた（実測: 野火止→オギノパン・西まわり広め）。
  //    材料: 東へ2km → 300mの四角 → 西へ2km で元に戻る（大きい輪の中に小さい輪）
  const start = [139.0, 35.0];
  const step = 10 / (111320 * Math.cos(start[1] * Math.PI / 180));
  const dLat = 100 / 111320;
  const pts = [];
  for (let m = 0; m <= 2_000; m += 10) pts.push([start[0] + step * (m / 10), start[1]]);
  const corner = pts[pts.length - 1];
  //: 100m四方の四角（周囲400m）
  for (let m = 10; m <= 100; m += 10) pts.push([corner[0], corner[1] + dLat * (m / 100)]);
  for (let m = 10; m <= 100; m += 10) pts.push([corner[0] + step * (m / 10), corner[1] + dLat]);
  for (let m = 10; m <= 100; m += 10) pts.push([corner[0] + step * 10, corner[1] + dLat * (1 - m / 100)]);
  for (let m = 10; m <= 100; m += 10) pts.push([corner[0] + step * (10 - m / 10), corner[1]]);
  //: 来た道を戻る
  for (let m = 2_000; m >= 0; m -= 10) pts.push([start[0] + step * (m / 10), start[1]]);

  const 帯 = loopBands(pts);
  assert.ok(帯.some((l) => l.meters < 1_000),
    `小さい輪が出てこない: ${帯.map((l) => Math.round(l.meters)).join(",")}m`);
  assert.ok(帯.some((l) => l.meters >= 3_000),
    `大きい輪が出てこない: ${帯.map((l) => Math.round(l.meters)).join(",")}m`);
});

test("重なったら一番小さい輪を残す", () => {
  // ⚠️ **塞ぐ範囲は小さいほどよい。** 大きい方を残すと、余計な道まで塞ぐ。
  //    実測（野火止→オギノパン・北まわり広め132.8km）: 小さい方を残すと
  //    287m を塞げば済むところ、大きい方を残すと 4,998m を塞ぐことになった。
  //    材料: 100m進む → 100m四方の四角（周囲400m） → 100m戻る
  //    （四角400m と 全体600m の2つが同じ帯の中で重なる）
  const start = [139.0, 35.0];
  const step = 10 / (111320 * Math.cos(start[1] * Math.PI / 180));
  const dLat = 100 / 111320;
  const pts = [];
  for (let m = 0; m <= 100; m += 10) pts.push([start[0] + step * (m / 10), start[1]]);
  const c = pts[pts.length - 1];
  for (let m = 10; m <= 100; m += 10) pts.push([c[0], c[1] + dLat * (m / 100)]);
  for (let m = 10; m <= 100; m += 10) pts.push([c[0] + step * (m / 10), c[1] + dLat]);
  for (let m = 10; m <= 100; m += 10) pts.push([c[0] + step * 10, c[1] + dLat * (1 - m / 100)]);
  for (let m = 10; m <= 100; m += 10) pts.push([c[0] + step * (10 - m / 10), c[1]]);
  for (let m = 10; m <= 100; m += 10) pts.push([c[0] - step * (m / 10), c[1]]);

  const 輪 = loopBands(pts);
  assert.ok(輪.length > 0, "材料が悪い: 輪が出ていない");
  const 一番小さい = Math.min(...輪.map((l) => l.meters));
  assert.ok(一番小さい < 500,
    `内側の四角（約400m）ではなく外側を残している: ${輪.map((l) => Math.round(l.meters)).join(",")}m`);
});

test("大きな往復を見落とさない", () => {
  // ⚠️ **固定の上限（5,000m）で切っていたため、実測（現在地→道の駅大滝温泉→
  //    広瀬ダム・442.6km）の **119.7kmの往復**がまったく見えていなかった。
  //    上限は経路の長さに対する割合で決める。
  //    材料: 60km 行って 60km 戻る（全長120km の経路にある120kmの輪…ではなく、
  //    全長を240kmとして半分の120kmに収まる形にする）
  const start = [139.0, 35.0];
  const step = 100 / (111320 * Math.cos(start[1] * Math.PI / 180));   // 100m刻み
  const pts = [];
  for (let m = 0; m <= 60_000; m += 100) pts.push([start[0] + step * (m / 100), start[1]]);
  for (let m = 60_000; m >= 0; m -= 100) pts.push([start[0] + step * (m / 100), start[1]]);

  const 見える = loopBands(pts, 240_000);
  assert.ok(見える.some((l) => l.meters > 50_000),
    `大きな往復が出てこない: ${見える.map((l) => Math.round(l.meters / 1000)).join(",")}km`);
});

test("周回の旅で経路まるごとを輪とみなさない", () => {
  // ⚠️ 出発と行き先が同じ旅では、経路まるごとが1つの輪に見える。
  //    それを塞ぐと経路が壊れる。経路の半分までにしておけば拾わない。
  //    ⚠️ **材料は「行って戻る」ではなく本物の周回にすること。**
  //       行って戻る形は入れ子の輪が無数にでき、小さいほうが残るので
  //       上限が効いているかを確かめられない（最初そうなっていた）
  const 中心 = [139.0, 35.0];
  const 半径 = 10_000;                       // 半径10km ≒ 周長63km
  const dLat = 半径 / 111320;
  const dLng = 半径 / (111320 * Math.cos(中心[1] * Math.PI / 180));
  const pts = [];
  for (let i = 0; i <= 720; i++) {
    const t = (i / 720) * 2 * Math.PI;
    pts.push([中心[0] + dLng * Math.cos(t), 中心[1] + dLat * Math.sin(t)]);
  }
  const 周長 = 2 * Math.PI * 半径;
  // 材料の確認: 上限を外せば周回そのものが輪として出ること
  assert.ok(loopBands(pts, 周長, { maxRatio: 10 }).some((l) => l.meters > 周長 * 0.9),
    "材料が悪い: 上限を外しても周回が輪として出ない");
  // 本体: 経路の半分までなので、周回そのものは拾わない
  assert.equal(loopBands(pts, 周長).length, 0, "周回そのものを輪として拾っている");
});

test("同じ帯に多すぎるときは大きいものから確かめる", () => {
  // ⚠️ 全体で40本を頭から取っていたため、実測で 200〜1,000m の38本が枠を
  //    食い潰し、**119.7kmの往復が一度も確かめられなかった**。
  //    帯ごとに枠を分け、その中では**大きいものから**取る。
  // ⚠️ **材料は円にすること。** 四角や往復では、角や折り返しで最小の輪が
  //    取られてしまい、どれも同じ大きさになって並び順を確かめられない
  //    （最初そうなっていた: 12個すべて210m）
  const start = [139.0, 35.0];
  const mLat = 111320;
  const mLng = 111320 * Math.cos(start[1] * Math.PI / 180);
  const pts = [];
  const 半径 = [];
  for (let n = 0; n < 12; n++) {
    const r = 40 + n * 10;                       // 周長 251〜942m（全部が同じ帯）
    半径.push(r);
    const c = [start[0] + (n * 1_000) / mLng, start[1]];
    for (let i = 0; i <= 180; i++) {
      const t = (i / 180) * 2 * Math.PI;
      pts.push([c[0] + (r / mLng) * Math.cos(t), c[1] + (r / mLat) * Math.sin(t)]);
    }
    // 次の円まで直線でつなぐ
    for (let m = 10; m <= 900; m += 10) pts.push([c[0] + (r + m) / mLng, c[1]]);
  }
  const 全部 = loops(pts, { minAlongMeters: 200, maxAlongMeters: 1_000 });
  assert.ok(全部.length > 8,
    `材料が悪い: 帯に ${全部.length}本 しかなく、枠あふれを作れない`);
  const 出た = loopBands(pts, 1_000_000).filter((l) => l.meters < 1_000);
  assert.ok(出た.length <= 8, `帯ごとの枠（8本）が効いていない: ${出た.length}本`);
  // ⚠️ 枠に入りきらないとき、**大きいほう**が残ること
  const 最大 = Math.max(...全部.map((l) => l.meters));
  assert.ok(出た.some((l) => Math.abs(l.meters - 最大) < 1),
    `大きいほうを捨てている（帯の最大${Math.round(最大)}m / 出たのは`
    + `${出た.map((l) => Math.round(l.meters)).join(",")}m）`);
});

test("立ち寄り先を含む往復は触らない", () => {
  // ⚠️ **同じ道を戻ってよいのは立ち寄り先へ寄るときだけ**（実機で明言された）。
  //    おすすめ道路は「上りか下りのどちらか一度だけ通って、出口からそのまま進む」。
  //    ⚠️ 幾何では区別できない——20kmの往復でも折り返しの200mは輪として出る。
  //    区別できるのは「そこが立ち寄り先か」だけ。
  //    ⚠️ ここにおすすめ道路の中継点まで渡すと、消すべき往復が1本も残らない
  //       （実測: 野火止→オギノパンの5候補すべてで0本になった）。
  const start = [139.0, 35.0];
  const step = 10 / (111320 * Math.cos(start[1] * Math.PI / 180));
  const pts = [];
  for (let m = 0; m <= 3_000; m += 10) pts.push([start[0] + step * (m / 10), start[1]]);
  for (let m = 3_000; m >= 0; m -= 10) pts.push([start[0] + step * (m / 10), start[1]]);
  const 折り返し = pts[300];

  const 輪 = loopBands(pts);
  assert.ok(輪.length > 0, "材料が悪い: 往復なのに輪が出ていない");
  assert.ok(輪.every((l) => holdsVia(pts, l, [折り返し])),
    "折り返しに立ち寄り先があるのに、触ってよい輪として残っている");
  assert.ok(輪.some((l) => !holdsVia(pts, l, [[140.0, 36.0]])),
    "関係ない場所の立ち寄り先でも守られてしまっている");
});

test("守るのは立ち寄り先だけで、おすすめ道路の中継点は守らない", () => {
  // ⚠️ **これを取り違えると、消すべき往復が1本も残らない**
  //    （実測: 野火止→オギノパンの5候補すべてで0本になった）。
  //    利用者の意図は「おすすめ道路は一度だけ通って出口からそのまま進む」で、
  //    同じ道の反対車線を戻ってよいのは立ち寄り先へ寄るときだけ。
  const vias = [[139.1, 35.1], [139.2, 35.2], [139.3, 35.3]];
  assert.deepStrictEqual(viasToKeep(vias, [1]), [[139.2, 35.2]],
    "立ち寄り先だけを守っていない");
  assert.deepStrictEqual(viasToKeep(vias, []), [],
    "立ち寄り先が無いのに中継点を守っている");
  assert.deepStrictEqual(viasToKeep(vias, [0, 2]), [[139.1, 35.1], [139.3, 35.3]],
    "立ち寄り先が複数あるときに取りこぼしている");
});

test("近道があれば無駄、無ければ必要", () => {
  // 実測: 無駄な輪 8,858m に対し直接36m / ヘアピン 326m に対し直接326m
  assert.ok(isWasteful(8_858, 36), "近道があるのに必要と言っている");
  assert.ok(!isWasteful(326, 326), "ヘアピンを無駄と言っている");
  assert.ok(!isWasteful(326, 324), "1.00倍を無駄と言っている");
});

test("直接引けなければ無駄とみなさない", () => {
  // ⚠️ 引けない＝近道が無いということ。塞いだら経路ごと壊れる
  assert.ok(!isWasteful(8_858, null), "引けないのに無駄と言っている");
});

test("塞ぐのは輪の中ほどだけ", () => {
  // ⚠️ 出入口は通り抜ける道の上。そこまで塞ぐと経路ごと引けなくなる
  const pts = east([139.0, 35.0], 1_000);
  const inner = interiorOf(pts, { begin: 0, end: pts.length - 1 });
  assert.ok(inner, "中ほどが取れない");
  assert.notDeepStrictEqual(inner[0], pts[0], "入口まで塞いでいる");
  assert.notDeepStrictEqual(inner[inner.length - 1], pts[pts.length - 1], "出口まで塞いでいる");
  assert.ok(inner.length < pts.length, "全部塞いでいる");
});

test("点が少なすぎる輪は塞がない", () => {
  assert.equal(interiorOf([[139, 35], [139.001, 35]], { begin: 0, end: 1 }), null,
    "2点しかないのに塞ごうとしている");
});
