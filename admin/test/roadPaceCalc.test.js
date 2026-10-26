"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { summarize, spans, ridesOnRoads, pointsFromRouteJson, ridePayload } = require("../lib/roadPaceCalc");

/**
 * PC で計算する走りの速さ（buildRoadPaceOffline.js）。アプリの RoadPaceTests と同じ例で同じ答えになるか
 * ⚠️ 利用者の判断（2026-10-26）: 共有ルートと（同意した人の）バックアップを PC で計算する
 */
const T0 = 1_800_000_000_000;
const line = (kmh, seconds, lat0 = 35.0, start = T0) => {
  const deg = kmh / 3.6 / 111_195;
  return Array.from({ length: seconds + 1 }, (_, i) => ({ lat: lat0 + deg * i, lng: 139.0, t: start + i * 1000 }));
};
const all = (pts) => [[0, pts.length - 1]];

test("一定の速さなら平均と85%点はその速さ", () => {
  const pts = line(48, 150);
  const r = summarize(pts, all(pts));
  assert.strictEqual(r.kmh, 48);
  assert.strictEqual(r.p85, 48);
  assert.strictEqual(r.stops, 0);
  assert.ok(Math.abs(r.km - 2.0) <= 0.05);
});

test("止まっていた時間は平均に入れず、回数と割合で数える", () => {
  const a = line(40, 120);
  const last = a[a.length - 1];
  const stop = Array.from({ length: 30 }, (_, i) => ({ lat: last.lat, lng: last.lng, t: last.t + (i + 1) * 1000 }));
  const b = line(40, 120, last.lat, stop[stop.length - 1].t).slice(1);
  const pts = [...a, ...stop, ...b];
  const r = summarize(pts, all(pts));
  assert.strictEqual(r.kmh, 40);
  assert.strictEqual(r.stops, 1);
  assert.strictEqual(r.stopPct, 11);
});

test("途切れた間は数えない・短すぎれば要約しない", () => {
  const a = line(36, 120);
  const b = line(36, 120, a[a.length - 1].lat + 0.01, a[a.length - 1].t + 300_000);
  const r = summarize([...a, ...b], all([...a, ...b]));
  assert.strictEqual(r.kmh, 36);
  assert.ok(Math.abs(r.km - 2.4) <= 0.05);
  assert.strictEqual(summarize(line(40, 60), all(line(40, 60))), null);
});

test("道の上を300m以上続けて走った範囲だけ（交差点で横切るだけは外す）", () => {
  const pts = line(40, 150);
  const road = [{ lat: 35.0, lng: 139.0 }, { lat: 35.02, lng: 139.0 }];
  assert.deepStrictEqual(spans(pts, [road]), [[0, 150]]);
  const crossing = [{ lat: 35.005, lng: 138.99 }, { lat: 35.005, lng: 139.01 }];
  assert.deepStrictEqual(spans(pts, [crossing]), []);
  const out = ridesOnRoads(pts, [{ id: "r:x", name: "テスト線", lines: [road] }, { id: "r:y", name: "横切る道", lines: [crossing] }]);
  assert.deepStrictEqual(Object.keys(out), ["r:x"]);
});

test("記録の JSON を読む（共有ルートの ISO の時刻と、Swift の既定の秒）", () => {
  const iso = pointsFromRouteJson({ routePoints: [
    { latitude: 35, longitude: 139, timestamp: "2026-02-21T01:16:11Z" },
    { latitude: 35.1, longitude: 139 },
  ] });
  assert.strictEqual(iso.length, 1);
  assert.strictEqual(iso[0].t, Date.parse("2026-02-21T01:16:11Z"));
  const swift = pointsFromRouteJson([{ latitude: 35, longitude: 139, timestamp: 0 }]);
  assert.strictEqual(new Date(swift[0].t).toISOString(), "2001-01-01T00:00:00.000Z");
});

test("送る形はアプリと同じ（年-月まで）に出どころを足す", () => {
  const p = ridePayload({ km: 3.2, kmh: 41, p85: 52, stops: 1, stopPct: 4 }, "large", Date.parse("2026-10-26T04:00:00Z"), "shared");
  assert.deepStrictEqual(Object.keys(p).sort(), ["cc", "km", "kmh", "p85", "src", "stopPct", "stops", "ym"]);
  assert.strictEqual(p.ym, "2026-10");
});
