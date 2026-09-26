"use strict";
const test = require("node:test");
const assert = require("node:assert");
const sapa = require("../lib/sapa");
const gatesLib = require("../lib/smartIcGates");
const { build } = require("../buildSapa");
const { BASE, routeWithValhalla } = require("../lib/valhallaRoute");

/**
 * 経路から寄れる高速の SA/PA（設計と実測は app repo `docs/sapa-plan.md`）。
 * 利用者の要望（2026-09-26）: 次の SA/PA までの距離・一覧から立ち寄れる・ガソリンスタンドの有無。
 */

const meters = (lat1, lon1, lat2, lon2) =>
  Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * 111320 * Math.cos((lat1 * Math.PI) / 180));
/** 中心 (lat, lon) の四角い輪（半分の幅 m） */
function square(lat, lon, half) {
  const dLat = half / 111320;
  const dLon = half / (111320 * Math.cos((lat * Math.PI) / 180));
  return [[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]];
}
/** 東へまっすぐの線（緯度 35.0・経度 139.00〜139.10・約 9.1km）。[経度, 緯度] */
const LINE = Array.from({ length: 101 }, (_, i) => [139.0 + i * 0.001, 35.0]);
const area = (name, lat, lon, extra = {}) => ({ name, lat, lon, kind: sapa.kindOf(name), fuel: "unknown", ring: square(lat, lon, 60), ...extra });

// ---- 純ロジック ----

test("名前で SA/PA を見分ける（道の駅・歩いて入る口・Sapporo は入れない）", () => {
  for (const n of ["海老名SA (下り)", "足柄サービスエリア", "静岡ＳＡ（上り）", "港北パーキングエリア", "刈谷ハイウェイオアシス"]) {
    assert.ok(sapa.isSapaName(n), n);
  }
  // ⚠️ 大文字小文字を区別しないと「Sapporo」の Sa を SA とみなす（占冠PA の中のバス停）
  // ⚠️ 道の駅は「ハイウェイオアシス」を名乗っていても入れない（一般道から入る）
  for (const n of ["道の駅 八王子滝山", "道の駅 刈谷ハイウェイオアシス", "ウォークインゲート高坂SA", "Bus stop for rest from Kushiro to Sapporo", "", undefined]) {
    assert.ok(!sapa.isSapaName(n), String(n));
  }
  assert.strictEqual(sapa.kindOf("中井PA (下り)", "services"), "PA", "名前を先に見ていない（services の PA が多い）");
  assert.strictEqual(sapa.kindOf("海老名SA (上り)", "rest_area"), "SA");
  assert.strictEqual(sapa.kindOf("港北パーキングエリア", "services"), "PA");
  assert.strictEqual(sapa.kindOf("刈谷ハイウェイオアシス", "services"), "SA");
  assert.strictEqual(sapa.kindOf("刈谷ハイウェイオアシス", "rest_area"), "PA");
});

test("重なった敷地は大きい方を落とし、上り下りは両方残す", () => {
  // 佐野: まとめた大きい敷地（中心が「上り」の中に落ちる）と上り・下り
  const up = { name: "佐野SA (上り)", lat: 36.3183, lon: 139.6180, ring: square(36.3183, 139.6180, 80) };
  const down = { name: "佐野SA (下り)", lat: 36.3171, lon: 139.6192, ring: square(36.3171, 139.6192, 80) };
  const umbrella = { name: "佐野サービスエリア", lat: 36.3180, lon: 139.6183, ring: square(36.3177, 139.6186, 250) };
  assert.ok(sapa.pointInRing(umbrella.lat, umbrella.lon, up.ring), "材料が悪い: まとめた敷地の中心が上りの中にない");
  assert.deepStrictEqual(sapa.dropUmbrellas([umbrella, up, down]).map((a) => a.name), ["佐野SA (上り)", "佐野SA (下り)"],
                         "上りを落とした／まとめた敷地を残した");
  // 向きの違う2つは、中心が入っていても両方残す（京橋PA）
  const kUp = { name: "京橋PA (上り)", lat: 34.70, lon: 135.20, ring: square(34.70, 135.20, 200) };
  const kDown = { name: "京橋PA (下り)", lat: 34.7005, lon: 135.2005, ring: square(34.7005, 135.2005, 50) };
  assert.strictEqual(sapa.dropUmbrellas([kUp, kDown]).length, 2);
  // 点だけの SA/PA は、囲む敷地があれば落とす
  const point = { name: "池田PA", lat: 34.70, lon: 135.20, ring: [] };
  assert.deepStrictEqual(sapa.dropUmbrellas([point, kUp]).map((a) => a.name), ["京橋PA (上り)"]);
  assert.strictEqual(sapa.dropUmbrellas([point]).length, 1, "囲む敷地が無い点まで落とした");
});

