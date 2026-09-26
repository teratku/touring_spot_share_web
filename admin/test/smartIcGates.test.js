"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const gatesLib = require("../lib/smartIcGates");
const { routeWithValhalla, BASE } = require("../lib/valhallaRoute");

/**
 * ETC車載器の無い乗り手の経路から、スマートIC（ETC専用）を外す。
 *
 * 利用者の要望（2026-09-26）: スマートICは ETC 専用。車載器が無いバイクで入ると通れない。
 * ⚠️ Valhalla は ETC 専用かどうかを知らないので、通ったゲートを塞いで引き直す（`lib/smartIcGates.js`）。
 */

const meters = (lat1, lon1, lat2, lon2) =>
  Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * 111320 * Math.cos((lat1 * Math.PI) / 180));
/** (lat, lon) から東へ m メートル */
const east = (lat, lon, m) => [lon + m / (111320 * Math.cos((lat * Math.PI) / 180)), lat];
/** (lat, lon) から北へ m メートル */
const north = (lat, lon, m) => [lon, lat + m / 111320];

// ---- 純ロジック ----

test("経路が通ったゲートだけを、通った順に1回ずつ返す", () => {
  const A = { lat: 35.68, lon: 139.73, half: 10, ic: "Aスマート" };
  const B = { lat: 35.68, lon: 139.75, half: 10, ic: "Bスマート" };
  const C = { lat: 35.70, lon: 139.74, half: 10, ic: "Cスマート" };
  const data = gatesLib.index([C, B, A]);
  const points = [[139.72, 35.68], east(35.68, 139.73, 0.5), east(35.68, 139.73, 0.8),   // A を2点で通る
                  north(35.68, 139.745, 0), [B.lon, B.lat], [139.76, 35.68]];
  assert.deepStrictEqual(gatesLib.gatesOnRoute(points, data).map((g) => g.ic), ["Aスマート", "Bスマート"]);
  assert.deepStrictEqual(gatesLib.gatesOnRoute([], data), []);
  assert.deepStrictEqual(gatesLib.gatesOnRoute(points, gatesLib.index([])), []);
});

test("そばの一般道を走っただけでは通ったとみなさない", () => {
  // ⚠️ ゲートは線の頂点そのもの。広く取ると、そばを走っただけで塞いで遠回りさせる
  const G = { lat: 36.0, lon: 139.0, half: 10, ic: "Gスマート" };
  const data = gatesLib.index([G]);
  assert.strictEqual(gatesLib.gatesOnRoute([north(36.0, 139.0, 8)], data).length, 0, "8m 離れた道で通ったとみなした");
  assert.strictEqual(gatesLib.gatesOnRoute([north(36.0, 139.0, 4)], data).length, 1);
  // 升目の境をまたいでも見つける（1km の升目の端のゲート）
  const edge = { lat: 36.0099999, lon: 139.0099999, half: 10, ic: "端" };
  assert.strictEqual(gatesLib.gatesOnRoute([[139.0100001, 36.0100001]], gatesLib.index([edge])).length, 1);
});

test("塞ぐ四角はゲートを中心に、ゲートごとの大きさで作る", () => {
  const G = { lat: 36.0, lon: 139.0, half: 6.9, ic: "加計" };
  const [ring] = gatesLib.boxesFor([G]);
  assert.strictEqual(ring.length, 5);
  assert.deepStrictEqual(ring[0], ring[4], "輪が閉じていない（Valhalla が受け取らない）");
  const lons = ring.map((p) => p[0]); const lats = ring.map((p) => p[1]);
  const width = meters(36.0, Math.min(...lons), 36.0, Math.max(...lons));
  const height = meters(Math.min(...lats), 139.0, Math.max(...lats), 139.0);
  // ⚠️ 本線から11.8mのゲートがある。一律に広げると本線ごと塞ぐ
  assert.ok(Math.abs(width - 13.8) < 0.2 && Math.abs(height - 13.8) < 0.2, `大きさが違う ${width} x ${height}`);
  assert.ok(Math.abs((Math.min(...lons) + Math.max(...lons)) / 2 - 139.0) < 1e-9, "ゲートが真ん中にない");
  assert.ok(Math.abs((Math.min(...lats) + Math.max(...lats)) / 2 - 36.0) < 1e-9);
});

