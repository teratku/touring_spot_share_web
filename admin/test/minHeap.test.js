"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { MinHeap } = require("../lib/minHeap");

/**
 * 経路探索が「いちばん距離の小さいノード」を取り出すための山の確認。
 *
 * ⚠️ ここが狂うと**遠回りの道が返る**。しかも「落ちる」のではなく
 *    「少し長い線が返る」だけなので、見ていないと気付けない。
 *    経路探索ごしに確かめようとすると、材料によっては狂っていても
 *    たまたま正しい答えが出てしまう（実際そうなった）。だから山を直接試す。
 */

test("小さい順に出てくる", () => {
  const heap = new MinHeap();
  const values = [50, 3, 91, 3, 17, 0, 42, 8];
  values.forEach((v) => heap.push(v, `v${v}`));
  const out = [];
  while (heap.size) out.push(heap.pop().value);
  assert.deepStrictEqual(out, [...values].sort((a, b) => a - b),
                         "小さい順になっていない: " + out.join(","));
});

test("入れながら出しても小さい順を保つ", () => {
  // ⚠️ 経路探索は「取り出して、その先を積んで、また取り出す」を繰り返す。
  //    全部入れてから全部出すだけでは、その使い方を試したことにならない
  const heap = new MinHeap();
  const out = [];
  heap.push(10, null); heap.push(30, null);
  out.push(heap.pop().value);          // 10
  heap.push(20, null); heap.push(5, null);
  out.push(heap.pop().value);          // 5
  heap.push(25, null);
  while (heap.size) out.push(heap.pop().value);
  assert.deepStrictEqual(out, [10, 5, 20, 25, 30],
                         "途中で入れると順番が狂う: " + out.join(","));
});

test("でたらめな順で入れても小さい順に出る", () => {
  // ⚠️ 決め打ちの並びだと、山の一部（右の子を見る・上へ上げる）を
  //    壊しても通ってしまうことがある。多くの並びで試す
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 200; round++) {
    const heap = new MinHeap();
    const values = [];
    const n = 2 + Math.floor(rand() * 60);
    for (let i = 0; i < n; i++) {
      const v = Math.floor(rand() * 100);
      values.push(v);
      heap.push(v, null);
    }
    const out = [];
    while (heap.size) out.push(heap.pop().value);
    assert.deepStrictEqual(out, [...values].sort((a, b) => a - b),
                           `${round}回目（${n}個）で順番が狂った: ` + out.join(","));
  }
});

test("値が同じなら先に入れた方が先に出る", () => {
  // ⚠️ **同じ長さの道が2本あるとき、どちらを返すかがこれで決まる。**
  //    決まっていないと、同じ入力なのに走るたびに違う線が返りうる
  const heap = new MinHeap();
  ["あ", "い", "う", "え"].forEach((name) => heap.push(7, name));
  heap.push(3, "先頭");
  const out = [];
  while (heap.size) out.push(heap.pop().payload);
  assert.deepStrictEqual(out, ["先頭", "あ", "い", "う", "え"],
                         "同じ値のときの順番が入れた順になっていない: " + out.join(","));
});

test("空の山から取り出しても落ちない", () => {
  const heap = new MinHeap();
  assert.strictEqual(heap.size, 0);
  assert.strictEqual(heap.pop(), undefined, "空なのに何か返している");
  heap.push(1, "x");
  assert.strictEqual(heap.pop().payload, "x");
  assert.strictEqual(heap.pop(), undefined, "空にしたあとに何か返している");
});
