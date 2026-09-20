"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { routeWithValhalla, locationType } = require("../lib/valhallaRoute");

/**
 * 経由地（立ち寄り先）ごとの区間の切れ目。
 *
 * ⚠️ **ここが消えると、立ち寄り先に着いても何も起きない。**
 *    Valhalla は経由地ごとに `legs` を返すが、平らに繋いだ時点で
 *    区切りが失われていた（実機で報告: 立ち寄り先を設定したのに経路に出ず、
 *    通過しても反応が無かった）。
 */

/** 東へ伸びる線を6桁で符号化する（Valhalla の shape と同じ精度） */
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

/** 区間を n 個持つ偽の応答 */
function fakeTrip(legCount) {
  const legs = [];
  for (let i = 0; i < legCount; i++) {
    const base = 139.70 + i * 0.02;
    legs.push({
      shape: encode6([[base, 35.68], [base + 0.01, 35.68], [base + 0.02, 35.68]]),
      maneuvers: [
        { type: 1, instruction: `区間${i} を走る`, street_names: ["テスト通り"],
          begin_shape_index: 0, end_shape_index: 1, length: 1, time: 60 },
        // ⚠️ 区間の最後は到着の maneuver（type 4）
        { type: 4, instruction: `区間${i} の終わりに着く`, street_names: [],
          begin_shape_index: 1, end_shape_index: 2, length: 1, time: 60 },
      ],
    });
  }
  return { trip: { legs, summary: { length: legCount * 2, time: legCount * 120 } } };
}

/** fetch を差し替えて routeWithValhalla を動かす */
async function run(legCount) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // ⚠️ 県と道の種別は別の窓口。ここでは空を返して経路だけを見る
    if (String(url).includes("trace_attributes")) {
      return { ok: true, json: async () => ({ edges: [], admins: [] }) };
    }
    return { ok: true, json: async () => fakeTrip(legCount) };
  };
  try {
    return await routeWithValhalla([139.70, 35.68], [139.76, 35.68], {
      vias: legCount > 1 ? [[139.72, 35.68]] : [],
      baseUrl: "http://127.0.0.1:9", withRoadClass: false, prefectureSpans: false,
    });
  } finally { globalThis.fetch = real; }
}

test("経由地ごとに区間の終わりが印される", async () => {
  // ⚠️ **これが本体。** 印が無いと、立ち寄り先に着いても案内が出ない
  const route = await run(2);
  assert.ok(route && !route.error, `経路が引けない: ${route && route.error}`);
  const ends = route.steps.map((s, i) => (s.isLegEnd ? i : null)).filter((x) => x !== null);
  assert.strictEqual(ends.length, 2, `区間の終わりが ${ends.length}件（2件のはず）`);
  // 最後の指示だけでなく、途中にも印があること
  assert.ok(ends[0] < route.steps.length - 1,
            "途中の立ち寄り先に印が付いていない（最後の1つだけになっている）");
  // ⚠️ **付けすぎもいけない。** 区間の途中の指示に印が付くと、
  //    走っている最中に何度も「着きました」と言うことになる。
  //    印は各区間の**最後の1つ**だけ
  const perLeg = 2;                            // この材料は1区間につき指示2件
  assert.deepStrictEqual(ends, [perLeg - 1, perLeg * 2 - 1],
    `印の位置が違う: ${JSON.stringify(ends)}（各区間の最後だけのはず）`);
});

test("経由地が無ければ終わりは1つ", async () => {
  const route = await run(1);
  const ends = route.steps.filter((s) => s.isLegEnd).length;
  assert.strictEqual(ends, 1, `区間の終わりが ${ends}件（1件のはず）`);
});

test("区間をまたいで線が繋がる", async () => {
  // ⚠️ 区間ごとに shape が別なので、繋ぎ方を間違えると線が飛ぶ
  const route = await run(2);
  for (let i = 1; i < route.points.length; i++) {
    const dx = Math.abs(route.points[i][0] - route.points[i - 1][0]);
    assert.ok(dx < 0.05, `${i}番目で線が飛んでいる（${dx.toFixed(4)}度）`);
  }
});