test("ガソリンスタンドは敷地の中にあれば「あり」、無ければ「不明」", () => {
  const a = area("足柄SA (下り)", 35.30, 138.96);
  assert.strictEqual(sapa.fuelOf(a, [[35.3002, 138.9601]]), "yes");
  assert.strictEqual(sapa.fuelOf(a, [[35.31, 138.96]]), "unknown", "敷地の外のスタンドを数えた");
  assert.strictEqual(sapa.fuelOf(a, []), "unknown");
});

test("経路のそばの SA/PA を経路の順に候補にする（出発・到着の 2km 以内は除く）", () => {
  const far = area("遠いSA", 35.0 + 500 / 111320, 139.05);     // 500m 北
  const near2 = area("二つ目PA", 35.0 + 150 / 111320, 139.07);
  const near1 = area("一つ目SA", 35.0 - 100 / 111320, 139.03);
  const start = area("出発のそばPA", 35.0, 139.01);            // 出発から 0.9km
  const cands = sapa.candidatesAlong(LINE, [far, near2, near1, start]);
  assert.deepStrictEqual(cands.map((c) => c.area.name), ["一つ目SA", "二つ目PA"]);
  assert.ok(Math.abs(cands[0].alongMeters - 0.03 * 111320 * Math.cos(35 * Math.PI / 180)) < 100, `距離が違う ${cands[0].alongMeters}`);
  assert.strictEqual(cands[0].index, 30);
});

test("試す点は、中心・経路に近い端・敷地の内側だけ（外接四角の点は使わない）", () => {
  // L字の敷地。外接四角の右上は敷地の外（隣の反対側の SA に落ちる形）
  const lat = 35.01, lon = 139.05;
  const d = 100 / 111320;
  const ring = [[lon, lat], [lon + 2 * d, lat], [lon + 2 * d, lat + d], [lon + d, lat + d], [lon + d, lat + 2 * d], [lon, lat + 2 * d], [lon, lat]];
  const a = { name: "L字PA", lat: lat + 0.8 * d, lon: lon + 0.8 * d, ring };
  const pts = sapa.trialPoints(a, [lon + 2 * d, lat - d]);
  assert.deepStrictEqual(pts[0], { lat: a.lat, lon: a.lon }, "中心から試していない");
  assert.ok(Math.abs(pts[1].lon - ((lon + 2 * d) * 0.75 + a.lon * 0.25)) < 1e-9, "2番目が経路に近い端でない");
  assert.ok(pts.slice(2).every((p) => sapa.pointInRing(p.lat, p.lon, ring)), "敷地の外の点を試している");
  assert.ok(pts.length >= 4 && pts.length < 7, `内側の点が無い／外の点が混ざった（${pts.length}）`);
  assert.deepStrictEqual(sapa.trialPoints({ lat, lon, ring: [] }, [lon, lat]), [{ lat, lon }], "点だけの SA/PA");
});

test("寄れるかの判定: 遠回り1.5km未満・スマートIC経由は決めない・8km以上は反対側", () => {
  assert.strictEqual(sapa.judge(100, false), "reachable");
  assert.strictEqual(sapa.judge(1400, false), "reachable", "実測の最大（新東名の静岡SA 1.4km）を落とした");
  assert.strictEqual(sapa.judge(1600, false), "unknown");
  assert.strictEqual(sapa.judge(9300, false), "opposite", "反対側の最小（実測 9.3km）を反対側とみなさない");
  // ⚠️ 反対側の SA でもスマートICで回り込めば +2.4km（足柄SA）。寄れるとも反対側とも決めない
  assert.strictEqual(sapa.judge(100, true), "unknown");
  assert.strictEqual(sapa.judge(20000, true), "unknown");
  assert.strictEqual(sapa.judge(NaN, false), "unknown");
});

// ---- 引き直し（偽の Valhalla）----

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
/** 寄り道の偽の応答。区間0の終わり＝寄った点（SA/PA の中の道） */
function detour(from, stop, to, extraMeters, through = []) {
  const direct = meters(from.lat, from.lon, to.lat, to.lon);
  return {
    trip: {
      legs: [{ shape: encode6([[from.lon, from.lat], ...through, [stop[0], stop[1]]]) },
             { shape: encode6([[stop[0], stop[1]], [to.lon, to.lat]]) }],
      summary: { length: (direct + extraMeters) / 1000 },
    },
  };
}
/** fetch を差し替えて sapaAlongRoute を動かす。reply(body, n) は n 回目の頼み */
async function run(areas, reply, gates = gatesLib.index([])) {
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return { json: async () => reply(body, sent.length) };
  };
  const out = await sapa.sapaAlongRoute(LINE, { areas, gates, fetch, baseUrl: "http://127.0.0.1:9" });
  return { out, sent };
}
const via = (body) => body.locations[1];
const ends = (body) => [body.locations[0], body.locations[2]];

