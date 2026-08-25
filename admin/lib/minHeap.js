/**
 * minHeap.js
 *
 * 経路探索で「いちばん距離の小さいノード」を取り出すための二分ヒープ。
 *
 * 【なぜ要るか】
 * ⚠️ 元は距離の表を毎回なめて最小を選んでいた（「ノードは数千だから」という前提）。
 *    名前の無い道も読むようにしたら 2,977 → 35,216 ノードになり、その走査だけで
 *    **1.2億回**に膨れて、1本引くのに **12.2秒** かかるようになった。
 *    ヒープにして 0.8 秒に戻っている。ノード数は読ませるCSV次第で変わるので、
 *    「数千だから」という前提は当てにできない。
 *
 * 【同じ値のときの順番】
 * ⚠️ **入れた順に出す（先に入れた方が先）。値だけで比べないこと。**
 *    比べ方に順番が入っていないと、同じ値のものがどう出るか決まらず、
 *    **同じ入力なのに走るたびに違う線が返る**ことがありうる。
 *    なめていた頃も距離の表（Map）の並び順で先勝ちしており、決まっていた。
 *    実データ29組（山梨・3〜60km）で、なめていた頃と線が1バイトも変わらないことを
 *    確かめてある。ここを外すと、その保証が消える。
 */
"use strict";

class MinHeap {
  constructor() {
    //: [値, 入れた順, 中身]
    this.items = [];
    this.counter = 0;
  }

  get size() { return this.items.length; }

  /** 小さい方が先。値が同じなら先に入れた方が先 */
  static before(a, b) {
    return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
  }

  push(value, payload) {
    const items = this.items;
    items.push([value, this.counter++, payload]);
    for (let i = items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!MinHeap.before(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  /** いちばん小さいものを取り出す。空なら undefined */
  pop() {
    const items = this.items;
    if (!items.length) return undefined;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      for (let i = 0;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let small = i;
        if (left < items.length && MinHeap.before(items[left], items[small])) small = left;
        // ⚠️ 右の子を見落とさないこと。片方しか見ないと山が崩れ、
        //    取り出す順が狂って、いちばん短い道ではないものが返る
        if (right < items.length && MinHeap.before(items[right], items[small])) small = right;
        if (small === i) break;
        [items[i], items[small]] = [items[small], items[i]];
        i = small;
      }
    }
    return { value: top[0], payload: top[2] };
  }
}

module.exports = { MinHeap };
