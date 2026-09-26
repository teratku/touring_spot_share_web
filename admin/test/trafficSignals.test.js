"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const signals = require("../lib/trafficSignals");
const { routeWithValhalla, SIGNAL_RADIUS_METERS, BASE } = require("../lib/valhallaRoute");

/**
 * 信号のある交差点かを答える部品。
 *
 * ⚠️ **Valhalla は信号を持っていない**（`trace_attributes` の節点に項目が無く、
 *    節点の種別にも出てこない。実測）。OSM から自前で持つしかない。
 */

async function skipIfDown(t) {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return false;
  } catch (e) { /* 落ちている */ }
  t.skip(`Valhalla が居ない（${BASE}）`);
  return true;
}

/** 手作りの信号データ（[経度, 緯度] の並び → 緯度順の Int32） */
function makeFile(points) {
  const sorted = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const buf = Buffer.alloc(sorted.length * 8);
  sorted.forEach(([lng, lat], i) => {
    buf.writeInt32LE(Math.round(lat * 1e6), i * 8);
    buf.writeInt32LE(Math.round(lng * 1e6), i * 8 + 4);
  });
  const file = path.join(os.tmpdir(), `signals-test-${Date.now()}-${Math.random()}.bin`);
  fs.writeFileSync(file, buf);
  return file;
}

/** 緯度1mぶんの度数 */
const M_LAT = 1 / 111320;
/** その緯度での経度1mぶんの度数（経度は北へ行くほど縮む） */
function mLng(lat) { return 1 / (111320 * Math.cos((lat * Math.PI) / 180)); }

test("近くに信号があるかを答える", () => {
  const lat = 35.7, lng = 139.5, ex = mLng(lat);
  // ⚠️ **1点ずつ別のデータで見ること。** 四方をまとめて1つのデータに入れると、
  //    どれか1つが近いだけで真になり「北側を見ていない」「経度の縮みを無視している」
  //    を見落とす。実際、まとめ置きの検査では変異が2つ素通りした
  const cases = [
    ["南15m",   0, -15, true],
    ["北15m",   0,  15, true],   // ⚠️ 判定点より北。探索の打ち切りを間違えると落ちる
    ["東18m",  18,   0, true],   // ⚠️ 縮みを無視すると 22m と数えて取りこぼす
    ["西18m", -18,   0, true],
    ["南60m",   0, -60, false],
    ["北60m",   0,  60, false],
    ["東23m",  23,   0, false],  // ⚠️ 縮みを二重にかけると 19m と数えて拾ってしまう
    ["西23m", -23,   0, false],
  ];
  for (const [name, dx, dy, want] of cases) {
    signals.reset();
    const file = makeFile([[lng + dx * ex, lat + dy * M_LAT]]);
    assert.strictEqual(signals.isNear([lng, lat], 20, file), want,
      `${name}の信号を${want ? "見落としている" : "拾いすぎている"}`);
  }
  signals.reset();
});

test("いちばん近い信号までの距離を返す", () => {
  signals.reset();
  const file = makeFile([[139.5, 35.7]]);
  const d = signals.nearestMeters([139.5, 35.7 + 50 / 111320], 200, file);
  assert.ok(Math.abs(d - 50) < 2, `距離が違う: ${d}`);
  assert.strictEqual(signals.nearestMeters([139.9, 35.7], 200, file), Infinity,
    "遠すぎる信号までの距離を返している");
  signals.reset();
});

test("データが無くても落ちない（信号を言わないだけ）", () => {
  signals.reset();
  const missing = path.join(os.tmpdir(), "no-such-signals.bin");
  assert.strictEqual(signals.isNear([139.5, 35.7], 20, missing), false);
  signals.reset();
});

test("配信データは日本全国ぶん入っている", () => {
  signals.reset();
  // ⚠️ 数が桁違いに減っていたら、作り直しで壊れている（実測 204,697点）
  assert.ok(signals.count() > 150000, `信号が少なすぎる: ${signals.count()}`);
  // ⚠️ 実測で信号が 24m の地点（渋谷スクランブル交差点）
  assert.strictEqual(signals.isNear([139.70055, 35.65953], 30), true, "都心の信号が入っていない");
  // 太平洋の上
  assert.strictEqual(signals.isNear([142.0, 35.0], 60), false, "海の上に信号がある");
  // ⚠️ **信号は交差点の中心ではなく停止線に打たれる。** 実測（明治通りのこの角）で
  //    曲がる地点から 16.2m。半径を詰めすぎると、こういう角を取りこぼす
  //    （実測18件のうち4件が 6〜16m。0mちょうど一致は10件だけ）
  const stopLine = [139.70303, 35.65812];
  assert.strictEqual(signals.isNear(stopLine, SIGNAL_RADIUS_METERS), true,
    `停止線とずれた信号を取りこぼす（半径 ${SIGNAL_RADIUS_METERS}m）`);
  assert.strictEqual(signals.isNear(stopLine, 10), false, "材料が悪い: 10mでも届いている");
  signals.reset();
});