test("寄れる SA/PA だけを経路の順に返し、足す点は寄った先（SA/PA の中の道）", async () => {
  const A = area("一つ目SA (下り)", 35.0 + 120 / 111320, 139.03, { fuel: "yes" });
  const B = area("反対側SA (上り)", 35.0 - 120 / 111320, 139.06);
  const reply = (body) => {
    const [from, to] = ends(body);
    const p = via(body);
    const isA = Math.abs(p.lat - A.lat) < 0.002 && Math.abs(p.lon - A.lon) < 0.002;
    return detour(from, [p.lon + 0.0002, p.lat], to, isA ? 100 : 15000);
  };
  const { out, sent } = await run([B, A], reply);
  assert.deepStrictEqual(out.map((x) => x.name), ["一つ目SA (下り)"], "反対側を出した／寄れる方を落とした");
  assert.strictEqual(out[0].kind, "SA");
  assert.strictEqual(out[0].fuel, "yes");
  assert.ok(Math.abs(out[0].alongMeters - 2736) < 150, `距離 ${out[0].alongMeters}`);
  assert.deepStrictEqual(out[0].stop, [Number((A.lon + 0.0002).toFixed(6)), Number(A.lat.toFixed(6))],
                         "足す点が寄った先でない（中心を返すと本線に吸い付く）");
  // ⚠️ SA/PA の中の道に寄せている
  assert.ok(sent.every((b) => via(b).search_filter && via(b).search_filter.max_road_class === "service_other"),
            "寄る点を本線に吸い付かせている");
  assert.ok(sent.every((b) => via(b).type === "break"));
  // 確かめる区間は経路の 2km 手前から 2km 先
  const [from, to] = ends(sent.find((b) => Math.abs(via(b).lat - A.lat) < 0.002));
  assert.ok(Math.abs(meters(from.lat, from.lon, to.lat, to.lon) - 4000) < 200, "確かめる区間の長さが違う");
});

test("スマートIC経由は寄れないとみなして、敷地の別の点を試す", async () => {
  const A = area("談合坂SA (上り)", 35.0 + 120 / 111320, 139.05);
  const gate = { lat: 35.002, lon: 139.052, half: 10, ic: "談合坂スマートIC" };
  // 1回目（中心）はスマートICを通って +100m、2回目（経路に近い端）はそのまま +100m
  const reply = (body, n) => {
    const [from, to] = ends(body);
    const p = via(body);
    return detour(from, [p.lon, p.lat], to, 100, n === 1 ? [[gate.lon, gate.lat]] : []);
  };
  const { out, sent } = await run([A], reply, gatesLib.index([gate]));
  assert.strictEqual(sent.length, 2, "スマートIC経由で寄れると決めた／次の点を試していない");
  assert.deepStrictEqual(out.map((x) => x.name), ["談合坂SA (上り)"]);
  // どの点でもスマートIC経由なら出さない
  const always = (body) => { const [from, to] = ends(body); const p = via(body); return detour(from, [p.lon, p.lat], to, 100, [[gate.lon, gate.lat]]); };
  assert.deepStrictEqual((await run([A], always, gatesLib.index([gate]))).out, []);
});

test("反対側（8km以上の遠回り）なら2点目で諦め、引けない点は飛ばす", async () => {
  const B = area("反対側SA (上り)", 35.0 - 120 / 111320, 139.05);
  const far = (body) => { const [from, to] = ends(body); const p = via(body); return detour(from, [p.lon, p.lat], to, 15000); };
  const { out, sent } = await run([B], far);
  assert.deepStrictEqual(out, []);
  assert.strictEqual(sent.length, 2, `反対側なのに試し続けた（${sent.length}回）`);
  // 1回目が引けなくても次の点を試す
  const A = area("一つ目PA (下り)", 35.0 + 120 / 111320, 139.05);
  const flaky = (body, n) => (n === 1 ? { error: "No path" } : (() => { const [f, t] = ends(body); const p = via(body); return detour(f, [p.lon, p.lat], t, 50); })());
  assert.deepStrictEqual((await run([A], flaky)).out.map((x) => x.name), ["一つ目PA (下り)"]);
});

