#!/usr/bin/env node
/**
 * makeGpx.js
 *
 * 生成したルートを **Xcode のシミュレータで位置情報として流せる GPX** にする。
 *
 * 【Xcode の GPX の作法】
 * ⚠️ **`<wpt>` を並べる**（`<trkpt>` ではない）。Xcode の位置シミュレーションは
 *    waypoint の列を読み、点から点へ動かす。
 * ⚠️ **`<time>` を入れると、その時刻どおりの速さで動く。** 入れないと
 *    Xcode が一定間隔（既定で点あたり1秒）で進めるので、点が密だと
 *    実際よりずっと遅く、点が粗いと速くなる。
 * ⚠️ 経度・緯度の属性は `lon` / `lat`。順序は問わないが名前を間違えると読まれない。
 *
 * 【使い方】
 *   node makeGpx.js --from 139.5687,35.8570 --to 139.3389,35.5558 > route.gpx
 *   node makeGpx.js --from ... --to ... --displacement moped50 --speed 40
 *   node makeGpx.js --polyline "<5桁のポリライン>" > route.gpx
 *
 * 【`simctl` で流したいとき】
 * ⚠️ **`simctl location start` は GPX を読まない。** `緯度,経度` の行を読む。
 *    `--simctl` を付けるとその形で出す（実際に動かして確認した手順）:
 *      node makeGpx.js --from ... --to ... --every 100 --simctl > /tmp/pts.txt
 *      xcrun simctl location <UDID> start --speed=17 - < /tmp/pts.txt
 *    （`--speed` は m/s。17≒60km/h、33≒120km/h）
 * ⚠️ `simctl` は点の間を自分で補間するので、点は粗め（--every 100）で足りる。
 *    GPX 側は Xcode がそのまま並べるので細かめ（既定20m）にしてある。
 *
 * ⚠️ **管理ツールが立っていること**（`node server.js`）。
 *    アプリと同じ `routeWithValhalla` を通るので、同じ条件なら同じ道になる。
 *
 * 【Xcode での使い方】
 *   1. できた .gpx を Xcode のプロジェクトに入れる（またはそのまま開く）
 *   2. 実行中に Debug → Simulate Location → その名前を選ぶ
 *      （シミュレータ側の Features → Location → Custom Location でも可）
 */
"use strict";

const { decode } = require("./lib/polyline");
// ⚠️ **書式の作り方は `lib/gpx.js` にしかない。** ここに写さないこと
const { toGpx, toSimctl } = require("./lib/gpx");

const args = process.argv.slice(2);
const val = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const pair = (text) => {
  const [a, b] = String(text || "").split(",").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];                              // [経度, 緯度]
};

const BASE = val("base", "http://127.0.0.1:4317");
/** 走る速さ（km/h）。⚠️ 時刻の刻みに効く＝再生の速さそのもの */
const SPEED_KMH = Number(val("speed", "40"));
/** 点の間隔（m）。⚠️ 細かすぎるとファイルが膨らみ、粗いと角を曲がりきれない */
const EVERY_METERS = Number(val("every", "20"));

(async () => {
  let points;
  const polyline = val("polyline");
  if (polyline) {
    // ⚠️ **5桁で読む。** 配信物も端末も5桁（`lib/polyline.js`）
    points = decode(polyline);
  } else {
    const from = pair(val("from")), to = pair(val("to"));
    if (!from || !to) {
      console.error("使い方: node makeGpx.js --from 経度,緯度 --to 経度,緯度 [--speed 40] [--every 20]");
      console.error("        node makeGpx.js --polyline <5桁のポリライン>");
      process.exit(1);
    }
    const body = {
      from, to,
      variant: val("variant", "normal"),
      displacement: val("displacement", "large"),
      avoidHighways: args.includes("--avoid-highways"),
      avoidTolls: args.includes("--avoid-tolls"),
      includeUnverified: !args.includes("--verified-only"),
    };
    let res;
    try {
      res = await fetch(`${BASE}/api/valhalla/route`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error(`管理ツールに繋がりません（${BASE}）。node server.js を先に動かしてください`);
      process.exit(1);
    }
    const json = await res.json();
    if (json.error) { console.error(`経路が引けません: ${json.error}`); process.exit(1); }
    points = json.points;
    console.error(`🛣  ${(json.lengthMeters / 1000).toFixed(1)}km ／ 規制の避け直し${json.restrictionTries}回`
      + `／ 残った規制${(json.restrictionHits || []).length}件`);
  }

  if (!points || points.length < 2) { console.error("線が取れませんでした"); process.exit(1); }
  const made = args.includes("--simctl")
    ? toSimctl(points, { everyMeters: EVERY_METERS })
    : toGpx(points, { speedKmh: SPEED_KMH, everyMeters: EVERY_METERS });
  process.stdout.write(made.text);
  const km = made.count * EVERY_METERS / 1000;
  console.error(`📍 ${made.count}点（${EVERY_METERS}m間隔・約${km.toFixed(1)}km）`
    + ` ／ ${SPEED_KMH}km/h で約${(km / SPEED_KMH * 60).toFixed(0)}分`);
})();