/** 経由地の type を覗くために、投げた body を捕まえる */
async function bodySent(opts) {
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("trace_attributes")) {
      return { ok: true, json: async () => ({ edges: [], admins: [] }) };
    }
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => fakeTrip(1) };
  };
  try {
    await routeWithValhalla([139.70, 35.68], [139.76, 35.68], {
      baseUrl: "http://127.0.0.1:9", withRoadClass: false, prefectureSpans: false, ...opts,
    });
  } finally { globalThis.fetch = real; }
  return sent;
}

test("止まる場所だけを break にする", async () => {
  // ⚠️ **全部 through だと区間が1つになり、立ち寄り先に着いても知らせられない**
  //    （実測: 経由地1つで区間の終わりが1件 → stopAt を渡すと2件になった）
  const sent = await bodySent({ vias: [[139.72, 35.68], [139.74, 35.68]], stopAt: [1] });
  const types = sent.locations.slice(1, -1).map((l) => l.type);
  assert.deepStrictEqual(types, ["through", "break"],
    `経由地の種類が違う: ${JSON.stringify(types)}`);
});

test("おすすめ道路の終点は break_through（立ち寄るが引き返さない）", async () => {
  // ⚠️ **`break` だと、その場で向きを変えて来た道を戻る**（実機で報告）。
  //    立ち寄り先の印は残すこと（区間を分けないと「着きました」と言えない）
  const sent = await bodySent({ vias: [[139.72, 35.68], [139.74, 35.68]], stopAt: [0, 1], throughStopAt: [1] });
  const types = sent.locations.slice(1, -1).map((l) => l.type);
  assert.deepStrictEqual(types, ["break", "break_through"],
    `経由地の種類が違う: ${JSON.stringify(types)}`);
});

test("通り抜けを指しても、止まる場所でなければ効かない", async () => {
  // ⚠️ 通らせたいだけの中継点は through のまま。break_through にすると
  //    中継点ごとに「着きました」と言うことになる
  const sent = await bodySent({ vias: [[139.72, 35.68], [139.74, 35.68]], stopAt: [1], throughStopAt: [0, 1] });
  const types = sent.locations.slice(1, -1).map((l) => l.type);
  assert.deepStrictEqual(types, ["through", "break_through"],
    `経由地の種類が違う: ${JSON.stringify(types)}`);
});

test("種別の決め方（表）", () => {
  const opts = { stopAt: [1, 2], throughStopAt: [2, 3] };
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => locationType(i, opts)),
    ["through", "break", "break_through", "through"]);
  assert.strictEqual(locationType(0, {}), "through", "止まる場所を言わないのに止めている");
  assert.strictEqual(locationType(0, { stopAt: [0] }), "break");
});

test("通り抜けで引けなければ、諦めて引き直す", async () => {
  // ⚠️ **経路そのものを失わないため。** 本当に回れない行き止まりでは
  //    「引き返さない」を守れないことがある。そのときは引き返してよい
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("trace_attributes")) {
      return { ok: true, json: async () => ({ edges: [], admins: [] }) };
    }
    sent.push(JSON.parse(init.body));
    // 1回目は引けない。2回目（通り抜けを諦めた頼み）だけ返す
    return { ok: true, json: async () => (sent.length === 1
      ? { error_code: 442, error: "No path could be found" } : fakeTrip(2)) };
  };
  let route;
  try {
    route = await routeWithValhalla([139.70, 35.68], [139.76, 35.68], {
      baseUrl: "http://127.0.0.1:9", withRoadClass: false, prefectureSpans: false,
      vias: [[139.72, 35.68]], stopAt: [0], throughStopAt: [0],
    });
  } finally { globalThis.fetch = real; }
  assert.strictEqual(sent.length, 2, "引き直していない");
  assert.deepStrictEqual(sent[0].locations[1].type, "break_through", "材料が悪い: 1回目が通り抜けでない");
  assert.deepStrictEqual(sent[1].locations[1].type, "break", "引き直しでも通り抜けのまま");
  assert.ok(route && !route.error, "引き直した経路を返していない");
});

test("止まる場所を言わなければ全部 through", async () => {
  // ⚠️ 楽しい道の中継点は「通らせたいだけ」。break にすると中継点ごとに
  //    「着きました」と言うことになる
  const sent = await bodySent({ vias: [[139.72, 35.68], [139.74, 35.68]] });
  const types = sent.locations.slice(1, -1).map((l) => l.type);
  assert.deepStrictEqual(types, ["through", "through"],
    `既定が through になっていない: ${JSON.stringify(types)}`);
});