test("同じ名前の敷地が続けて寄れても1つにする", async () => {
  const A1 = area("中井PA (下り)", 35.0 + 120 / 111320, 139.050);
  const A2 = area("中井PA (下り)", 35.0 + 120 / 111320, 139.053);
  const ok = (body) => { const [f, t] = ends(body); const p = via(body); return detour(f, [p.lon, p.lat], t, 50); };
  assert.strictEqual((await run([A1, A2], ok)).out.length, 1);
});

// ---- 一覧を作る（admin/buildSapa.js）----

test("一覧を作る: 敷地・ガソリンスタンド・道の駅を見分ける", () => {
  const poly = (name, lat, lon, half, highway = "services") => ({ properties: { highway, name }, geometry: { type: "Polygon", coordinates: [square(lat, lon, half)] } });
  const features = [
    poly("足柄SA (下り)", 35.30, 138.96, 80),
    { properties: { amenity: "fuel" }, geometry: { type: "Point", coordinates: [138.9601, 35.3002] } },
    poly("道の駅 ふじおやま", 35.31, 138.95, 80),
    poly("", 35.32, 138.95, 80),
    { properties: { highway: "rest_area", name: "鮎沢PA (上り)" }, geometry: { type: "MultiPolygon", coordinates: [[square(35.33, 138.97, 20)], [square(35.331, 138.97, 90)]] } },
    { properties: { highway: "rest_area", name: "点だけPA" }, geometry: { type: "Point", coordinates: [139.10, 35.40] } },
    // 上下線をまとめた大きい敷地（足柄SA (下り) の中心を含む）は落とす
    poly("足柄サービスエリア", 35.3003, 138.9603, 400),
  ];
  const areas = build(features);
  const byName = Object.fromEntries(areas.map((a) => [a[3], a]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ["点だけPA", "足柄SA (下り)", "鮎沢PA (上り)"].sort());
  assert.strictEqual(byName["足柄SA (下り)"][4], 1, "敷地の中のスタンドを数えていない");
  assert.strictEqual(byName["鮎沢PA (上り)"][4], 0);
  assert.strictEqual(byName["鮎沢PA (上り)"][2], "PA");
  // 複数の輪は大きい方（敷地の本体）
  assert.ok(Math.abs(byName["鮎沢PA (上り)"][0] - 35.331) < 0.0005, "小さい方の輪を使った");
  assert.deepStrictEqual(byName["点だけPA"][5], []);
});

test("配る一覧: 上り下りがそろい、まとめた敷地・歩いて入る口・道の駅は入らない", () => {
  const areas = sapa.load();
  assert.ok(areas.length >= 900, `少なすぎる（${areas.length}）`);
  const names = areas.map((a) => a.name);
  assert.ok(names.includes("佐野SA (上り)") && names.includes("佐野SA (下り)"), "佐野SA の上り下りがそろっていない");
  assert.ok(!names.includes("佐野サービスエリア"), "まとめた敷地が残っている");
  assert.ok(!names.some((n) => /ウォークイン|道の駅|Sapporo/.test(n)), "SA/PA でないものが入っている");
  assert.strictEqual(areas.find((a) => a.name === "海老名SA (下り)").fuel, "yes");
  assert.ok(areas.every((a) => a.kind === "SA" || a.kind === "PA"));
  assert.ok(areas.filter((a) => a.fuel === "yes").length >= 150, "ガソリンスタンドの判定が落ちている");
});

// ---- 実際の Valhalla ----

async function up() {
  try { return (await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) })).ok; } catch (e) { return false; }
}

test("実際の Valhalla: 東名の下りでは下りの SA/PA だけを経路の順に出す", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  const r = await routeWithValhalla([139.6334, 35.6264], [136.9066, 35.1709], { displacement: "large" });
  assert.ok(r && !r.error, r && r.error);
  const out = await sapa.sapaAlongRoute(r.points, { baseUrl: BASE });
  const names = out.map((x) => x.name);
  for (const n of ["港北PA (下り)", "海老名SA (下り)", "中井PA (下り)", "足柄SA (下り)", "浜松SA (下り)"]) {
    assert.ok(names.includes(n), `${n} が無い（${names}）`);
  }
  assert.ok(!names.some((n) => /上り/.test(n)), `反対側を出した（${names.filter((n) => /上り/.test(n))}）`);
  assert.deepStrictEqual(out.map((x) => x.alongMeters), out.map((x) => x.alongMeters).slice().sort((a, b) => a - b), "経路の順でない");
  assert.ok(Math.abs(out.find((x) => x.name === "海老名SA (下り)").alongMeters - 32000) < 2000);
});
