"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const P = require("../lib/roadPassability");
const { encode, decode } = require("../lib/polyline");

/**
 * おすすめ道路を排気量で走れるか（`lib/roadPassability.js`・アプリの `RoadPassability.swift` を移したもの）。
 *
 * ⚠️ 利用者の要望（2026-09-28）:「おすすめ道路を選択、選ばれたときはかならずユーザーの排気量によって
 *    走れるか否かを表示」「web もルート生成の追加を入れて欲しい」。
 *    アプリの `RoadPassabilityTests` と同じ材料・同じ答えにしてある（片方だけ直すとずれる）
 */

/** 北へまっすぐの線（点は [経度, 緯度]・約100m おき） */
const north = (lat0, lat1, lng = 139.0) => {
  const n = Math.max(2, Math.round(Math.abs(lat1 - lat0) * 1110));
  return Array.from({ length: n + 1 }, (_, k) => [lng, lat0 + ((lat1 - lat0) * k) / n]);
};
const rule = (id, line, extra = {}) => ({ id, kind: "noMotorcycle", name: id, polyline: encode(line), ...extra });
const ROAD = [north(35.0, 35.1)];
const evaluate = (rules, bike) => P.evaluate(ROAD, rules, bike);

test("道に沿った規制は排気量が当たるときだけ走れない", () => {
  const upTo125 = rule("125以下", north(35.02, 35.05), { maxCc: 125 });
  assert.deepStrictEqual(evaluate([upTo125], "small125"), { verdict: "blocked", reasons: ["二輪通行禁止"] });
  assert.strictEqual(evaluate([upTo125], "moped50").verdict, "blocked");
  assert.deepStrictEqual(evaluate([upTo125], "medium250"), { verdict: "ok", reasons: [] }, "当たらない排気量まで走れないと言った");
});

test("曜日や時期の指定がある規制は走れないときがある扱い（月も見る）", () => {
  const holiday = rule("日祝", north(35.02, 35.05), { activeDays: [7], includesHoliday: true });
  assert.deepStrictEqual(evaluate([holiday], "large"), { verdict: "conditional", reasons: ["日 祝 二輪通行禁止"] });
  const winter = rule("冬", north(35.06, 35.09), { kind: "winterClosure", activeMonths: [12, 1, 2, 3] });
  assert.deepStrictEqual(evaluate([winter], "large"), { verdict: "conditional", reasons: ["12・1・2・3月 冬季閉鎖"] });
  const night = rule("夜", north(35.02, 35.05), { activeHours: { from: "22:00", to: "05:00" } });
  assert.deepStrictEqual(evaluate([night], "large").reasons, ["22:00〜05:00 二輪通行禁止"]);
});

test("いつでも走れない規制があれば条件つきは理由に混ぜず、同じ理由は1つにまとめる（重なりの長い順）", () => {
  const a = rule("a", north(35.01, 35.03), { maxCc: 125 });
  const b = rule("b", north(35.05, 35.07), { maxCc: 125 });
  const holiday = rule("日祝", north(35.08, 35.095), { activeDays: [7], includesHoliday: true });
  assert.deepStrictEqual(evaluate([holiday, a, b], "small125"), { verdict: "blocked", reasons: ["二輪通行禁止"] });
  const closed = rule("c", north(35.06, 35.075), { kind: "closed" });
  assert.deepStrictEqual(evaluate([closed, a], "small125").reasons, ["二輪通行禁止", "通行止め"]);
});

test("走れなくならない規制と道から離れた規制では走れないと言わない", () => {
  const passenger = rule("二人乗り", north(35.02, 35.05), { kind: "noPassenger" });
  const parallel = rule("並ぶ道", north(35.02, 35.05, 139.0022));   // 東へ約200m
  const crossing = rule("横切る", [[138.99, 35.05], [139.01, 35.05]]);
  assert.deepStrictEqual(evaluate([passenger, parallel, crossing], "moped50"), { verdict: "ok", reasons: [] });
});

