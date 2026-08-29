/**
 * navManeuver.js
 *
 * 曲がり方の名前を、**アプリの `NavManeuver` が受け取れる形**に直す。
 *
 * 【なぜ要るか】
 * ⚠️ **中と外で書き方が違う。** Node 側（`navGuide.js` の読み上げ文・`navSimulate.js`・
 *    画面）は camelCase（`turnSlightRight`）で通してあるが、アプリの enum の
 *    生値は kebab-case（`turn-slight-right`）。
 * ⚠️ **そのまま渡すと黙って壊れる。** `NavManeuver.from` は知らない値を
 *    `.none` にするので、**エラーも出ないまま曲がり角の案内が全部消える**。
 *    実測で18種類中13種類が一致していなかった。
 *
 * ⚠️ **アプリへ出す口では必ず通すこと**（`service/lib/buildRoute.js`、
 *    `admin` の `/api/nav/route`）。内部の判断は camelCase のままでよい。
 */
"use strict";

/**
 * camelCase → アプリの生値。
 * ⚠️ アプリの `saveRoute/nav/NavRoute.swift` の `enum NavManeuver` が本家。
 *    足すときは向こうに実在する生値だけにすること（`test/maneuverParity.test.js`）。
 */
const APP_MANEUVER = {
  turnLeft: "turn-left",
  turnRight: "turn-right",
  turnSlightLeft: "turn-slight-left",
  turnSlightRight: "turn-slight-right",
  turnSharpLeft: "turn-sharp-left",
  turnSharpRight: "turn-sharp-right",
  keepLeft: "keep-left",
  keepRight: "keep-right",
  uturnLeft: "uturn-left",
  uturnRight: "uturn-right",
  straight: "straight",
  rampLeft: "ramp-left",
  rampRight: "ramp-right",
  ramp: "ramp",
  merge: "merge",
  forkLeft: "fork-left",
  forkRight: "fork-right",
  ferry: "ferry",
  ferryTrain: "ferry-train",
  roundaboutLeft: "roundabout-left",
  roundaboutRight: "roundabout-right",
  // ⚠️ 曲がり角でないステップ。アプリの生値は**空文字**（`case none = ""`）
  none: "",
};

/**
 * @param {string} name camelCase の曲がり方
 * @returns {string} アプリの生値。知らない名前は空文字（＝曲がり角でない扱い）
 */
function toAppManeuver(name) {
  const key = String(name || "");
  // ⚠️ 知らない名前を素通しさせない。素通しするとアプリ側で黙って .none になる
  return Object.prototype.hasOwnProperty.call(APP_MANEUVER, key) ? APP_MANEUVER[key] : "";
}

module.exports = { APP_MANEUVER, toAppManeuver };
