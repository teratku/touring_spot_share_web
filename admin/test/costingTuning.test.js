"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { sanitizeTuning } = require("../lib/costingTuning");
const { costingOptionsFor, displacementSettings, DISPLACEMENTS, ROAD_CLASS_TIERS, HIGHWAY_LADDER,
        BASE } = require("../lib/valhallaRoute");

/**
 * 調整ツールの画面で、排気量ごとの数値を出して変えて試す（`tuning`）。
 *
 * ⚠️ 利用者の要望（2026-09-27）:「web でルート生成する時に各排気量で設定している数値も表示して
 *    変更できるようにして確認できるようにしたい」。
 * ⚠️ **変えた値はこの画面だけに効く。** 配信API（アプリ）の条件には入らないこと。
 * ⚠️ **画面の値で法令を緩められないこと**（125cc以下の高速は0のまま）。
 */

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

// MARK: 受け取る値

test("画面から来た値は範囲の中だけを通す", () => {
  assert.strictEqual(sanitizeTuning(null), null);
  assert.strictEqual(sanitizeTuning({}), null, "何も変えていないのに条件を変える");
  assert.strictEqual(sanitizeTuning({ foo: 1, variants: { normal: { use_tolls: 0 } } }), null,
    "知らない鍵を通した");
  assert.deepStrictEqual(sanitizeTuning({ topSpeed: 25.4 }), { topSpeed: 25 });
  assert.deepStrictEqual(sanitizeTuning({ topSpeed: null }), { topSpeed: null }, "「渡さない」を受け取れない");
  assert.strictEqual(sanitizeTuning({ topSpeed: 5 }), null, "Valhalla の範囲（10〜252）の外を通した");
  assert.strictEqual(sanitizeTuning({ topSpeed: "30" }), null);
  assert.deepStrictEqual(sanitizeTuning({ ferryWeight: 0.2 }), { ferryWeight: 0.2 });
  assert.strictEqual(sanitizeTuning({ ferryWeight: 1.5 }), null);
  assert.deepStrictEqual(
    sanitizeTuning({ variants: { normal: { use_primary: 0.7, use_highways: null, top_speed: 3 }, bogus: { use_primary: 1 },
                                 fun: { use_primary: 2 } } }),
    { variants: { normal: { use_primary: 0.7, use_highways: null } } }, "案ごとの重みの絞り方が違う");
  // 段は緩い方から試すので大きい順にそろえる
  assert.deepStrictEqual(sanitizeTuning({ highwayLadder: [0, 0.6, 0.2] }), { highwayLadder: [0.6, 0.2, 0] });
  assert.strictEqual(sanitizeTuning({ highwayLadder: [0.5, 2] }), null);
  assert.strictEqual(sanitizeTuning({ highwayLadder: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3] }), null,
    "段が多すぎる（1段ごとに1回引き直す）");
});

// MARK: 組み立て

test("変えていなければ、コードの表どおりの数値を渡す", () => {
  const o = (displacement, variant) => costingOptionsFor({ displacement, variant }).variantOptions;
  assert.strictEqual(o("moped50", "normal").use_primary, ROAD_CLASS_TIERS.moped50.normal.use_primary);
  assert.strictEqual(o("small125", "fun").use_primary, ROAD_CLASS_TIERS.small125.fun.use_primary);
  assert.strictEqual(o("moped50", "normal").top_speed, DISPLACEMENTS.moped50.topSpeed);
  assert.strictEqual(o("large", "fun").use_highways, 0, "大型の楽しい案で高速を外していない");
  assert.strictEqual(o("large", "normal").use_primary, undefined, "motorcycle に効かない重みを渡している");
});

test("画面で変えた値は、その案だけに重なる", () => {
  const tuning = { variants: { normal: { use_primary: 1 } } };
  const normal = costingOptionsFor({ displacement: "moped50", variant: "normal", tuning }).variantOptions;
  const fun = costingOptionsFor({ displacement: "moped50", variant: "fun", tuning }).variantOptions;
  assert.strictEqual(normal.use_primary, 1, "変えた値が効いていない");
  assert.strictEqual(fun.use_primary, ROAD_CLASS_TIERS.moped50.fun.use_primary, "別の案まで変えた");
  // 案の指定が無いときは「ふつう」
  assert.strictEqual(costingOptionsFor({ displacement: "moped50", tuning }).variantOptions.use_primary, 1);
  // null は「渡さない」
  const cleared = costingOptionsFor({ displacement: "moped50", variant: "normal",
                                      tuning: { variants: { normal: { use_primary: null } } } }).variantOptions;
  assert.ok(!("use_primary" in cleared), "空欄にしたのに渡している");
});

