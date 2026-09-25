"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { routeIndexMap, roadClassSpans, isTwoStageRightTurn, routeWithValhalla, BASE } = require("../lib/valhallaRoute");

/**
 * 車線の推定の材料（曲がる手前の道の車線数）と、原付の二段階右折。
 *
 * ⚠️ 利用者の判断（2026-09-25）: turn:lanes（車線ごとの向き）は曲がる所の約3%にしか無いので、
 *    車線数から「左折は左端・右折は右端」を推定する（道路交通法34条）。原付は二段階右折も言う。
 */

const encode6 = (pts) => {
  let out = "", pLat = 0, pLng = 0;
  const put = (v) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6), b = Math.round(lng * 1e6); put(a - pLat); put(b - pLng); pLat = a; pLng = b; }
  return out;
};

test("地図に合わせ直した線の番号を、経路の線の番号へ直す", () => {
  const route = [35.000, 35.001, 35.002, 35.003, 35.004].map((lat) => [139, lat]);
  // 合わせ直した線は頭に2点多く、途中に1点足してある
  const matched = [[139, 34.9995], [139, 34.9998], [139, 35.000], [139, 35.001], [139, 35.0015],
                   [139, 35.002], [139, 35.003], [139, 35.004]];
  assert.deepStrictEqual(routeIndexMap(matched, route), [0, 0, 0, 1, 1, 2, 3, 4]);
});

test("同じ所を2回通る経路で、後の通過を前の番号に当てない", () => {
  // 行って戻る: 0→1→2→1'→0'（1' と 0' は 1・0 と同じ位置）
  const route = [[139, 35.000], [139, 35.001], [139, 35.002], [139, 35.001], [139, 35.000]];
  assert.deepStrictEqual(routeIndexMap(route, route), [0, 1, 2, 3, 4]);
});

test("合わせ直したときの車線数の区間は、経路の線の番号で返す", async () => {
  // ⚠️ 実測（72経路中1本・広島→福山）: edge_walk が外れて walk_or_snap になると、同じ番号の点どうしが最大426mずれた
  const route = [35.000, 35.001, 35.002, 35.003, 35.004].map((lat) => [139, lat]);
  const matched = [[139, 34.990], [139, 34.995], [139, 34.998], ...route];
  const replies = [
    { error: "edge_walk algorithm failed to find exact route match" },
    { shape: encode6(matched),
      edges: [{ road_class: "primary", toll: false, lane_count: 1, length: 0.5, begin_shape_index: 0, end_shape_index: 5 },
              { road_class: "primary", toll: false, lane_count: 3, length: 0.2, begin_shape_index: 5, end_shape_index: 7 }] },
  ];
  const original = globalThis.fetch;
  // ⚠️ Valhalla と同じく、頼まれた項目だけ返す（shape を頼まなければ返らない）
  globalThis.fetch = async (url, init) => {
    const r = { ...replies.shift() };
    if (!JSON.parse(init.body).filters.attributes.includes("shape")) delete r.shape;
    return { json: async () => r };
  };
  try {
    const spans = await roadClassSpans(encode6(route), "motorcycle", "http://x");
    assert.deepStrictEqual(spans.map((x) => [x.laneCount, x.begin, x.end]), [[1, 0, 2], [3, 2, 4]]);
  } finally {
    globalThis.fetch = original;
  }
});

test("二段階右折は、原付・右折・信号あり・手前が片側3車線以上のときだけ", () => {
  const turn = { maneuver: "turnRight", atSignal: true, approachLaneCount: 3 };
  assert.strictEqual(isTwoStageRightTurn(turn, "moped50"), true);
  assert.strictEqual(isTwoStageRightTurn({ ...turn, maneuver: "turnSharpRight" }, "moped50"), true);
  assert.strictEqual(isTwoStageRightTurn({ ...turn, approachLaneCount: 4 }, "moped50"), true);
  // 原付でなければ小回り
  for (const d of ["small125", "medium250", "large", undefined]) {
    assert.strictEqual(isTwoStageRightTurn(turn, d), false, String(d));
  }
  // 右折でない（斜め右は分岐のことがある）
  for (const maneuver of ["turnLeft", "turnSlightRight", "keepRight", "uturnRight"]) {
    assert.strictEqual(isTwoStageRightTurn({ ...turn, maneuver }, "moped50"), false, maneuver);
  }
  // 信号が無い・分からない
  assert.strictEqual(isTwoStageRightTurn({ ...turn, atSignal: false }, "moped50"), false);
  assert.strictEqual(isTwoStageRightTurn({ ...turn, atSignal: undefined }, "moped50"), false);
  // 片側2車線以下・分からない
  assert.strictEqual(isTwoStageRightTurn({ ...turn, approachLaneCount: 2 }, "moped50"), false);
  assert.strictEqual(isTwoStageRightTurn({ ...turn, approachLaneCount: null }, "moped50"), false);
  assert.strictEqual(isTwoStageRightTurn({ maneuver: "turnRight", atSignal: true }, "moped50"), false, "項目が無い");
});

// MARK: 実際の Valhalla で

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}
const skipIfDown = async (t) => (await up()) ? false : t.skip(`Valhalla が居ない（${BASE}）`);
// 大阪駅の北西 → 大阪駅前西交差点（手前は片側4車線）で右折 → 梅田２中で左折
const OSAKA_FROM = [135.4950, 34.7020];
const OSAKA_TO = [135.4925, 34.6960];

test("曲がる手前の道の車線数を指示ごとに持つ（大阪駅前西・梅田２中）", async (t) => {
  if (await skipIfDown(t)) return;
  for (const d of ["moped50", "small125", "large"]) {
    const r = await routeWithValhalla(OSAKA_FROM, OSAKA_TO, { displacement: d });
    assert.ok(!r.error, r.error);
    const west = r.steps.find((x) => x.intersectionName === "大阪駅前西");
    const umeda = r.steps.find((x) => x.intersectionName === "梅田２中");
    assert.ok(west && west.maneuver === "turnRight", `材料が悪い（${d}）: 大阪駅前西で右折していない`);
    assert.ok(umeda && umeda.maneuver === "turnLeft", `材料が悪い（${d}）: 梅田２中で左折していない`);
    assert.strictEqual(west.approachLaneCount, 4, d);
    assert.strictEqual(umeda.approachLaneCount, 2, d);
    // ⚠️ 片側4車線・信号ありだが、小回りの標識がある（JARTIC。`mopedTurnRules.test.js`）ので原付でも小回り
    assert.strictEqual(west.twoStageRightTurn, false, d);
    assert.strictEqual(umeda.twoStageRightTurn, false, d);
  }
});