test("札の文言はアプリと同じ", () => {
  assert.strictEqual(P.label({ verdict: "blocked", reasons: ["二輪通行禁止", "通行止め"] }, "small125"),
    "125cc以下は走れません（二輪通行禁止・通行止め）");
  assert.strictEqual(P.label({ verdict: "conditional", reasons: ["日 祝 二輪通行禁止"] }, "large"),
    "251cc以上は走れないときがあります（日 祝 二輪通行禁止）");
  assert.strictEqual(P.label({ verdict: "ok", reasons: [] }, "medium250"), "250cc以下で走れます");
});

// MARK: 実データで（配信中のおすすめ道路と登録済みの規制）

const DATA = path.join(__dirname, "..", "data");
/**
 * 名前で道を拾う。⚠️ **ID で拾わないこと。** 配信データの ID は作り直すたびにずれる
 *    （実例: 芦ノ湖スカイラインが手元の作り直しで「神奈川県:24」→「:20」）。別の道を材料にして
 *    「走れない」と言わせてしまう。同じ名前が複数あれば `ok` に合うもの
 */
const segment = (pref, name, ok = () => true) => {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, "road-recommend", `${pref}.json`), "utf8"));
  const s = (d.segments || []).find((x) => x.name === name && ok(decode(x.polyline)));
  return s ? decode(s.polyline) : null;
};
const registered = (...prefs) => prefs.flatMap((p) =>
  JSON.parse(fs.readFileSync(path.join(DATA, "road-restrictions", `${p}.json`), "utf8")).restrictions || []);

test("実データ: 芦ノ湖スカイラインは125cc以下で走れず、250cc以下は走れる", (t) => {
  const road = segment("kanagawa", "芦ノ湖スカイライン");
  if (!road) return t.skip("材料が悪い（芦ノ湖スカイラインが無い。配信データの ID は作り直しでずれる）");
  const rules = registered("kanagawa", "shizuoka");
  assert.deepStrictEqual(P.evaluate([road], rules, "small125"), { verdict: "blocked", reasons: ["二輪通行禁止"] });
  assert.strictEqual(P.evaluate([road], rules, "medium250").verdict, "ok");
});

test("実データ: 奥比叡ドライブウェイは125cc以下は走れず、それより大きいと日祝に走れない", (t) => {
  const road = segment("shiga", "奥比叡ドライブウェイ");
  if (!road) return t.skip("材料が悪い（奥比叡ドライブウェイが無い）");
  const rules = registered("shiga", "kyoto");
  assert.deepStrictEqual(P.evaluate([road], rules, "moped50"), { verdict: "blocked", reasons: ["二輪通行禁止"] });
  assert.deepStrictEqual(P.evaluate([road], rules, "large"), { verdict: "conditional", reasons: ["日 祝 二輪通行禁止"] });
});

test("実データ: ターンパイクの入口（登録110m）に触れるだけの県道75号は走れる", (t) => {
  const rules = registered("kanagawa", "shizuoka");
  const entrance = rules.find((r) => r.id === "osm-kanagawa-130431711");
  assert.ok(entrance, "材料が悪い（入口の登録が無い）");
  const { overlapMeters } = require("../lib/appFunRoute");
  const road = segment("kanagawa", "湯河原箱根仙石原線", (pts) => overlapMeters(pts, decode(entrance.polyline)) > 0);
  if (!road) return t.skip("材料が悪い（入口に触れる湯河原箱根仙石原線が無い）");
  assert.deepStrictEqual(P.evaluate([road], rules, "small125"), { verdict: "ok", reasons: [] });
});

