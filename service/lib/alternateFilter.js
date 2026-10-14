"use strict";
/**
 * 条件に合わない「別の道」を外す（利用者の判断 2026-10-14）。
 *
 * ⚠️ Web で有料・高速を避ける設定なのに、別の道の候補が高速 34.5km を通っていた。
 *    経路サーバの「避ける」は重みであって禁止ではないので、本命は避けられても、別の道は無料区間の高速などに乗る。
 * ⚠️ **本命と比べる。** 本命が避けきれずに通った分は、別の道が同じだけ通っても外さない。
 * ⚠️ **区間ごとに条件が違うときは外さない**（高速を使ってよい区間で通っているのかを見分けられない）。
 * ⚠️ アプリ（NavAlternateFilter.swift）・Web（public/route-maker-lib.js の keepsAlternate）も同じ決まり
 */
const SLACK_METERS = 300;

const expressway = (r) => Number(r && r.kindMeters && r.kindMeters.expressway) || 0;
const tollLeft = (r) => Number(r && r.tollUnavoidableMeters) || 0;

function keepsAlternate(alt, main, cond = {}) {
  if (cond.mixedLegs) return true;
  if (cond.avoidHighways && expressway(alt) > expressway(main) + SLACK_METERS) return false;
  if (cond.avoidTolls && tollLeft(alt) > tollLeft(main) + SLACK_METERS) return false;
  return true;
}

module.exports = { keepsAlternate, SLACK_METERS };