test("通ったスマートICの名前を重複なく返す", () => {
  assert.deepStrictEqual(gatesLib.icNames([{ ic: "上里SA" }, { ic: "寄居PA" }, { ic: "上里SA" }, { ic: "" }]),
                         ["上里SA", "寄居PA"]);
});

test("一覧が読めなければ避けない（経路は止めない）", () => {
  const data = gatesLib.load(path.join(__dirname, "no-such-smart-ic-gates.json"));
  assert.strictEqual(data.gates.length, 0);
  assert.deepStrictEqual(gatesLib.gatesOnRoute([[139, 36]], data), []);
  // ⚠️ 読めなかったことを覚えて、本物の一覧まで空にしない（覚えるのはファイルごと）
  assert.ok(gatesLib.load().gates.length > 0, "読めなかった一覧を覚えてしまい、本物を読まない");
});

// ---- 配る一覧（admin/data/smart-ic-gates.json）----

test("配る一覧: スマートICのゲートが入り、普通の IC と本線の料金所は入らない", () => {
  const data = gatesLib.load();
  // 実測 2026-09-26: 606か所（名前359・つながり240・近さ7）。スマートICの分岐は327
  assert.ok(data.gates.length >= 550, `ゲートが少なすぎる（${data.gates.length}）`);
  const near = (lat, lon, m = 3) => data.gates.filter((g) => meters(lat, lon, g.lat, g.lon) <= m);
  // 亀山スマートIC（名前で）
  assert.strictEqual(near(34.86724, 136.41446).length, 1, "亀山スマートIC のゲートが無い");
  // ⚠️ 亀山IC（普通の IC）の料金所は、亀山PA/スマートIC から道のり290mで届くが入れない
  assert.strictEqual(near(34.8611735, 136.4129808).length, 0, "普通の亀山IC の料金所を塞ぐ");
  // ⚠️ 三郷料金所（本線の料金所）はスマートICの分岐から238m。入れると常磐道が通れない
  assert.strictEqual(near(35.8652743, 139.8834076, 30).length, 0, "本線の三郷料金所を塞ぐ");
  // 高崎玉村スマートIC のゲート（名前は「高崎玉村IC」だが、普通の高崎玉村IC は無い）
  assert.strictEqual(near(36.307381, 139.0936595).length, 1, "高崎玉村スマートIC のゲートが無い");
  // ⚠️ 塞ぐ大きさは本線に触れない幅（半分の幅10m以下）
  assert.ok(data.gates.every((g) => g.half > 0 && g.half <= 10), "塞ぐ四角が大きすぎる");
  assert.ok(data.gates.every((g) => g.ic), "IC の名前が無いゲートがある");
});

// ---- 引き直し（偽の Valhalla）----

