/**
 * mapsKey.js
 *
 * Google Maps Platform のキーの置き場。**このツールで参照するのはここだけにする。**
 *
 * 【なぜ1箇所にまとめるか】
 * ⚠️ 以前は同じキーがスクリプトと HTML に直書きされていた。差し替えたいときに
 *    全部を直す必要があり、**1箇所でも古いまま残ると、分けたつもりのキーが混ざる**。
 *
 * 【ブラウザ用とサーバー用を分ける理由】
 * ⚠️ **同じキーでは兼用できない。** Google の「ウェブサイト制限」は
 *    リファラーで判定するので、**Node から叩くと必ず弾かれる**（リファラーが無い）。
 *    逆にサーバー用のキーを HTML に埋めると、ブラウザから抜き取られて誰でも使える。
 *      ・ブラウザ用 … ウェブサイト制限（http://127.0.0.1:4317/* と本番ドメイン）
 *      ・サーバー用 … 手元のスクリプトから叩く。IP 制限か、最低でも API 制限をかける
 *
 * 【HTML にどう渡すか】
 * ⚠️ HTML には `__GOOGLE_MAPS_API_KEY__` と書いておき、配信するときに差し込む
 *    （`server.js` の `sendHtml`）。HTML に直書きすると、ここを変えても効かない。
 *
 * 【環境変数で上書きできる】
 *   GOOGLE_MAPS_BROWSER_KEY=... GOOGLE_MAPS_SERVER_KEY=... node server.js
 *   ⚠️ 既定値を残してあるのは、入れ忘れても手元のツールが動くようにするため。
 *      **公開する物には既定値を持たせないこと。**
 */
"use strict";

/**
 * ブラウザ（road-builder / streetview / rally-builder）が使うキー。
 * ⚠️ ウェブサイト制限つき。`http://127.0.0.1:4317/*` を許可しておくこと。
 *    許可を外すと、管理ツールの地図が真っ白になる。
 */
const BROWSER_KEY =
  process.env.GOOGLE_MAPS_BROWSER_KEY || "AIzaSyCBayWrK7IGm5Ceow4uQ_kt02Y2YJaKdG4";

/**
 * Node のスクリプトが使うキー（いまは `lib/restrictionMatcher.js` の Geocoding だけ）。
 *
 * ⚠️ **ブラウザ用のキーをここに入れないこと。** ウェブサイト制限が効いて
 *    `REQUEST_DENIED` になる（リファラーが無いため）。
 * ⚠️ この既定値は**制限の無い古いキー**。手元でしか使わないが、
 *    差し替えるまでは持ち出さないこと。
 */
const SERVER_KEY =
  process.env.GOOGLE_MAPS_SERVER_KEY || "AIzaSyASDL3J6KQSn7uxxgRcuH0gYAYrYWE9I24";

/**
 * HTML に差し込む対応表。
 * ⚠️ road-builder と rally-builder は同じブラウザ用キーを使う。
 *    目印を2つ残してあるのは、将来ページごとに分けたくなったときのため。
 */
const HTML_PLACEHOLDERS = {
  __GOOGLE_MAPS_API_KEY__: BROWSER_KEY,
  __RALLY_MAPS_API_KEY__: BROWSER_KEY,
};

module.exports = {
  BROWSER_KEY, SERVER_KEY, HTML_PLACEHOLDERS,
  // 互換のために残す（既存の呼び出しが壊れないように）
  GOOGLE_MAPS_API_KEY: SERVER_KEY,
};
