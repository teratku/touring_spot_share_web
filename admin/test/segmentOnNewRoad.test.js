"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 既に登録した規制の「道筋」を地図で指し直したとき、区間をどこに置き直すか。
 *
 * ⚠️ 元の区間をそのまま残すと、新しい道の上に無いので「始」「終」をドラッグできない
 *    （つまみは道の上にしか乗らない）。かといって新しい道の真ん中に置くと、
 *    長い道に差し替えたときに直したい場所から何kmも離れたところへ飛ぶ。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const match = html.match(/function segmentOnNewRoad\(chain, old\) \{[\s\S]*?\n\}/);

test("画面側に segmentOnNewRoad がある", () => {
  assert.ok(match, "road-builder.html から segmentOnNewRoad を取り出せない");
});

const segmentOnNewRoad = new Function(`${match[0]}; return segmentOnNewRoad;`)();

/** 北へ 0.0001 度ずつ進む点列 */
const line = (count, lat0 = 35.0) =>
  [...Array(count)].map((_, i) => ({ lat: lat0 + i * 0.0001, lng: 139.0 }));

test("元の区間の近くに置き直す", () => {
  // 100点の新しい道に対し、元の区間は 70〜74 番のあたりにあった
  const chain = line(100);
  const old = chain.slice(70, 75);

  const result = segmentOnNewRoad(chain, old);

  const lats = result.map((p) => p.lat);
  assert.ok(Math.min(...lats) <= chain[72].lat && chain[72].lat <= Math.max(...lats),
            "元の区間の真ん中が新しい区間に入っていない");
});

test("長い道に差し替えても真ん中へ飛ばさない", () => {
  // ⚠️ ここが今回の急所。10kmの道に差し替えたとき、端にあった規制が
  //    道の真ん中（5km先）に置かれてしまうと直しようがない
  const chain = line(1000);
  const old = chain.slice(10, 15);

  const result = segmentOnNewRoad(chain, old);

  const middle = chain[500].lat;
  const lats = result.map((p) => p.lat);
  assert.ok(Math.max(...lats) < middle, "道の真ん中へ飛んでいる");
});

test("置き直した区間は必ず新しい道の上にある", () => {
  // ⚠️ 1点でも新しい道の外にあると、つまみが乗らずドラッグできない
  const chain = line(100);
  const old = [{ lat: 35.5, lng: 139.9 }];        // まったく別の場所にあった区間

  const result = segmentOnNewRoad(chain, old);

  const onChain = (p) => chain.some((q) => q.lat === p.lat && q.lng === p.lng);
  assert.ok(result.length > 0, "区間が空");
  assert.ok(result.every(onChain), "新しい道の上に無い点が混ざっている");
});

test("元の区間が無ければ新しい道の真ん中に置く", () => {
  const chain = line(100);

  const result = segmentOnNewRoad(chain, []);

  const lats = result.map((p) => p.lat);
  assert.ok(Math.min(...lats) <= chain[50].lat && chain[50].lat <= Math.max(...lats));
});

test("道の端に寄っていてもはみ出さない", () => {
  // ⚠️ slice の範囲を丸めていないと、先頭側で負の添字になり空配列になる
  const chain = line(50);
  for (const old of [chain.slice(0, 2), chain.slice(48, 50)]) {
    const result = segmentOnNewRoad(chain, old);
    assert.ok(result.length >= 2, "端で区間が消えた");
    assert.ok(result.every((p) => chain.includes(p)), "道の外へはみ出した");
  }
});

test("短い道でも2点以上は残す", () => {
  // 点が5つしかない道。1割だと0点になってしまうので下限を置いてある
  const chain = line(5);
  assert.ok(segmentOnNewRoad(chain, chain.slice(2, 3)).length >= 2);
});

test("道が空なら空を返す（落ちない）", () => {
  assert.deepStrictEqual(segmentOnNewRoad([], []), []);
});