test("最高速度と船の重みを変えられる", () => {
  const none = costingOptionsFor({ displacement: "moped50", tuning: { topSpeed: null } }).variantOptions;
  assert.ok(!("top_speed" in none), "「渡さない」にしたのに最高速度を渡している");
  assert.strictEqual(costingOptionsFor({ displacement: "moped50", tuning: { topSpeed: 25 } }).variantOptions.top_speed, 25);
  // 大型にも試しに付けられる
  assert.strictEqual(costingOptionsFor({ displacement: "large", tuning: { topSpeed: 80 } }).variantOptions.top_speed, 80);
  // ⚠️ 船の重みは「フェリーに乗ってよい」ときだけ。避けるときは0のまま
  assert.strictEqual(costingOptionsFor({ displacement: "moped50", avoidFerries: false, tuning: { ferryWeight: 0.2 } })
    .variantOptions.use_ferry, 0.2);
  assert.strictEqual(costingOptionsFor({ displacement: "moped50", avoidFerries: false }).variantOptions.use_ferry,
    DISPLACEMENTS.moped50.ferryWeight);
  assert.strictEqual(costingOptionsFor({ displacement: "moped50", tuning: { ferryWeight: 0.9 } }).variantOptions.use_ferry, 0,
    "船を避けるのに乗せた");
});

test("画面の値で法令と回避の指定を緩められない", () => {
  // ⚠️ 125cc以下は高速に乗れない（法令）
  for (const d of ["moped50", "small125"]) {
    const o = costingOptionsFor({ displacement: d, tuning: { variants: { normal: { use_highways: 1 } } } }).variantOptions;
    assert.strictEqual(o.use_highways, 0, `${d}: 画面の値で高速に乗せた`);
  }
  // 「高速回避」「有料回避」のチェックも画面の数値より後に効く
  const o = costingOptionsFor({ displacement: "large", avoidHighways: true, avoidTolls: true,
                                tuning: { variants: { normal: { use_highways: 1 } } } }).variantOptions;
  assert.strictEqual(o.use_highways, 0, "高速回避を画面の数値で上書きした");
  assert.strictEqual(o.use_tolls, 0);
});

test("画面に出す一覧は、実際に組み立てた値", () => {
  const s = displacementSettings();
  assert.deepStrictEqual(Object.keys(s), Object.keys(DISPLACEMENTS));
  assert.strictEqual(s.moped50.costing, "motor_scooter");
  assert.strictEqual(s.moped50.topSpeed, 30);
  assert.strictEqual(s.moped50.ferryWeight, 0.35);
  assert.strictEqual(s.moped50.highwayLadder, null, "原付に高速を避ける段を出している");
  assert.strictEqual(s.large.topSpeed, null);
  assert.strictEqual(s.large.ferryWeight, 0.5, "書いていなければ Valhalla の既定（0.5）");
  assert.deepStrictEqual(s.large.highwayLadder, HIGHWAY_LADDER);
  for (const d of Object.keys(DISPLACEMENTS)) {
    for (const v of ["shortest", "normal", "fun"]) {
      assert.deepStrictEqual(s[d].variants[v], costingOptionsFor({ displacement: d, variant: v }).variantOptions,
        `${d}/${v}: 画面の値と実際に渡す値が違う`);
    }
  }
  // ⚠️ 表の写しを返していないこと（画面の側で書き換えても次の経路に効かない）
  s.moped50.variants.normal.use_primary = 9;
  assert.notStrictEqual(costingOptionsFor({ displacement: "moped50" }).variantOptions.use_primary, 9);
});

// MARK: 配信APIには入らない