/** 6桁で符号化（Valhalla の shape と同じ） */
function encode6(points) {
  let out = "", lat = 0, lng = 0;
  const push = (v) => {
    let x = v < 0 ? ~(v << 1) : (v << 1);
    while (x >= 0x20) { out += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; }
    out += String.fromCharCode(x + 63);
  };
  for (const [x, y] of points) {
    const la = Math.round(y * 1e6), ln = Math.round(x * 1e6);
    push(la - lat); push(ln - lng);
    lat = la; lng = ln;
  }
  return out;
}
function trip(points) {
  return {
    legs: [{
      shape: encode6(points),
      maneuvers: [
        { type: 1, instruction: "走る", street_names: ["テスト通り"], begin_shape_index: 0,
          end_shape_index: points.length - 2, length: 5, time: 300 },
        { type: 4, instruction: "着く", street_names: [], begin_shape_index: points.length - 2,
          end_shape_index: points.length - 1, length: 0, time: 0 },
      ],
    }],
    summary: { length: 5, time: 300 },
  };
}
const G1 = { lat: 35.68, lon: 139.73, half: 10, ic: "一のスマートIC" };
const G2 = { lat: 35.69, lon: 139.73, half: 10, ic: "二のスマートIC" };
const VIA_G1 = [[139.70, 35.68], [139.73, 35.68], [139.76, 35.68]];
const VIA_G2 = [[139.70, 35.68], [139.72, 35.69], [139.73, 35.69], [139.76, 35.68]];
const CLEAN = [[139.70, 35.68], [139.72, 35.70], [139.74, 35.70], [139.76, 35.68]];
/** 送った塞ぎの中に、そのゲートを囲む四角があるか */
const blocks = (body, g) => (body.exclude_polygons || []).some((ring) => {
  const lons = ring.map((p) => p[0]); const lats = ring.map((p) => p[1]);
  return Math.min(...lons) < g.lon && g.lon < Math.max(...lons) && Math.min(...lats) < g.lat && g.lat < Math.max(...lats);
});

/**
 * fetch を差し替えて routeWithValhalla を動かす。
 * @param reply (body) => 応答。塞ぎ（body.exclude_polygons）を見て返す線を変える
 */
async function run(reply, opts) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("trace_attributes")) {
      return { ok: true, json: async () => ({ edges: [], admins: [] }) };
    }
    const body = JSON.parse(init.body);
    sent.push(body);
    return { ok: true, json: async () => reply(body) };
  };
  try {
    const route = await routeWithValhalla([139.70, 35.68], [139.76, 35.68], {
      baseUrl: "http://127.0.0.1:9", withRoadClass: false, prefectureSpans: false,
      displacement: "large", smartIcGates: gatesLib.index([G1, G2]), ...opts,
    });
    return { route, sent };
  } finally { globalThis.fetch = real; }
}

test("車載器なしなら、通ったスマートICのゲートを塞いで引き直す", async () => {
  const { route, sent } = await run((b) => ({ trip: trip(blocks(b, G1) ? CLEAN : VIA_G1) }), { avoidEtcOnly: true });
  assert.ok(route && !route.error, route && route.error);
  assert.strictEqual(sent.length, 2, `引き直していない（${sent.length}回）`);
  assert.ok(!sent[0].exclude_polygons, "最初から塞いでいる（周囲の上限に当たる）");
  assert.ok(blocks(sent[1], G1), "通ったゲートを塞いでいない");
  assert.ok(!blocks(sent[1], G2), "通っていないゲートまで塞いでいる");
  assert.deepStrictEqual(gatesLib.gatesOnRoute(route.points, gatesLib.index([G1, G2])), [], "スマートICを通ったまま");
  assert.deepStrictEqual(route.etcOnlyIcs, []);
  assert.strictEqual(route.etcOnlyTries, 1);
});

test("車載器ありなら（etc を渡さなければ）今までどおり塞がない", async () => {
  const { route, sent } = await run(() => ({ trip: trip(VIA_G1) }), {});
  assert.strictEqual(sent.length, 1, "車載器ありなのに引き直した");
  assert.ok(!sent[0].exclude_polygons);
  assert.strictEqual(route.etcOnlyIcs, undefined, "頼まれていないのに ETC の項目を返した");
});

test("塞いだ先で別のスマートICに乗ったら、それも塞ぐ", async () => {
  const reply = (b) => ({ trip: trip(blocks(b, G1) && blocks(b, G2) ? CLEAN : blocks(b, G1) ? VIA_G2 : VIA_G1) });
  const { route, sent } = await run(reply, { avoidEtcOnly: true });
  assert.strictEqual(sent.length, 3);
  assert.ok(blocks(sent[2], G1) && blocks(sent[2], G2), "前に塞いだゲートを外した");
  assert.deepStrictEqual(route.etcOnlyIcs, []);
  assert.strictEqual(route.etcOnlyTries, 2);
});

