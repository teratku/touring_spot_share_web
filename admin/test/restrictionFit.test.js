"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { routeBetween } = require("../lib/roadRoute");
const { decode, encode } = require("../lib/polyline");
const { distanceMeters } = require("../lib/roadCsv");

const GRID = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
const skipIfNoCsv = (t) => (fs.existsSync(GRID) ? false : t.skip("手元にCSVが無い環境"));

/**
 * 登録済みの通行規制を、手元のCSVの道に合わせ直せるか。
 *
 * ⚠️ 二普協から起こした区間は住所や目標物から割り出したおおまかな形で、
 *    道の上を正確になぞっていないことがある（実測で、県警公表1,300mの規制が
 *    510m、別の区間が21m になっていた）。両端を手がかりに引き直す。
 */

test("線の並びがサーバと画面で一致している", () => {
  // ⚠️ ここがずれると、緯度と経度が入れ替わった線が地図に描かれる。
  //    lib は [lng, lat]、画面の decodePolyline は {lat, lng} を返すので、
  //    往復して同じ場所になることを確かめる（**一度取り違えた**）
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
  const m = html.match(/function decodePolyline\(encoded\) \{[\s\S]*?\n\}/);
  assert.ok(m, "画面側の decodePolyline を取り出せない");
  const decodePolyline = new Function(`${m[0]}; return decodePolyline;`)();

  const server = [[139.5, 36.0], [139.51, 36.01]];      // [lng, lat]
  const shown = decodePolyline(encode(server));
  assert.strictEqual(shown[0].lat, 36.0, "緯度が入れ替わっている");
  assert.strictEqual(shown[0].lng, 139.5, "経度が入れ替わっている");
});

test("登録済みの規制を道に合わせられる", async (t) => {
  if (skipIfNoCsv(t)) return;
  const dir = path.join(__dirname, "..", "data", "road-restrictions");
  if (!fs.existsSync(dir)) return t.skip("登録済みの規制が無い");

  const all = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const r of d.restrictions || []) all.push(r);
  }
  if (!all.length) return t.skip("登録済みの規制が無い");

  for (const r of all) {
    const points = decode(r.polyline);
    if (points.length < 2) continue;
    const fitted = await routeBetween(points[0], points[points.length - 1]);
    assert.ok(!fitted.error, `${r.name}: ${fitted.error}`);

    // ⚠️ 長さが大きく変わるのは、両端が違う道に乗っている合図。
    //    実測では5件すべて 0.88〜1.00倍だった
    let before = 0;
    for (let i = 1; i < points.length; i++) before += distanceMeters(points[i - 1], points[i]);
    const ratio = fitted.lengthMeters / Math.max(1, before);
    assert.ok(ratio > 0.5 && ratio < 2,
              `${r.name}: 長さが大きく変わる（${Math.round(before)}m → ${fitted.lengthMeters}m）`);
  }
});

test("合わせた線は元の両端から始まって終わる", async (t) => {
  if (skipIfNoCsv(t)) return;
  const dir = path.join(__dirname, "..", "data", "road-restrictions");
  if (!fs.existsSync(dir)) return t.skip("登録済みの規制が無い");
  const files = fs.readdirSync(dir).filter((x) => x.endsWith(".json"));
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const r of (d.restrictions || []).slice(0, 3)) {
      const points = decode(r.polyline);
      if (points.length < 2) continue;
      const fitted = await routeBetween(points[0], points[points.length - 1]);
      if (fitted.error) continue;
      // ⚠️ 逆向きに組み立てると、規制の向きが引っくり返る
      assert.ok(distanceMeters(points[0], fitted.points[0]) < 300, `${r.name}: 始点がずれている`);
      assert.ok(distanceMeters(points[points.length - 1], fitted.points[fitted.points.length - 1]) < 300,
                `${r.name}: 終点がずれている`);
    }
  }
});
