"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { score, WEIGHTS } = require("../lib/funSegments");

/**
 * 「楽しい道」の点数。
 *
 * ⚠️ **重みの合計を 1.0 に保つこと。** かつて `popularity: 0.15` を入れていたが
 *    信号が常に 0 で、**その重みが丸ごと死んで**いた。点数が 0〜85 にしか伸びず、
 *    他の信号もそのぶん薄まっていた（曲率は 0.35 のつもりで実効 0.41）。
 */

test("重みの合計が 1.0", () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `合計が ${total}（死んだ重みが残っている）`);
});

test("死んだ信号を重みに入れない", () => {
  // ⚠️ 信号側が常に 0 のものに重みを割くと、点数がその割合ぶん伸びなくなる
  assert.ok(!("popularity" in WEIGHTS),
    "走行実績の重みが残っている（利用者をまたいだ集計はまだ無い）");
});

test("満点に届きうる", () => {
  // ⚠️ 死んだ重みがあると、どんな道でも上限が 85 で頭打ちになる
  const perfect = { curviness: 550, flow: 28, lengthMeters: 30000 };
  const value = score(perfect, "secondary").score;
  assert.ok(value > 99, `満点近い道で ${value.toFixed(1)} 点しか出ない`);
});

test("道の性格の順番は変わらない", () => {
  // ⚠️ 比例で配り直したので順位は不変。ここが崩れたら配分を間違えている
  const pass = score({ curviness: 700, flow: 24, lengthMeters: 12000 }, "secondary").score;
  const local = score({ curviness: 350, flow: 15, lengthMeters: 6000 }, "secondary").score;
  const trunk = score({ curviness: 170, flow: 10, lengthMeters: 20000 }, "trunk").score;
  assert.ok(pass > local && local > trunk,
    `順番が崩れた: 峠${pass.toFixed(1)} 県道${local.toFixed(1)} 幹線${trunk.toFixed(1)}`);
});
