"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { snapToRoads, SNAP_SEARCH_RADIUS, MAX_SNAP_POINTS } = require("../lib/snapRoads");
const { BASE } = require("../lib/valhallaRoute");

async function skipIfDown(t) {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return false;
  } catch (e) { /* 落ちている */ }
  t.skip(`Valhalla が居ない（${BASE}）`);
  return true;
}

const R = 111320;
const dist = (a, b) => Math.hypot((a[1] - b[1]) * R, (a[0] - b[0]) * R * Math.cos(a[1] * Math.PI / 180));
function segDist(p, a, b) {
  const kx = R * Math.cos(p[1] * Math.PI / 180);
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * R, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * R;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, L > 0 ? -(ax * dx + ay * dy) / L : 0));
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/**
 * 国道134号（江の島→茅ヶ崎、海沿い）を300m間隔で拾った点。
 * ⚠️ 南は海なので、南へずらした点には載せる道が無い
 */
const R134 = [[139.486242, 35.307706], [139.482907, 35.307878], [139.479979, 35.310033],
  [139.477128, 35.312916], [139.473787, 35.315192], [139.471104, 35.316834], [139.467679, 35.31719],
  [139.464211, 35.317152], [139.457295, 35.318341], [139.453343, 35.318944], [139.449986, 35.319444],
  [139.446575, 35.319951], [139.443255, 35.320345], [139.439612, 35.320467], [139.436045, 35.320276],
  [139.432506, 35.320045], [139.428541, 35.31985], [139.423924, 35.319267], [139.420592, 35.318586],
  [139.417329, 35.317984], [139.412596, 35.318273], [139.408278, 35.318581], [139.404951, 35.318673]];
/** 東京湾の中（どの道からも1km以上） */
const SEA = [[139.85, 35.55], [139.86, 35.55], [139.87, 35.55]];

// MARK: 実際に載せる

test("道からずれた点を、元の道の上に戻す", async (t) => {
  if (await skipIfDown(t)) return;
  // 指のずれを真似て、北（陸側）へ40mずらす
  // ⚠️ **元の点との距離で測らないこと。** 道が斜めだと、同じ道の少し先に載る。測るのは道の線まで
  // ⚠️ 60mずらすと並行する別の道に載り始める（実測 23点中9点が道の線から12m超）。40mは同じ道に戻る
  const toLine = (p) => Math.min(...R134.slice(1).map((b, i) => segDist(p, R134[i], b)));
  const drawn = R134.map(([lng, lat]) => [lng, lat + 40 / R]);
  assert.ok(drawn.every((p) => toLine(p) >= 25), "材料が悪い: 道からずらせていない");
  const out = await snapToRoads(drawn, {});
  assert.strictEqual(out.points.length, drawn.length, "数が入力と違う（並びがずれる）");
  const back = out.points.filter((p) => p && toLine(p) <= 12).length;
  assert.ok(back >= drawn.length - 2,
    `元の道に戻ったのが ${back}/${drawn.length} 点しか無い`);
});

test("載せる道が無い点だけを null にし、ほかは残す", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 真ん中の1点だけ1.3km沖へ出す
  const mid = 11;
  const drawn = R134.map((p, i) => (i === mid ? [p[0], p[1] - 0.012] : p));
  const out = await snapToRoads(drawn, {});
  const nulls = out.points.map((p, i) => (p ? null : i)).filter((i) => i !== null);
  assert.deepStrictEqual(nulls, [mid], `沖の点以外も落ちた／沖の点が載った: ${nulls}`);
  // 並びが保たれていること（前後の点がそれぞれ自分の近くに載っている）
  for (const i of [mid - 1, mid + 1]) {
    assert.ok(dist(out.points[i], R134[i]) <= 20, `${i} 番の点が別の場所に載った`);
  }
});

test("どこにも載らない線は、失敗にせず全部 null で返す", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ Valhalla は 444 で返す。失敗にするとアプリがなぞり全体を生の座標に戻してしまう
  const out = await snapToRoads(SEA, {});
  assert.deepStrictEqual(out.points, [null, null, null]);
});

// MARK: 問い合わせの中身