test("配信API（アプリ）の条件には画面の値が入らない", () => {
  const { routeOptionsFromBody } = require("../../service/lib/buildRoute");
  const o = routeOptionsFromBody({ from: [139, 35], to: [139.1, 35.1], tuning: { topSpeed: 20 } });
  assert.strictEqual(o.tuning, undefined, "アプリから数値を変えられてしまう");
  assert.ok(!/tuning/.test(read("..", "service", "server.js")), "配信APIに数値を変える口ができている");
  assert.ok(!/tuning/.test(read("..", "service", "lib", "buildRoute.js")), "配信APIの条件づくりが数値を読んでいる");
});

// MARK: 窓口と画面の配線

test("窓口は画面の値を整えて重ね、既定の一覧を返す", () => {
  const server = read("server.js");
  assert.ok(server.includes("app.get(\"/api/valhalla/displacement-settings\""), "既定の一覧を返す窓口が無い");
  assert.ok(server.includes("res.json({ displacements: displacementSettings() });"));
  assert.ok(server.includes("{ ...opts, costing, excludePolygons, tuning: sanitizeTuning(req.body.tuning) });"),
    "ふつう・最短に画面の値を重ねていない");
  assert.ok(server.includes("          tuning: sanitizeTuning(req.body.tuning),"), "楽しい道に画面の値を重ねていない");
  assert.ok(server.includes("return routeWithValhallaSegmented(body.from, body.to, { ...opts, tuning });")
    && server.includes("const tuning = sanitizeTuning(req.body.tuning);"), "引き直しに画面の値を重ねていない");
  const lib = read("lib", "valhallaRoute.js");
  assert.ok(lib.includes("const { costing, bike, variantOptions, avoidFerries } = costingOptionsFor(opts);"),
    "経路を引くときと画面に出すときで組み立てが別になっている");
  assert.ok(lib.includes("for (const level of highwayLadder) {")
    && lib.includes("const highwayLadder = (opts.tuning && opts.tuning.highwayLadder) || HIGHWAY_LADDER;"),
    "高速を避ける段を画面で変えられない");
});

test("画面は変えた値だけを送り、引いた案で渡した値を出す", () => {
  const html = read("public", "valhalla.html");
  assert.ok(html.includes("await fetch(\"/api/valhalla/displacement-settings\")"), "既定をサーバから取っていない");
  assert.ok(html.includes("const tuning = tuningBody();\n  if (tuning) bike.tuning = tuning;"), "ふつう・楽しい道に送っていない");
  assert.ok(html.includes("...(tuning ? { tuning } : {}),"), "引き直しに送っていない");
  assert.ok(html.includes("document.getElementById(\"displacement\").addEventListener(\"change\", renderTuning);"),
    "排気量を変えても数値が入れ替わらない");
  assert.ok(html.includes("usedText(r.costingOptions)"), "引いた案で渡した値を出していない");
});

test("画面: 変えた値が効いた案にだけ印を付ける", () => {
  const html = read("public", "valhalla.html");
  const m = html.match(/function tuningTouches\(t, variant\) \{[\s\S]*?\n\}/);
  assert.ok(m, "印の付け方が見つからない");
  const touches = new Function(`${m[0]}; return tuningTouches;`)();
  const normalOnly = { variants: { normal: { use_primary: 1 } } };
  assert.strictEqual(touches(normalOnly, "normal"), true);
  assert.strictEqual(touches(normalOnly, "shortest"), false, "変えていない案にも印を付けた");
  assert.strictEqual(touches({ topSpeed: 20 }, "fun"), true, "全部の案に効く値なのに印が無い");
  assert.strictEqual(touches(null, "normal"), false);
  assert.ok(html.includes("tuningTouches(state.lastTuning, r.variant)"), "案の一覧で印の付け方を使っていない");
});

