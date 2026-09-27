/**
 * restrictionScope.js
 *
 * 画面の「避ける規制」の範囲を、規制を読むときの旗にする（`restrictionsForPrefectures` に渡す）。
 *
 *   app（既定）  … アプリの配信APIと同じ。売ってよい出どころだけ（二普協は外れる）・未確認は混ぜない
 *   all          … 登録済み全部（二普協も）
 *   unverified   … 登録済み全部＋未確認の JARTIC 候補
 *
 * ⚠️ **範囲を渡さなければアプリと同じにすること**（利用者の判断 2026-09-27: 画面の既定をアプリに合わせる）。
 *    以前は画面だけ別の規制を避けていて、同じ出発地・目的地でも画面とアプリで道が違った。
 * ⚠️ 古い画面は `includeUnverified` だけを送ってくる。それが立っていれば、これまでどおり未確認も混ぜる
 */
"use strict";

function restrictionScopeOptions(scope, includeUnverified) {
  const unverified = scope === "unverified" || (scope === undefined && !!includeUnverified);
  const sellableOnly = scope === "app" || (scope === undefined && !includeUnverified);
  return { includeUnverified: unverified, sellableOnly };
}

module.exports = { restrictionScopeOptions };