test("曲がる指示に信号の印を付ける", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 市街地（新座→所沢）。実測: 曲がる3件のうち2件が信号のある交差点
  const route = await routeWithValhalla([139.5693, 35.7936], [139.4683, 35.7996], { displacement: "large" });
  assert.ok(!route.error, route.error);
  const turns = route.steps.filter((s) => s.maneuver.startsWith("turn"));
  assert.ok(turns.length >= 2, `材料が悪い: 曲がる指示が ${turns.length} 件`);
  assert.ok(turns.some((s) => s.atSignal), "信号のある交差点を1つも見つけていない");
  assert.ok(route.steps.every((s) => typeof s.atSignal === "boolean"), "印が付いていない指示がある");
  // ⚠️ **全部に付けないこと。** 郊外の曲がり角は信号が無い（実測: 81m・150m先）
  const far = await routeWithValhalla([139.5693, 35.7936], [139.0850, 35.9920], { displacement: "large" });
  assert.ok(far.steps.some((s) => s.maneuver.startsWith("turn") && !s.atSignal),
    "信号の無い交差点まで信号ありにしている");
});

test("見るのは曲がる地点。その指示の終点ではない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **指示の終点は「次の」交差点。** そちらを見ると、別の交差点の信号で
  //    「この交差点で」と言ってしまう。実測（渋谷→新宿）では、曲がる地点に
  //    信号があって終点には無い角が2つある（16.2m→47.2m、6.8m→150.1m）
  const route = await routeWithValhalla([139.7016, 35.6580], [139.7005, 35.6900],
                                        { displacement: "large" });
  assert.ok(!route.error, route.error);
  // ⚠️ 信号は OSM か JARTIC のどちらか（`isNearAny`。2026-09-26）
  const near = (p) => signals.nearestMeters(p, 300) <= SIGNAL_RADIUS_METERS
    || signals.nearestMeters(p, 300, signals.JARTIC_FILE) <= SIGNAL_RADIUS_METERS;
  const turns = route.steps.filter((s) => s.maneuver.startsWith("turn"));
  assert.ok(turns.length >= 3, `材料が悪い: 曲がる指示が ${turns.length} 件`);

  const beginOnly = turns.filter((s) => near(route.points[s.beginIndex])
                                     && !near(route.points[s.endIndex]));
  assert.ok(beginOnly.length >= 1, "材料が悪い: 曲がる地点だけに信号がある角が無い");
  assert.ok(beginOnly.every((s) => s.atSignal), "曲がる地点ではなく終点の信号を見ている");

  const noSignal = turns.filter((s) => !near(route.points[s.beginIndex]));
  assert.ok(noSignal.length >= 1, "材料が悪い: 曲がる地点に信号の無い角が無い");
  assert.ok(noSignal.every((s) => !s.atSignal), "信号の無い交差点に印を付けている");
});

// MARK: 手前の信号を数える（利用者の判断 2026-09-26: 直前は「2つ目の信号を右です」）

test("OSM か JARTIC のどちらかにあれば信号とみなす", () => {
  const lat = 35.7, lng = 139.5;
  signals.reset();
  const withSignal = makeFile([[lng, lat]]);
  const empty = makeFile([[lng + 0.1, lat + 0.1]]);
  assert.strictEqual(signals.isNearAny([lng, lat], 20, [withSignal, empty]), true, "1つ目にだけある信号を見落とした");
  assert.strictEqual(signals.isNearAny([lng, lat], 20, [empty, withSignal]), true, "2つ目にだけある信号を見落とした");
  assert.strictEqual(signals.isNearAny([lng, lat], 20, [empty, empty]), false, "どちらにも無いのに信号にした");
  signals.reset();
});

