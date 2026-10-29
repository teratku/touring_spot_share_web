"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const S = require("../../public/route-spots.js");

/**
 * Web の共有ルート（route-detail.html）のスポットの印。アプリの SharedRouteShareTests.testSpotIDsOnlyInsideSharedRange と同じ例。
 * ⚠️ 利用者の要望（2026-10-29）:「webも同じようにスポットマーカーを表示しタップして詳細が開けるようにする」
 */
const t0 = Date.parse("2023-11-14T22:13:20Z");
const points = Array.from({ length: 20 }, (_, i) => ({
  latitude: 35.8, longitude: 139.1 + i * 0.0005, timestamp: new Date(t0 + i * 10000).toISOString(),
  markerType: i === 5 ? "スポット" : null, spotID: i === 5 ? "onPoint" : null,
}));
const markers = [
  { latitude: 35.8005, longitude: 139.103, type: "スポット", spotID: "near" },
  { latitude: 35.8, longitude: 139.05, type: "スポット", spotID: "trimmedHome" },   // 約4.5km 西（切り取った所）
  { latitude: 35.8, longitude: 139.101, type: "休憩", spotID: "rest" },
  { latitude: 35.8, longitude: 139.1025, type: "スポット", spotID: "onPoint" },
];

test("アプリと同じ: 切り取った所のスポット・休憩の印は出さない・重ねない", () => {
  const out = S.spotMarkers({ routePoints: points, markers });
  assert.deepStrictEqual(out.map((x) => x.spotID), ["onPoint", "near"]);
  assert.strictEqual(out[1].lat, 35.8005);
  assert.deepStrictEqual(S.spotMarkers({ routePoints: [], markers }), []);
});

test("10/29 より前の共有（印なし）・壊れたデータでも落ちない", () => {
  assert.deepStrictEqual(S.spotMarkers({ routePoints: points.map((p) => ({ ...p, markerType: null })), markers: [] }), []);
  assert.deepStrictEqual(S.spotMarkers(null), []);
  assert.deepStrictEqual(S.spotMarkers({ routePoints: points, markers: [null, { type: "スポット", spotID: " ", latitude: 35.8, longitude: 139.1 }] }).map((x) => x.spotID), ["onPoint"]);
});

test("吹き出しの中身: 名前・1枚目の写真・詳細へのリンク", () => {
  const s = S.spotSummary("sIq/MX", { location_name: "中村屋", administrative: "山梨県", locality: "北杜市", locationImageURLs: ["", "https://x/a.jpg"] });
  assert.deepStrictEqual(s, { docID: "sIq/MX", name: "中村屋", area: "山梨県北杜市", image: "https://x/a.jpg", url: "/detail.html?id=sIq%2FMX" });
  assert.strictEqual(S.spotSummary("d", { imageDownloadURL: "https://x/b.jpg" }).image, "https://x/b.jpg");
  assert.strictEqual(S.spotSummary("d", {}).name, "スポット");
});

const SWIFT = path.join(require("os").homedir(), "Documents/Xcode/biketeilen_iOS_clean/touringSpotShare/shareRoute/SharedRouteDetailView.swift");

test("アプリの決まり（500m・「スポット」）と同じ値", { skip: !fs.existsSync(SWIFT) && "アプリの repo が無い" }, () => {
  const swift = fs.readFileSync(SWIFT, "utf8");
  assert.match(swift, /static func spotMarkers\(points: \[CachedLocation\], markers: \[CachedMarker\], within meters: CLLocationDistance = 500\)/);
  assert.strictEqual(S.NEAR_M, 500);
});