function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply(JSON.parse(init.body)) : reply;
    return { ok: r.status === 200, status: r.status, json: async () => r.json };
  };
  f.calls = calls;
  return f;
}
const matchedAll = (body) => ({ status: 200,
  json: { matched_points: body.shape.map((s) => ({ lat: s.lat + 0.0001, lon: s.lon, type: "matched" })) } });

test("排気量で道の網を選ぶ（原付は高速に載せない）", async () => {
  for (const [displacement, costing] of [["moped50", "motor_scooter"], ["small125", "motor_scooter"],
    ["medium250", "motorcycle"], ["large", "motorcycle"], [undefined, "motorcycle"], ["でたらめ", "motorcycle"]]) {
    const f = fakeFetch(matchedAll);
    await snapToRoads(SEA, { displacement, fetch: f, baseUrl: "http://v" });
    assert.strictEqual(f.calls[0].body.costing, costing, `${displacement} の道の網が ${f.calls[0].body.costing}`);
  }
});

test("指の線に合わせた探し方で問い合わせる", async () => {
  const f = fakeFetch(matchedAll);
  await snapToRoads([[139.1, 35.2], [139.2, 35.3]], { fetch: f, baseUrl: "http://v" });
  const { url, body } = f.calls[0];
  assert.strictEqual(url, "http://v/trace_attributes");
  assert.strictEqual(body.shape_match, "map_snap", "道筋として合わせていない");
  assert.strictEqual(body.trace_options.search_radius, 100);
  assert.strictEqual(SNAP_SEARCH_RADIUS, 100, "配信側の上限（100m）を超える半径にしている");
  assert.strictEqual(body.trace_options.gps_accuracy, 50);
  // ⚠️ [経度, 緯度] → {lat, lon}。取り違えると海の上になる
  assert.deepStrictEqual(body.shape, [{ lat: 35.2, lon: 139.1 }, { lat: 35.3, lon: 139.2 }]);
});

test("載った点は [経度, 緯度] で返し、載らなかった点は null にする", async () => {
  const f = fakeFetch({ status: 200, json: { matched_points: [
    { lat: 35.1, lon: 139.1, type: "matched" },
    { lat: 35.2, lon: 139.2, type: "unmatched" },
    { lat: 35.3, lon: 139.3, type: "interpolated" },
  ] } });
  const out = await snapToRoads(SEA, { fetch: f });
  assert.deepStrictEqual(out.points, [[139.1, 35.1], null, [139.3, 35.3]]);
});

test("どこにも載らないときの番号だけを全部 null にし、それ以外は失敗にする", async () => {
  for (const code of [171, 442, 443, 444]) {
    const out = await snapToRoads(SEA, { fetch: fakeFetch({ status: 400, json: { error_code: code, error: "x" } }) });
    assert.deepStrictEqual(out.points, [null, null, null], `${code} を失敗にしている`);
  }
  // ⚠️ 距離の上限超えなどは「載らない」ではない。黙って全部捨てると、なぞりが消えたことに気づけない
  for (const code of [154, 123, 500]) {
    await assert.rejects(
      snapToRoads(SEA, { fetch: fakeFetch({ status: 400, json: { error_code: code, error: "上限" } }) }),
      `${code} を「載らない」にしている`);
  }
});

test("返ってきた点の数が合わなければ使わない", async () => {
  // ⚠️ 並びがずれると、別の場所の点を経由地にする
  const f = fakeFetch({ status: 200, json: { matched_points: [{ lat: 35, lon: 139, type: "matched" }] } });
  await assert.rejects(snapToRoads(SEA, { fetch: f }), /数が合いません/);
});

test("点の数は2〜100個", async () => {
  const f = fakeFetch(matchedAll);
  await assert.rejects(snapToRoads([[139, 35]], { fetch: f }));
  await assert.rejects(snapToRoads("x", { fetch: f }));
  const many = Array.from({ length: MAX_SNAP_POINTS + 1 }, (_, i) => [139 + i * 0.001, 35]);
  await assert.rejects(snapToRoads(many, { fetch: f }));
  assert.strictEqual(f.calls.length, 0, "崩れた入力を Valhalla に渡した");
  const ok = Array.from({ length: MAX_SNAP_POINTS }, (_, i) => [139 + i * 0.001, 35]);
  const out = await snapToRoads(ok, { fetch: f });
  assert.strictEqual(out.points.length, MAX_SNAP_POINTS);
});