test("代替がスマートICを通っても塞ぐ", async () => {
  // ⚠️ 有料の禁止で踏んだのと同じ。本命だけ見ると、代替の先頭にスマートIC経由が出る
  const reply = (b) => (blocks(b, G1)
    ? { trip: trip(CLEAN), alternates: [{ trip: trip(CLEAN) }] }
    : { trip: trip(CLEAN), alternates: [{ trip: trip(VIA_G1) }] });
  const { route, sent } = await run(reply, { avoidEtcOnly: true, alternates: 1 });
  assert.ok(sent.length >= 2 && blocks(sent[sent.length - 1], G1), "代替が通ったゲートを塞いでいない");
  assert.deepStrictEqual(route.alternates.map((a) => a.etcOnlyIcs), [[]]);
});

test("塞ぐと引けないなら元の経路にして、通るスマートICを返す", async () => {
  // ⚠️ 黙って通させない（車載器が無いと出入りできない）
  const reply = (b) => (blocks(b, G1) ? { error: "No path could be found for input" } : { trip: trip(VIA_G1) });
  // ⚠️ 「左側に着く」はあとで引き直す。塞ぎを戻し忘れると、そこでも引けずに寄せが効かなくなる
  const { route, sent } = await run(reply, { avoidEtcOnly: true, arriveOnNearSide: true });
  assert.ok(route && !route.error, "引けないときに経路ごと失敗にした");
  assert.deepStrictEqual(route.etcOnlyIcs, ["一のスマートIC"]);
  assert.ok(sent.length >= 3, `材料が悪い: あとの引き直しが走っていない（${sent.length}回）`);
  assert.ok(sent.slice(2).every((b) => !blocks(b, G1)), "引けなかった塞ぎを戻さず、あとの引き直しに持ち込んだ");
});

test("高速に乗れない排気量には効かせない", async () => {
  // 原付は高速を通らない（use_highways: 0）。スマートICを見るまでもない
  const { sent } = await run(() => ({ trip: trip(VIA_G1) }), { avoidEtcOnly: true, displacement: "small125" });
  assert.ok(!sent.some((b) => blocks(b, G1)), "原付二種でスマートICを塞いだ");
});

// ---- 実際の Valhalla ----

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}
// 実測（2026-09-26）: 本庄の南から谷川岳PAへ。ふつうに引くと上里SAスマートIC（下り）から関越道に乗る
const KAMISATO_FROM = [139.13044, 36.2469];
const TANIGAWA = [138.93941, 36.78062];

test("実際の Valhalla: 車載器なしなら上里SAスマートICを通らず、遠回りは小さい", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  const gates = gatesLib.load();
  const plain = await routeWithValhalla(KAMISATO_FROM, TANIGAWA, { displacement: "large" });
  assert.ok(plain && !plain.error, plain && plain.error);
  const used = gatesLib.icNames(gatesLib.gatesOnRoute(plain.points, gates));
  // ⚠️ 材料の確かめ。通っていなければこの検査は何も確かめていない
  assert.ok(used.some((n) => /上里/.test(n)), `材料が悪い: ふつうに引いても上里SAスマートICを通らない（${used}）`);
  const noEtc = await routeWithValhalla(KAMISATO_FROM, TANIGAWA, { displacement: "large", avoidEtcOnly: true });
  assert.ok(noEtc && !noEtc.error, noEtc && noEtc.error);
  assert.deepStrictEqual(gatesLib.gatesOnRoute(noEtc.points, gates), [], "スマートICを通ったまま");
  assert.deepStrictEqual(noEtc.etcOnlyIcs, []);
  // 実測 +6.1km・+8分。普通の IC へ回るだけ（大回りしていない）
  const extra = (noEtc.lengthMeters - plain.lengthMeters) / 1000;
  assert.ok(extra < 20, `遠回りが大きすぎる（+${extra.toFixed(1)}km）`);
});
