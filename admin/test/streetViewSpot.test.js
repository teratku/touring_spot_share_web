"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { encode } = require("../lib/polyline");

/**
 * ストリートビューを開く地点と向きを決める処理（road-builder.html の `streetViewSpot`）。
 *
 * 【なぜこのファイルがあるか】
 * ⚠️ 実機で「道の形を修正したのにストリートビューの位置が変わらない」と報告された。
 *    `seg.polyline`（元の形）を見ていたため、手で切り直しても**元の端**で開いていた。
 *    エラーは出ず、ただ違う場所が開くだけなので、地図と見比べないと気付けない。
 *
 * ⚠️ 画面に描いている形は `shapeOf(seg)`（手直しがあればそちら、無ければ元の形）。
 *    見えている形と開く場所は必ず一致させること。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");

/** 画面側の関数を取り出して動かす（`parseLatLng.test.js` と同じやり方） */
function load(overrides = {}) {
  const src = html.match(/function streetViewSpot\(seg, which\) \{[\s\S]*?\n\}/);
  assert.ok(src, "streetViewSpot を取り出せない");
  const bearingSrc = html.match(/function bearing\(a, b\) \{[\s\S]*?\n\}/);
  assert.ok(bearingSrc, "bearing を取り出せない");
  // 依存（decodePolyline / shapeOf）は本物と同じ形で差し込む
  const deps = `
    const decodePolyline = (s) => DECODE(s).map(([lng, lat]) => ({ lat, lng }));
    const ov = (seg) => OVERRIDES[seg.id] || {};
    const shapeOf = (seg) => ov(seg).shape || seg.polyline;
  `;
  return new Function("DECODE", "OVERRIDES",
    `${deps}\n${bearingSrc[0]}\n${src[0]}\n return streetViewSpot;`)(
      require("../lib/polyline").decode, overrides);
}

/** 南北にまっすぐ伸びる線。1点あたり約111m */
const straight = (lat, lng, count) =>
  [...Array(count)].map((_, i) => [lng, lat + i * 0.001]);

const original = straight(36.0, 139.0, 40);              // 36.000 〜 36.039
const trimmed = straight(36.020, 139.0, 20);             // 手で前半を切り落とした形
const seg = { id: "a", name: "テスト道路", polyline: encode(original) };

const near = (got, lat, lng, why) => {
  assert.ok(got, "地点が取れていない");
  assert.ok(Math.abs(got.at.lat - lat) < 1e-4 && Math.abs(got.at.lng - lng) < 1e-4,
            `${why}（${got.at.lat.toFixed(4)}, ${got.at.lng.toFixed(4)}）`);
};

test("手直しが無ければ元の形の端で開く", () => {
  const streetViewSpot = load({});
  near(streetViewSpot(seg, "start"), 36.000, 139.0, "始点が元の形の先頭でない");
  near(streetViewSpot(seg, "end"), 36.039, 139.0, "終点が元の形の末尾でない");
});

test("手で切り直したら、その形の端で開く", () => {
  // ⚠️ **これが報告された不具合そのもの。** 形を直しても元の端で開いていた
  const streetViewSpot = load({ a: { shape: encode(trimmed) } });
  near(streetViewSpot(seg, "start"), 36.020, 139.0, "切り直したのに元の始点で開いている");
  near(streetViewSpot(seg, "end"), 36.039, 139.0, "終点がずれている");
});

test("真ん中も切り直した形で決まる", () => {
  const streetViewSpot = load({ a: { shape: encode(trimmed) } });
  // 20点なので末尾の番号は19。その半分＝9番目 ≒ 36.029
  near(streetViewSpot(seg, "mid"), 36.029, 139.0, "真ん中が元の形で決まっている");
});

test("道の進む向きを向く", () => {
  // ⚠️ 向きを付けないと Google が真北で開き、道ではなく畑や壁を向く
  const streetViewSpot = load({});
  const start = streetViewSpot(seg, "start");
  assert.ok(Math.abs(start.heading - 0) < 1 || Math.abs(start.heading - 360) < 1,
            `北へ伸びる道なのに始点の向きが ${start.heading}`);
  // 終点では道をさかのぼる向き（南）を向く
  const end = streetViewSpot(seg, "end");
  assert.ok(Math.abs(end.heading - 180) < 1,
            `終点でさかのぼる向きになっていない（${end.heading}）`);
});

test("点が足りない形では開かない", () => {
  const streetViewSpot = load({});
  assert.strictEqual(streetViewSpot({ id: "b", polyline: encode([[139, 36]]) }, "start"), null);
});