/** 画面の `tuningBody` を取り出して、入力欄を偽物で置き換えて動かす */
function pageTuning(settings, inputs) {
  const html = read("public", "valhalla.html");
  const grab = (re) => { const m = html.match(re); assert.ok(m, `画面から取り出せない: ${re}`); return m[0]; };
  const src = [
    grab(/const TUNE_VARIANTS = [^\n]+/),
    grab(/const TUNE_WEIGHTS = [^\n]+/),
    grab(/function tuneValue\(id\) \{[\s\S]*?\n\}/),
    grab(/function tuneLadder\(\) \{[\s\S]*?\n\}/),
    grab(/function tuningBody\(\) \{[\s\S]*?\n\}/),
  ].join("\n");
  const document = {
    getElementById: (id) => (id === "displacement" ? { value: "moped50" }
      : inputs[id] === undefined ? null : { value: String(inputs[id].value), disabled: !!inputs[id].disabled }),
  };
  const tune = { settings: { moped50: settings } };
  const tuneDefaults = () => tune.settings.moped50;
  return new Function("document", "tune", "tuneDefaults", `${src}; return tuningBody();`)(document, tune, tuneDefaults);
}

test("画面: 変えていなければ送らず、変えた欄だけを送る", () => {
  const settings = displacementSettings().moped50;
  const same = {
    "tune-topSpeed": { value: 30 }, "tune-ferryWeight": { value: 0.35 },
    "tune-shortest-use_primary": { value: 0.3 }, "tune-normal-use_primary": { value: 0.05 },
    "tune-fun-use_primary": { value: 0 },
    "tune-shortest-use_highways": { value: 0, disabled: true }, "tune-normal-use_highways": { value: 0, disabled: true },
    "tune-fun-use_highways": { value: 0, disabled: true },
  };
  assert.strictEqual(pageTuning(settings, same), undefined, "何も変えていないのに送る（アプリと違う条件になる）");
  assert.deepStrictEqual(pageTuning(settings, { ...same, "tune-normal-use_primary": { value: 1 } }),
    { variants: { normal: { use_primary: 1 } } }, "変えた欄だけを送っていない");
  assert.deepStrictEqual(pageTuning(settings, { ...same, "tune-topSpeed": { value: "" } }), { topSpeed: null },
    "空欄を「渡さない」として送っていない");
  // ⚠️ 法令で固定の欄（無効）は、値が違っても送らない
  assert.strictEqual(pageTuning(settings, { ...same, "tune-normal-use_highways": { value: 1, disabled: true } }), undefined);
  // 大型: 段を変えた
  const large = displacementSettings().large;
  const base = {
    "tune-topSpeed": { value: "" }, "tune-ferryWeight": { value: 0.5 },
    "tune-shortest-use_primary": { value: "" }, "tune-normal-use_primary": { value: "" }, "tune-fun-use_primary": { value: "" },
    "tune-shortest-use_highways": { value: "" }, "tune-normal-use_highways": { value: "" }, "tune-fun-use_highways": { value: 0 },
    "tune-ladder": { value: "0.5, 0.3, 0.15, 0" },
  };
  assert.strictEqual(pageTuning(large, base), undefined, "大型で何も変えていないのに送る");
  assert.deepStrictEqual(pageTuning(large, { ...base, "tune-ladder": { value: "0.7, 0.4, 0" } }), { highwayLadder: [0.7, 0.4, 0] });
});

// MARK: 実際の経路で

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}

test("実際の経路: 原付一種の幹線の使い方を上げると幹線を多く通り、渡した値に出る（Valhalla）", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  const { routeWithValhallaSegmented } = require("../lib/segmentedRoute");
  const { routeOptionsFromBody } = require("../../service/lib/buildRoute");
  const body = { from: [139.5656, 35.7897], to: [139.3160, 35.5290], displacement: "moped50", arriveOnNearSide: true };
  const opts = routeOptionsFromBody(body, { restrictionsFor: async () => ({ restrictions: [], prefectures: [] }) });
  const big = (r) => (r.classMeters.trunk || 0) + (r.classMeters.primary || 0);
  const plain = await routeWithValhallaSegmented(body.from, body.to, opts);
  const tuned = await routeWithValhallaSegmented(body.from, body.to,
    { ...opts, tuning: sanitizeTuning({ variants: { normal: { use_primary: 1 } } }) });
  assert.strictEqual(plain.costingOptions.use_primary, 0.05, "材料が悪い: 既定が変わった");
  assert.strictEqual(tuned.costingOptions.use_primary, 1, "渡した値に出ていない");
  assert.ok(big(tuned) > big(plain) + 5000, `幹線が増えていない: ${big(plain)}m → ${big(tuned)}m`);
});