// MARK: 窓口と画面

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("窓口: 画面の規制の範囲で、道の形から県を決めて判定する", () => {
  const server = read("server.js");
  const at = server.indexOf('app.post("/api/valhalla/passability"');
  assert.ok(at > 0, "窓口が無い");
  const body = server.slice(at, server.indexOf("\n});", at));
  assert.ok(body.includes("const restrictionsFor = restrictionsForScope(restrictionScope, includeUnverified);"), "画面の規制の範囲で見ていない");
  assert.ok(body.includes("const { restrictions, prefectures } = restrictionsFor(points);"), "道の形から県を決めていない");
  assert.ok(body.includes("roadPassability.evaluate([points], restrictions, displacement)"), "アプリと同じ判定を使っていない");
  // ⚠️ 画面が道の形を送れるように、通した楽しい道に形を付けて返す
  assert.ok(server.includes("        polyline: s.polyline,\n      }));"), "通した楽しい道の形を返していない");
});

test("画面: 通した道と手で足した道に走れるかを出し、確かめられないときに走れますと言わない", () => {
  const html = read("public", "valhalla.html");
  assert.ok(html.includes("fillPassability(list, r.funRoads.map((f, i) => ({ key:String(i), polyline:f.polyline })),\n"
    + "                  (state.lastBike || {}).displacement, (state.lastBike || {}).restrictionScope);"), "通した道に出していない（引いたときの条件で）");
  assert.ok(html.includes("state.manualRoads.push({ name:s.name, polyline:s.polyline });"), "手で足した道を覚えていない");
  assert.ok(html.includes('document.getElementById("displacement").addEventListener("change", renderManualRoads);'),
    "排気量を変えても出し直さない");
  assert.ok(html.includes('el.textContent = x ? x.label : "走れるか確かめられませんでした";'), "確かめられないときの文言が無い");
});

// MARK: 並びの入れ替え・現在地

/** 画面の `swapTrip` をそのまま取り出して動かす */
function loadSwap() {
  const html = read("public", "valhalla.html");
  const at = html.indexOf("function swapTrip() {");
  assert.ok(at > 0, "入れ替えが無い");
  const src = html.slice(at, html.indexOf("\n}\n", at) + 2);
  let forgot = 0;
  const state = {};
  const swapTrip = new Function("state", "forgetResults", `${src}; return swapTrip;`)(state, () => { forgot++; });
  return { state, swapTrip, forgot: () => forgot };
}

test("入れ替えは並びをまるごと逆にし、立ち寄る印も現在地の印も一緒に動かす（アプリと同じ）", () => {
  const { state, swapTrip, forgot } = loadSwap();
  Object.assign(state, { from: [1, 1], to: [9, 9], fromHere: true, toHere: false,
                         vias: [[2, 2], [3, 3], [4, 4]], viaStops: [true, false] });   // ⚠️ 3点目は手で足した道（印が無い）
  swapTrip();
  assert.deepStrictEqual([state.from, state.to], [[9, 9], [1, 1]]);
  assert.deepStrictEqual([state.fromHere, state.toHere], [false, true], "現在地の印が端と一緒に動いていない");
  assert.deepStrictEqual(state.vias, [[4, 4], [3, 3], [2, 2]]);
  assert.deepStrictEqual(state.viaStops, [true, false, true], "立ち寄る印が経由地とずれた");
  assert.strictEqual(forgot(), 1, "前の経路が残って見える");
  swapTrip();
  assert.deepStrictEqual(state.vias, [[2, 2], [3, 3], [4, 4]], "二度入れ替えても元に戻らない");
});

test("現在地の端は引く前に取り直し、30秒より古い位置は使わない", () => {
  const html = read("public", "valhalla.html");
  const run = html.slice(html.indexOf("async function run() {"), html.indexOf("async function run() {") + 600);
  assert.ok(run.includes("if (state.fromHere || state.toHere) {\n    try { await refreshHere(); }"), "引く前に取り直していない");
  assert.ok(html.includes("{ enableHighAccuracy:true, timeout:10_000, maximumAge:30_000 }"), "古い位置を使う");
  assert.ok(html.includes("if (!state.from) { state.from = p; state.fromHere = false; }"), "地図で置き直しても現在地の印が残る");
});
