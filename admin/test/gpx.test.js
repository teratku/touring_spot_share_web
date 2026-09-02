"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { resample, toGpx, toSimctl, meters } = require("../lib/gpx");

/**
 * 経路を Xcode / simctl で流せる位置情報にする。
 *
 * ⚠️ **書式を間違えると読まれない。** Xcode は `<wpt lat lon>`、
 *    simctl は `緯度,経度` の行。どちらも黙って無視されるので気づきにくい。
 */

/** 東へ伸びる直線。1点あたり約9m */
const line = (n, lng = 139.70, lat = 35.68) =>
  Array.from({ length: n }, (_, i) => [lng + i * 0.0001, lat]);

test("点の間隔をそろえる", () => {
  // ⚠️ 元の点は間隔がまちまち（曲がり角で密・直線で粗）。
  //    そのまま時刻を振ると速さが波打ち、曲がり角だけ極端に遅くなる
  const uneven = [[139.70, 35.68], [139.7001, 35.68], [139.7100, 35.68]];
  const out = resample(uneven, 50);
  for (let i = 1; i < out.length - 1; i++) {
    const d = meters(out[i - 1], out[i]);
    assert.ok(Math.abs(d - 50) < 1, `${i}番目の間隔が ${d.toFixed(1)}m`);
  }
});

test("最後の点を落とさない", () => {
  // ⚠️ 落とすと目的地の手前で止まる
  const pts = line(30);
  const out = resample(pts, 50);
  const last = pts[pts.length - 1];
  assert.ok(meters(out[out.length - 1], last) <= 1,
            "最後の点が入っていない");
});

test("GPX は wpt と lat lon で書く", () => {
  // ⚠️ `trkpt` や `lng` にすると Xcode は**黙って読まない**
  const { text } = toGpx(line(50), { speedKmh: 40 });
  assert.ok(/<wpt lat="[\d.]+" lon="[\d.]+">/.test(text), "wpt lat lon の形になっていない");
  // ⚠️ **形だけ見ても足りない。** 中身が入れ替わっていても形は同じ。
  //    経路データは [経度, 緯度] なので、入れ替え忘れは実際に起きる
  const first = text.match(/<wpt lat="([\d.]+)" lon="([\d.]+)">/);
  assert.ok(Number(first[1]) > 35 && Number(first[1]) < 36,
            `lat に経度が入っている: ${first[1]}`);
  assert.ok(Number(first[2]) > 139 && Number(first[2]) < 140,
            `lon に緯度が入っている: ${first[2]}`);
  assert.ok(!/<trkpt/.test(text), "trkpt で書いている（Xcode は読まない）");
  assert.ok(/xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/.test(text), "名前空間が無い");
});

test("GPX の時刻が走る速さに合う", () => {
  // ⚠️ 時刻が無いと Xcode が一定間隔で進めるので、点が密だと実際より遅くなる
  const fast = toGpx(line(200), { speedKmh: 120, everyMeters: 20 });
  const slow = toGpx(line(200), { speedKmh: 40, everyMeters: 20 });
  const span = (t) => {
    const times = [...t.matchAll(/<time>(.+?)<\/time>/g)].map((m) => Date.parse(m[1]));
    return times[times.length - 1] - times[0];
  };
  assert.ok(span(fast.text) > 0, "時刻が進んでいない");
  // 3倍の速さなら、かかる時間はおよそ3分の1
  const ratio = span(slow.text) / span(fast.text);
  assert.ok(Math.abs(ratio - 3) < 0.1, `速さが時刻に効いていない（比 ${ratio.toFixed(2)}）`);
});

test("simctl は緯度,経度の順で書く", () => {
  // ⚠️ **経路データは [経度, 緯度]。** そのまま出すと地球の裏側へ飛ぶ
  const { text } = toSimctl([[139.70, 35.68], [139.71, 35.69]], { everyMeters: 100 });
  const first = text.split("\n")[0].split(",").map(Number);
  assert.ok(first[0] > 35 && first[0] < 36, `緯度が先に来ていない: ${text.split("\n")[0]}`);
  assert.ok(first[1] > 139 && first[1] < 140, "経度が後に来ていない");
  assert.ok(!/<wpt/.test(text), "simctl に GPX を渡している");
});

test("用途で点の粗さを変える", () => {
  // ⚠️ Xcode はそのまま並べるので細かく、simctl は自分で補間するので粗くてよい
  const pts = line(600);                       // 約5.4km
  const gpx = toGpx(pts, { everyMeters: 20 });
  const sim = toSimctl(pts, { everyMeters: 100 });
  assert.ok(gpx.count > sim.count * 3,
            `GPX ${gpx.count}点 / simctl ${sim.count}点 — 粗さが分かれていない`);
});

test("書式の作り方を2か所に持たない", () => {
  // ⚠️ 端末（makeGpx.js）と画面（server.js）で別々に組み立てるとずれる
  const cli = fs.readFileSync(path.join(__dirname, "..", "makeGpx.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const [name, src] of [["makeGpx.js", cli], ["server.js", server]]) {
    assert.ok(/require\(".*lib\/gpx"\)/.test(src), `${name} が lib/gpx を使っていない`);
    assert.ok(!/<wpt lat=/.test(src), `${name} が自前で GPX を組み立てている`);
  }
});