/** 北へまっすぐ 500m の経路（10mおき）。曲がる地点は北の端（番号50） */
function northLine(lat, lng) {
  return Array.from({ length: 51 }, (_, i) => [lng, lat + (i * 10) * M_LAT]);
}

test("曲がる地点の手前の信号交差点を、近い順に距離で返す", () => {
  const lat = 35.7, lng = 139.5, ex = mLng(lat);
  const line = northLine(lat, lng);
  const turnAt = lat + 500 * M_LAT;
  const at = (back, side = 0) => [lng + side * ex, turnAt - back * M_LAT];
  signals.reset();
  const file = makeFile([
    at(0), at(-12),          // 曲がる交差点そのもの（数えない）
    at(95), at(125),         // 1つの大きな交差点（停止線が30m離れる）→ 中心110m
    at(200),                 // 2つ目
    at(260, 30),             // 経路から30m横（別の道）→ 通らない
    at(360),                 // 300mより先 → 数えない
  ]);
  const got = signals.signalsBefore(line, 50, { atSignal: true, files: [file] });
  assert.strictEqual(got.length, 2, `交差点の数が違う: ${JSON.stringify(got)}`);
  assert.ok(Math.abs(got[0] - 110) <= 8, `1つ目の距離が違う: ${got[0]}`);
  assert.ok(Math.abs(got[1] - 200) <= 8, `2つ目の距離が違う: ${got[1]}`);
  signals.reset();
});

test("停止線が40mより離れたら別の交差点として数える", () => {
  const lat = 35.7, lng = 139.5;
  const line = northLine(lat, lng);
  const turnAt = lat + 500 * M_LAT;
  signals.reset();
  const file = makeFile([[lng, turnAt - 100 * M_LAT], [lng, turnAt - 160 * M_LAT]]);
  const got = signals.signalsBefore(line, 50, { atSignal: false, files: [file] });
  assert.strictEqual(got.length, 2, `60m離れた信号を1つにまとめた: ${JSON.stringify(got)}`);
  signals.reset();
});

test("曲がる地点に信号が無いときは、すぐ手前の信号も返す（信号を過ぎて、と言うため）", () => {
  const lat = 35.7, lng = 139.5;
  const line = northLine(lat, lng);
  const turnAt = lat + 500 * M_LAT;
  signals.reset();
  const file = makeFile([[lng, turnAt - 15 * M_LAT]]);
  const noSignal = signals.signalsBefore(line, 50, { atSignal: false, files: [file] });
  assert.strictEqual(noSignal.length, 1, "曲がる地点の手前の信号を落とした");
  // 曲がる地点に信号があるなら、それは曲がる交差点そのもの
  assert.deepStrictEqual(signals.signalsBefore(line, 50, { atSignal: true, files: [file] }), [],
    "曲がる交差点の信号を手前の信号として数えた");
  signals.reset();
});

test("経路の指示に手前の信号までの距離を付けてアプリへ渡す", async (t) => {
  if (await skipIfDown(t)) return;
  const { buildRouteResponse } = require("../../service/lib/buildRoute");
  // 市街地（甲府→富士吉田）。実測: 甲府警察署前の左折の手前に信号が3つ（102・221・288m）
  const out = await buildRouteResponse({ from: [138.5683, 35.6620], to: [138.8077, 35.4872], displacement: "large", guidance: false },
                                       { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const steps = out.body.route.steps;
  assert.ok(steps.every((s) => Array.isArray(s.signalsBefore) && s.signalsBefore.every(Number.isInteger)), "形が違う");
  const counted = steps.filter((s) => s.signalsBefore.length);
  assert.ok(counted.length >= 3, `手前の信号を数えた指示が少ない: ${counted.length}`);
  for (const s of counted) {
    assert.ok(s.signalsBefore.every((d, i, a) => d > 0 && d <= 300 && (i === 0 || d > a[i - 1])), `近い順・300m以内でない: ${s.signalsBefore}`);
  }
  // ⚠️ 曲がる交差点そのものの信号は入れない（入れると「2つ目の信号を右です」と1つ多く数える）
  const atSignal = counted.filter((s) => s.atSignal);
  assert.ok(atSignal.length >= 2, "材料が悪い: 信号のある曲がり角で手前に信号がある所が少ない");
  assert.ok(atSignal.every((s) => s.signalsBefore[0] > 30), `曲がる交差点の信号を数えた: ${atSignal.map((s) => s.signalsBefore[0])}`);
});
