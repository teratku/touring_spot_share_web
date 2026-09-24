"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildRouteResponse } = require("../lib/buildRoute");
const { isSellable } = require("../../admin/lib/restrictionOrigin");
const { decode } = require("../../admin/lib/polyline");

/**
 * 配信APIの応答。
 *
 * ⚠️ **実際に叩くには Firebase の ID トークンが要り、手元では作れない**
 *    （サービスアカウント鍵が無いと custom token に署名できない）。
 *    通信の入口（認証）は手で確かめ、中身はここで確かめる。
 */
const BASE = process.env.VALHALLA_URL || "http://127.0.0.1:8002";
async function skipIfDown(t) {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return false;
  } catch (e) { /* 落ちている */ }
  t.skip(`Valhalla が居ない（${BASE}）`);
  return true;
}

const TOKYO = [139.7671, 35.6812];
const HAKONE = [139.1069, 35.2324];
// ⚠️ 雁坂トンネル（有料6.8km）を通らないと着けない。有料回避の検査に使う
const OTAKI  = [138.93776, 35.94965];
const HIROSE = [138.76376, 35.83867];

test("両端が無ければ断る", async () => {
  for (const body of [{}, { from: TOKYO }, { from: TOKYO, to: [1] }, { from: "x", to: HAKONE }]) {
    const out = await buildRouteResponse(body, {});
    assert.strictEqual(out.status, 400, `${JSON.stringify(body)} を通している`);
  }
});

test("出典を必ず入れる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **義務。** OSM は ODbL で表示が要り、JARTIC は規約が出典と加工の明記を求めている。
  //    ⚠️ 配信物のファイルには入っていなかった（Firestore へ上げるときだけ付いていた）
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const text = (out.body.attribution || []).join("\n");
  assert.ok(/OpenStreetMap contributors/.test(text), "OSM の表示が無い");
  assert.ok(/ODbL/.test(text), "ODbL の記載が無い");
  assert.ok(/日本道路交通情報センター/.test(text), "JARTIC の出典が無い");
  assert.ok(/加工/.test(text), "加工した旨が無い");
});

test("アプリが読む形で返す", async (t) => {
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, displacement: "large" }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const r = out.body.route;
  for (const key of ["totalDistanceMeters", "totalDurationSeconds", "polyline", "steps"]) {
    assert.ok(r[key] != null, `${key} が無い`);
  }
  const step = r.steps[0];
  for (const key of ["maneuver", "instruction", "roadName", "spokenRoad", "distanceMeters"]) {
    assert.ok(key in step, `steps に ${key} が無い`);
  }
  assert.ok(Array.isArray(out.body.guidance) && out.body.guidance.length > 0, "案内が付いてこない");
});

test("高速の方面と、出口を見分ける番号をアプリへ返す", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **詰め直しで落としていた。** `admin/lib` の指示には載っているのに、
  //    ここで項目を選び直すときに入れ忘れ、アプリに届いていなかった。
  //    用賀 → 厚木（東名・海老名JCT）。高速を通るよう大型で引く
  const out = await buildRouteResponse(
    { from: [139.6335, 35.6262], to: [139.3640, 35.4420], displacement: "large",
      guidance: false },
    { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const steps = out.body.route.steps;
  for (const s of steps) {
    assert.ok(Array.isArray(s.towardNames), `方面の欄が無い: ${s.instruction}`);
    assert.strictEqual(typeof s.valhallaType, "number", `種類番号が無い: ${s.instruction}`);
  }
  const named = steps.filter((s) => s.towardNames.length > 0);
  assert.ok(named.length > 0, "方面がひとつも届いていない");
  assert.ok(steps.some((s) => s.roadKind === "expressway"), "材料が悪い: 高速を通っていない");
  // 出口（20/21）はアプリでは ramp-* として届く。番号が無いと入口と見分けられない
  const exits = steps.filter((s) => s.valhallaType === 20 || s.valhallaType === 21);
  assert.ok(exits.length > 0, "材料が悪い: 出口を通っていない");
  for (const e of exits) assert.match(e.maneuver, /^ramp/, `出口の値が変わった: ${e.maneuver}`);
});

test("区間ごとに条件が違うルートも Valhalla で引く", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **ナビは Valhalla 一択**（利用者の判断）。区間ごとの有料・下道も自前で引く。
  //    新座 → 箱根。前半は高速あり、高速の上（厚木の手前）で切り替えて後半は下道のみ。
  // ⚠️ **全体の条件は「両方避ける」にしておく**（アプリは一番厳しい組み合わせを送る）。
  //    区間ごとの条件を無視して全体の条件で引くと、前半でも高速を使わないので、
  //    「前半で高速を使った」ことが区間ごとに引いた証拠になる
  const switchPoint = [139.467012, 35.486613];
  const out = await buildRouteResponse({
    from: [139.5693, 35.7936], to: HAKONE, vias: [switchPoint], displacement: "large",
    guidance: false, avoidTolls: true, avoidHighways: true,
    legConditions: [{ avoidTolls: false, avoidHighways: false }, { avoidTolls: true, avoidHighways: true }],
  }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const r = out.body.route;
  const pts = decode(r.polyline);
  const k = pts.findIndex(([lng, lat]) =>
    Math.hypot((lng - switchPoint[0]) * 91000, (lat - switchPoint[1]) * 111000) < 30);
  assert.ok(k > 0, "材料が悪い: 切り替え地点を通っていない");
  assert.ok(r.kindSpans.some((s) => s.end <= k && s.kind === "expressway"),
    "高速ありの区間で高速を使っていない（区間ごとの条件が効いていない）");
  // 切り替え地点は立ち寄り先ではない
  assert.strictEqual(r.steps.filter((s) => s.isLegEnd).length, 1, "切り替え地点が立ち寄り先になっている");
  // 後半は、いったん下道に降りたら高速に戻らない
  const after = r.kindSpans.filter((s) => s.begin >= k);
  const down = after.findIndex((s) => s.kind === "surface" && s.meters > 500);
  assert.ok(down >= 0, "後半で下道に降りていない");
  assert.deepStrictEqual(after.slice(down).filter((s) => s.kind === "expressway"), [],
    "下道のみの区間で、また高速に乗った");
});

test("区間ごとの条件が崩れていたら使わず、全体の条件で引く", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 崩れた値で区間ごとに引くと、避けたい区間で有料・高速に乗せる
  for (const legConditions of [
    [{ avoidTolls: "yes", avoidHighways: false }, { avoidTolls: false, avoidHighways: false }],
    [null, { avoidTolls: false, avoidHighways: false }],
    "下道",
  ]) {
    const out = await buildRouteResponse({
      from: [139.5693, 35.7936], to: HAKONE, vias: [[139.114793, 35.235292]], displacement: "large",
      guidance: false, avoidTolls: true, avoidHighways: true, legConditions,
    }, { baseUrl: BASE });
    assert.strictEqual(out.status, 200, out.body.error);
    assert.strictEqual(out.body.route.kindMeters.expressway, 0,
      `崩れた条件 ${JSON.stringify(legConditions)} で高速に乗った（全体の条件を使っていない）`);
  }
});

/**
 * `buildRouteResponse` が経路の関数へ渡した中身を覗く。
 * ⚠️ **読み込み時に関数を取り込んでいる**ので、差し替えたら読み直すこと
 */
async function optsSent(body) {
  const seg = require("../../admin/lib/segmentedRoute");
  const original = seg.routeWithValhallaSegmented;
  let sent = null;
  delete require.cache[require.resolve("../lib/buildRoute")];
  seg.routeWithValhallaSegmented = async (from, to, opts) => { sent = opts; return { error: "見るだけ" }; };
  try {
    const fresh = require("../lib/buildRoute");
    await fresh.buildRouteResponse(body, { baseUrl: BASE });
  } finally {
    seg.routeWithValhallaSegmented = original;
    delete require.cache[require.resolve("../lib/buildRoute")];
  }
  return sent;
}

test("おすすめ道路の終点を、立ち寄るが引き返さない扱いで渡す", async () => {
  // ⚠️ **窓口で落とすと、実機のUターンが直らない。** 渡した番号がそのまま届くこと
  const sent = await optsSent({ from: TOKYO, to: HAKONE, vias: [[139.4, 35.4]], stopAt: [0],
    throughStopAt: [0], displacement: "large" });
  assert.deepStrictEqual(sent.throughStopAt, [0], "通り抜けの番号を渡していない");
  assert.deepStrictEqual(sent.stopAt, [0], "立ち寄り先の番号を渡していない");
});

test("崩れた通り抜けの番号は捨てる", async () => {
  // ⚠️ 崩れた番号で引くと、別の立ち寄り先が通り抜けになる
  for (const throughStopAt of ["0", { 0: true }, undefined]) {
    const sent = await optsSent({ from: TOKYO, to: HAKONE, vias: [[139.4, 35.4]], stopAt: [0],
      throughStopAt, displacement: "large" });
    assert.deepStrictEqual(sent.throughStopAt, [], `${JSON.stringify(throughStopAt)} を通している`);
  }
  const mixed = await optsSent({ from: TOKYO, to: HAKONE, vias: [[139.4, 35.4]], stopAt: [0],
    throughStopAt: [0, "1", 2.5, null], displacement: "large" });
  assert.deepStrictEqual(mixed.throughStopAt, [0], "数でない番号を通している");
});

test("信号のある交差点かをアプリへ渡す", async (t) => {
  // ⚠️ **窓口で落とすと、案内が「この交差点で」にならない。**
  //    Valhalla は信号を持っていないので、ここが唯一の伝え口
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse(
    { from: [139.5693, 35.7936], to: [139.4683, 35.7996], displacement: "large", guidance: false },
    { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const steps = out.body.route.steps;
  assert.ok(steps.every((s) => typeof s.atSignal === "boolean"), "印が付いていない指示がある");
  assert.ok(steps.some((s) => s.atSignal), "信号のある交差点を1つも渡していない");
  // ⚠️ **全部に印を付けないこと。** 信号の無い交差点は今までどおりの言い方
  assert.ok(steps.some((s) => !s.atSignal), "全部の指示を信号ありにしている");
});

test("道の種別ごとの距離を返す", async (t) => {
  // ⚠️ **アプリが読む先が無かった。** `ValhallaRouteService.hasTolls` は
  //    `kindMeters` を読むが応答に入っておらず、常に false に落ちていた
  //    （自前エンジンで「有料」の札が一度も出ない）。
  // ⚠️ 高速・有料・下道を**分けたまま**返すこと。足して1つにしない
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, displacement: "large" }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const km = out.body.route.kindMeters;
  assert.ok(km, "kindMeters が無い");
  for (const key of ["expressway", "toll", "surface"]) {
    assert.ok(typeof km[key] === "number", `kindMeters に ${key} が無い`);
  }
  const sum = km.expressway + km.toll + km.surface;
  assert.ok(Math.abs(sum - out.body.route.totalDistanceMeters) < 1000,
    `内訳の合計(${sum})が総距離(${out.body.route.totalDistanceMeters})と合わない`);
});

test("避けきれなかった有料の距離をアプリへ返す", async (t) => {
  // ⚠️ **実機で報告された形。**「有料を避ける」にしたのに雁坂トンネルを通り、
  //    画面は何も言わなかった。`use_tolls: 0` は**重みであって禁止ではない**ので、
  //    代替路が無ければ通る。**通ったことを黙らせない。**
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse(
    { from: OTAKI, to: HIROSE, displacement: "small125", avoidTolls: true },
    { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const m = out.body.route.tollUnavoidableMeters;
  assert.ok(typeof m === "number", "避けきれなかった有料の距離を返していない");
  // 材料の確認: この区間は実際に避けられないこと
  assert.ok(m > 5_000 && m < 9_000, `雁坂トンネルは約6.8kmのはず: ${m}m`);
});

test("遠回りしてでも有料を避けられる", async (t) => {
  // ⚠️ 実測（道の駅大滝温泉→広瀬ダム）: 約30km → 143.6km。
  //    **既定にしてはいけない。** 遠回りを承知の利用者が選んだときだけ通す
  if (await skipIfDown(t)) return;
  const [ふつう, 塞ぐ] = await Promise.all([
    buildRouteResponse({ from: OTAKI, to: HIROSE, displacement: "small125",
                         avoidTolls: true }, { baseUrl: BASE }),
    buildRouteResponse({ from: OTAKI, to: HIROSE, displacement: "small125",
                         avoidTolls: true, excludeTolls: true }, { baseUrl: BASE }),
  ]);
  assert.strictEqual(塞ぐ.status, 200, 塞ぐ.body.error);
  assert.ok(ふつう.body.route.tollUnavoidableMeters > 0,
    "前提: 塞がなければ有料を通るはずの区間で試すこと");
  assert.strictEqual(塞ぐ.body.route.tollUnavoidableMeters, 0,
    `塞いだのに有料が ${塞ぐ.body.route.tollUnavoidableMeters}m 残っている`);
  assert.ok(塞ぐ.body.route.totalDistanceMeters > ふつう.body.route.totalDistanceMeters * 2,
    "遠回りになっていない");
});

// MARK: フェリーを避ける（アプリの「避ける」に並ぶボタン）

const YOKOSUKA = [139.672, 35.2814];   // 久里浜の近く（東京湾フェリー）
const TATEYAMA = [139.87, 34.997];
const NIIZA = [139.57396996069144, 35.79681016815063];
const MARUGAME = [133.90515, 34.23266667000001];
const KIRISHIMA = [130.85135, 31.863625];

test("フェリーは既定で避け、避けないと言えば乗る（横須賀→館山）", async (t) => {
  // ⚠️ **既定は避ける。** 古いアプリは avoidFerries を渡してこない。
  //    渡されなければこれまでどおり避けること
  if (await skipIfDown(t)) return;
  const [既定, 乗る] = await Promise.all([
    buildRouteResponse({ from: YOKOSUKA, to: TATEYAMA, displacement: "large" }, { baseUrl: BASE }),
    buildRouteResponse({ from: YOKOSUKA, to: TATEYAMA, displacement: "large", avoidFerries: false },
                       { baseUrl: BASE }),
  ]);
  assert.strictEqual(既定.status, 200, 既定.body.error);
  assert.strictEqual(乗る.status, 200, 乗る.body.error);
  assert.strictEqual(既定.body.route.ferryMeters, 0, "渡さなかったのに船に乗っている");
  assert.ok(乗る.body.route.ferryMeters > 5_000, "避けないと言ったのに東京湾フェリーに乗らない");
  assert.ok(乗る.body.route.totalDistanceMeters < 60_000,
    `船に乗れば 47km のはず: ${乗る.body.route.totalDistanceMeters}m`);
});

test("原付でフェリーを避けないときも、長距離フェリーを乗り継がない（新座→丸亀）", async (t) => {
  // ⚠️ 原付は幹線を避ける重みで陸の費用が膨らみ、use_ferry 0.5 のままだと
  //    東京九州フェリーで新門司へ行き、阪九フェリーで神戸へ戻った（船1,539km・43.8時間。
  //    `FERRY_WEIGHT_WHEN_ALLOWED` の説明を読むこと）
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse({ from: NIIZA, to: MARUGAME, displacement: "moped50",
                                         avoidHighways: true, avoidFerries: false }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  assert.ok(out.body.route.ferryMeters > 0, "材料が悪い: 避けないのに船に乗らない");
  assert.ok(out.body.route.ferryMeters < 200_000,
    `船に ${(out.body.route.ferryMeters / 1000).toFixed(0)}km 乗っている（長距離フェリーを乗り継いでいる）`);
});

test("原付でフェリーを避けるなら、遠回りでもしまなみを渡る（新座→丸亀）", async (t) => {
  // ⚠️ 実機で報告（2026-09-23）: 3候補とも宇野－直島－高松の船に乗った。
  //    陸路（しまなみ）は Valhalla の費用では船より高く、費用で比べて弾いていた
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse({ from: NIIZA, to: MARUGAME, displacement: "moped50",
                                         avoidHighways: true, alternates: 2 }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  assert.strictEqual(out.body.route.ferryMeters, 0,
    `船に ${out.body.route.ferryMeters}m 乗っている`);
});

test("フェリーを避けるなら、船に乗る別の道も返さない（新座→霧島市）", async (t) => {
  // ⚠️ 実機で報告（2026-09-23）: 本命は船0kmなのに、代替が船 88.7km を通り、
  //    アプリが「いちばん速くて短い」として先頭に出した
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse({ from: NIIZA, to: KIRISHIMA, displacement: "moped50",
                                         avoidHighways: true, alternates: 2 }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  assert.strictEqual(out.body.route.ferryMeters, 0, "材料が悪い: 本命が船に乗っている");
  assert.ok(out.body.alternates.length > 0, "材料が悪い: 別の道が返らない");
  for (const a of out.body.alternates) {
    assert.strictEqual(a.ferryMeters, 0, `別の道が船に ${a.ferryMeters}m 乗っている`);
  }
});

test("案内は要らないと言えば付けない", async (t) => {
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false }, { baseUrl: BASE });
  assert.strictEqual(out.body.guidance, undefined);
});

test("線は5桁で返す（10倍ずれない）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ Valhalla は6桁。そのまま渡すと座標が10倍ずれる（過去に踏んだ）
  const { decode } = require("../../admin/lib/polyline");
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false }, { baseUrl: BASE });
  const points = decode(out.body.route.polyline);
  const first = points[0];
  assert.ok(Math.abs(first[0] - TOKYO[0]) < 0.05 && Math.abs(first[1] - TOKYO[1]) < 0.05,
    `始点が ${JSON.stringify(first)}（渡したのは ${JSON.stringify(TOKYO)}）`);
});

test("規制を読んだ県を返す", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 見落としが起きていないか、呼ぶ側が確かめられるように
  const seen = [];
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false },
    { baseUrl: BASE,
      restrictionsFor: (points) => {
        seen.push(points.length);
        return { restrictions: [], prefectures: ["東京都", "神奈川県"] };
      } });
  assert.deepStrictEqual(out.body.route.restrictionPrefectures, ["東京都", "神奈川県"]);
  assert.ok(seen[0] > 100, "経路の点が渡っていない");
});

test("避けきれなかった規制を隠さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **黙って通させない。** 塞ぎきれなかったことは呼ぶ側に伝える
  const out = await buildRouteResponse(
    { from: TOKYO, to: HAKONE, guidance: false }, { baseUrl: BASE });
  const r = out.body.route;
  assert.ok(Array.isArray(r.restrictionHits), "残った規制の欄が無い");
  assert.ok(Array.isArray(r.restrictionSkipped), "渡せなかった規制の欄が無い");
  assert.ok(Number.isFinite(r.restrictionTries), "引き直した回数が無い");
});

test("売ってよい出どころだけを通す", () => {
  // ⚠️ **二普協由来と、記録の無いものは載せない**（`admin/lib/restrictionOrigin.js`）
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(server.includes(".filter(isSellable)"),
    "配信側で出どころを絞っていない");
  assert.strictEqual(isSellable({ origin: "jmpsa" }), false);
  assert.strictEqual(isSellable({ origin: null }), false);
});

test("管理の窓口を載せていない", () => {
  // ⚠️ 規制の編集・取り込み・道路データの生成は admin の仕事。外に出さない
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = [...server.matchAll(/app\.(get|post|put|delete)\("([^"]+)"/g)].map((m) => m[2]);
  // ⚠️ `/v1/snap` はアプリの「なぞる」が使う（道路に載せるだけ。管理の窓口ではない）
  assert.deepStrictEqual(routes.sort(), ["/health", "/v1/route", "/v1/snap"],
    `余計な窓口が載っている: ${routes.join(", ")}`);
});

test("認証を外していない", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/app\.post\("\/v1\/route", requireAuth/.test(server),
    "ルート生成に認証が掛かっていない");
  assert.ok(/verifyIdToken/.test(server), "トークンを確かめていない");
});

test("外から繋がる待ち方をしている", () => {
  // ⚠️ Cloud Run は 0.0.0.0 で待つこと。127.0.0.1 だと外から繋がらない
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/const HOST = "0\.0\.0\.0"/.test(server), "0.0.0.0 で待っていない");
});

test("立ち寄り先があっても、アプリが指示を1つも捨てない", async (t) => {
  // ⚠️ **アプリは範囲外の指示を黙って捨てる。**
  //    `ValhallaRouteService.parseStep` は
  //    `begin >= 0, end < full.count, begin <= end` を満たさないと nil を返し、
  //    エラーも警告も出ない。区間の先頭の点は前の区間の終点と同じで足されないのに、
  //    足す前の長さを番号の起点にしていたため2区間目以降が丸ごと1つずれ、
  //    **最後の2指示が消えていた**（実測: 点1868に対し最大の番号1868。
  //    消えた中に1,618mの走る指示があり、最後の1.6kmが無案内だった）
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse({
    from: TOKYO, vias: [[139.4, 35.45]], to: HAKONE, stopAt: [0], guidance: false,
  }, {});
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const n = decode(out.body.route.polyline).length;
  const steps = out.body.route.steps;
  assert.ok(steps.length > 2, "指示が少なすぎる（材料が悪い）");
  const dropped = steps.filter((s) =>
    !(s.beginIndex >= 0 && s.endIndex < n && s.beginIndex <= s.endIndex));
  assert.deepStrictEqual(dropped.map((s) => s.instruction), [],
    `アプリが捨てる指示がある（線は${n}点）`);
  assert.strictEqual(steps[steps.length - 1].endIndex, n - 1,
    "最後の指示が線の終わりに届いていない");
});

test("止まる場所を言えば、区間の切れ目が2つになる", async (t) => {
  // ⚠️ **`stopAt` が空だと経由地は「通るだけ」になり、着いても知らせられない**
  //    （実機で報告: 立ち寄り先を設定したのに通過しても何も起きなかった）
  if (await skipIfDown(t)) return;
  const body = { from: TOKYO, vias: [[139.4, 35.45]], to: HAKONE, guidance: false };
  const stop = await buildRouteResponse({ ...body, stopAt: [0] }, {});
  const through = await buildRouteResponse(body, {});
  const ends = (o) => o.body.route.steps.filter((s) => s.isLegEnd).length;
  assert.strictEqual(ends(stop), 2, "立ち寄り先が区間の終わりになっていない");
  assert.strictEqual(ends(through), 1, "通るだけの経由地まで区間の終わりにしている");
});

test("到着の指示は距離0で、その手前が走る指示", async (t) => {
  // ⚠️ **アプリの言い換えがこの形に乗っている。**
  //    到着は距離0の独立した指示なので、走っている最中の現在ステップは
  //    `isLegEnd` ではない。現在ステップだけを見ていたため、実機で
  //    「300メートル先、直進です」のままだった（`NavigationEngine.arrivalStepAhead`）
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse({
    from: TOKYO, vias: [[139.4, 35.45]], to: HAKONE, stopAt: [0], guidance: false,
  }, {});
  const steps = out.body.route.steps;
  const ends = steps.map((s, i) => [i, s]).filter(([, s]) => s.isLegEnd);
  assert.strictEqual(ends.length, 2, "区間の切れ目が2つでない（材料が悪い）");
  for (const [i, s] of ends) {
    assert.strictEqual(s.distanceMeters, 0, `指示${i} の到着に距離が付いている`);
    assert.ok(i > 0, "到着の手前に走る指示が無い");
    assert.ok(steps[i - 1].distanceMeters > 0,
      `指示${i} の手前が走る指示になっていない`);
    assert.strictEqual(steps[i - 1].isLegEnd, false,
      `指示${i - 1}（走る指示）にまで区間の終わりの印が付いている`);
  }
});

test("走っている向きを渡すと、その場で向きを変えさせない", async (t) => {
  // ⚠️ **これが引き直しの肝。** 渡さないと「いま来た道を逆向きに」と言われる。
  //    渡すと、そのまま進んで小道で回り込む形（コの字）になる。
  //    実測（新座・南1.3kmへ戻る）: 渡さない 1.80km「南西方向です」／
  //    北向きを渡す 2.48km「北東方向です → 左 → 左」
  if (await skipIfDown(t)) return;
  const from = [139.5666, 35.7867];
  const to = [139.5600, 35.7750];        // 南（＝走ってきた方向）
  const plain = await buildRouteResponse({ from, to, guidance: false }, {});
  const facing = await buildRouteResponse({ from, to, guidance: false, heading: 0 }, {});

  assert.strictEqual(plain.status, 200, JSON.stringify(plain.body));
  assert.strictEqual(facing.status, 200, JSON.stringify(facing.body));

  const first = (o) => o.body.route.steps[0].instruction;
  assert.ok(/南/.test(first(plain)),
    `渡さないときに南へ向かっていない（材料が変わった）: ${first(plain)}`);
  assert.ok(/北/.test(first(facing)),
    `向きを渡したのに、いきなり逆を向かせている: ${first(facing)}`);
  // 遠回りになるのは織り込み済み。ただし極端に伸びないこと
  const ratio = facing.body.route.totalDistanceMeters / plain.body.route.totalDistanceMeters;
  assert.ok(ratio < 3, `遠回りが大きすぎる（${ratio.toFixed(2)}倍）`);
});

test("許容角から外れる向きは効かない（渡す側が知っておくこと）", async (t) => {
  // ⚠️ **道の向きから45度以上ずれた値を渡すと、逆向きの経路が返る。**
  //    実測（水道道路・北東に伸びる道）: heading=0/10/45/60 は北東へ、
  //    heading=350 は「南西方向です」に戻った。
  //    走っている向きをそのまま渡すぶんには問題ないが、
  //    当て推量の値を渡すと**かえってUターンさせる**ことになる
  if (await skipIfDown(t)) return;
  const from = [139.5666, 35.7867];
  const to = [139.5600, 35.7750];
  const first = (o) => o.body.route.steps[0].instruction;

  const facing = await buildRouteResponse({ from, to, guidance: false, heading: 10 }, {});
  assert.ok(/北/.test(first(facing)), `向きが効いていない: ${first(facing)}`);

  const off = await buildRouteResponse({ from, to, guidance: false, heading: 350 }, {});
  assert.strictEqual(off.status, 200, "許容角から外れた値で失敗している（断らずに返すこと）");
});

test("経由地に進入方向を渡すと、行って戻らず回り込む", async (t) => {
  // ⚠️ **利用者が選んだ道は端まで走らせる。** 端まで行って戻るのが嫌だからと
  //    入口を落とすと、選んだ道を走らないことになる（実機の要望:
  //    「今回はユーザーがわざわざ選択したものなため」）。
  //    入口に「道に沿った向き」を渡すと、その向きで入れる道筋＝回り込みを探す。
  //    実測（新座→大野東松山線→赤城大沼）: 指定なし 往復11.1km → 指定あり 6.1km
  if (await skipIfDown(t)) return;
  const from = [139.5666, 35.7867], to = [139.1930, 36.5540];
  const via = [139.2000, 36.0300];
  const plain = await buildRouteResponse({ from, to, vias: [via], stopAt: [0], guidance: false }, {});
  const facing = await buildRouteResponse({ from, to, vias: [via], stopAt: [0],
                                            viaHeadings: [90], guidance: false }, {});
  assert.strictEqual(plain.status, 200, JSON.stringify(plain.body));
  assert.strictEqual(facing.status, 200, JSON.stringify(facing.body));
  // ⚠️ **経路が変わったことを確かめる。** 渡しても効いていなければ意味が無い
  assert.notStrictEqual(facing.body.route.polyline, plain.body.route.polyline,
    "進入方向を渡したのに経路が変わっていない");
});

test("経由地の進入方向は、間引いても番号がずれない", async (t) => {
  // ⚠️ **重なった経由地は間引かれる。** 向きを別の配列で持つと、
  //    間引いたぶんだけ番号がずれて**別の経由地の向き**が付く
  if (await skipIfDown(t)) return;
  const from = [139.5666, 35.7867], to = [139.1930, 36.5540];
  const via = [139.2000, 36.0300];
  // 同じ点を2つ並べる（2つ目は間引かれる）。3つ目に向きを付ける
  const out = await buildRouteResponse({
    from, to, vias: [via, via, [139.2930, 36.0100]],
    viaHeadings: [undefined, undefined, 90], guidance: false,
  }, {});
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
});

test("経由地をずらした先を、元の座標と組にしてアプリへ渡す（ツーリング3・125cc）", async (t) => {
  // ⚠️ 実機で報告（2026-09-24）:「一箇所だけマーカーが離れてしまっている」。Uターン路をほどくために
  //    国道286号の終点を道に沿って手前へずらしたので、元の位置のマーカーが線から419m離れて見えた。
  //    アプリはこれで地図のマーカーを実際に通る位置に描く（利用者の判断）
  if (await skipIfDown(t)) return;
  const F = require("../../admin/test/fixtures-via-loops.json")["ツーリング3"];
  const { distance } = require("../../admin/lib/routeLoops");
  const out = await buildRouteResponse({
    from: F["出発"], to: F["行き先"], vias: F["経由地"], stopAt: F["立ち寄り先の番号"],
    throughStopAt: F["通り抜けの番号"], displacement: "small125",
    avoidTolls: true, avoidHighways: true, avoidFerries: true, guidance: false,
  }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const moved = out.body.route.movedVias;
  assert.ok(Array.isArray(moved), "ずらした経由地を渡していない");
  // ⚠️ **元の座標は届いたままの値で返す**（アプリは座標で突き合わせる。番号はずれる）
  const sent = F["経由地"].map((p) => JSON.stringify(p));
  for (const m of moved) {
    assert.ok(sent.includes(JSON.stringify(m.from)), `元の座標が届いた経由地のどれとも一致しない: ${m.from}`);
    assert.ok(m.meters > 0, "ずらしていないもの（向きを付けただけ）まで入れている");
    assert.ok(Math.abs(distance(m.from, m.to) - m.meters) <= 2, `距離が合わない: ${m.meters}m`);
  }
  // 国道286号の終点（9番）は道に沿って手前へ、国道347号の最初の通る点（10番）は先へずらしている
  const end286 = moved.find((m) => JSON.stringify(m.from) === JSON.stringify(F["経由地"][9]));
  assert.ok(end286, "国道286号の終点をずらした先を渡していない");
  assert.ok(end286.meters > 300 && end286.meters <= 1000, `終点のずらし幅: ${end286.meters}m`);
  const line = decode(out.body.route.polyline);
  const near = (p) => line.reduce((best, q) => Math.min(best, distance(q, p)), Infinity);
  assert.ok(near(end286.to) <= 30, `ずらした先が線の上に無い（${Math.round(near(end286.to))}m）`);
  assert.ok(near(end286.from) > 300, "材料が悪い: 元の終点が線から離れていない");
  assert.ok(moved.some((m) => JSON.stringify(m.from) === JSON.stringify(F["経由地"][10])),
            "国道347号の最初の通る点をずらした先を渡していない");
  // 向きを付けただけの国道347号の終点（19番）は入れない
  assert.ok(!moved.some((m) => JSON.stringify(m.from) === JSON.stringify(F["経由地"][19])),
            "ずらしていない経由地を入れている");
});

test("経由地のまわりの輪（Uターン路）を通らない経路をアプリへ返す（ツーリング3・125cc）", async (t) => {
  // ⚠️ 実機で報告（2026-09-23）:「250cc以上だとUターン路は生成されないが125cc以下で
  //    ルートのUターン路が生成されてしまう」。下の3点は輪の先で、ほどかない経路なら
  //    真上を通る（`admin/lib/viaLoops.js`）
  if (await skipIfDown(t)) return;
  const { routeWithValhalla } = require("../../admin/lib/valhallaRoute");
  const { distance } = require("../../admin/lib/routeLoops");
  const F = require("../../admin/test/fixtures-via-loops.json")["ツーリング3"];
  const 輪の先 = {
    "286号の終点の先（県道272の三角）": [140.39778, 38.23723],
    "347号の入口の先（銀山温泉入口の角）": [140.48535, 38.60179],
    "347号の終点の先（南の街区）": [140.743, 38.58252],
  };
  const 近さ = (line, p) => line.reduce((best, q) => Math.min(best, distance(q, p)), Infinity);

  // 材料の確認: ほどかなければ3点とも通る
  const raw = await routeWithValhalla(F["出発"], F["行き先"], {
    vias: F["経由地"], stopAt: F["立ち寄り先の番号"], throughStopAt: F["通り抜けの番号"],
    displacement: "small125", variant: "normal", avoidTolls: true, avoidHighways: true,
    avoidFerries: true, untangleVias: false, baseUrl: BASE });
  assert.ok(!raw.error, raw.error);
  for (const [name, p] of Object.entries(輪の先)) {
    assert.ok(近さ(raw.points, p) <= 20, `材料が悪い: ほどかない経路が ${name} を通らない`);
  }

  const out = await buildRouteResponse({
    from: F["出発"], to: F["行き先"], vias: F["経由地"], stopAt: F["立ち寄り先の番号"],
    throughStopAt: F["通り抜けの番号"], displacement: "small125",
    avoidTolls: true, avoidHighways: true, avoidFerries: true, guidance: false,
  }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const line = decode(out.body.route.polyline);
  for (const [name, p] of Object.entries(輪の先)) {
    const d = 近さ(line, p);
    assert.ok(d >= 100, `アプリへ返す経路が ${name} を通っている（${Math.round(d)}m）`);
  }
  // ⚠️ **立ち寄り先の知らせを失わないこと。** 道の終点2つ＋最終目的地
  assert.strictEqual(out.body.route.steps.filter((s) => s.isLegEnd).length, 3, "区間の数が変わった");
});

test("アプリへ IC・JCTの名前・出口番号・その先の道路を渡す（高速の JCT・IC 案内）", async (t) => {
  // ⚠️ **詰め直すときに入れ忘れると、`admin/lib` が取り出していてもアプリに届かない**
  //    （方面 `towardNames` で実際に抜けていた）
  if (await skipIfDown(t)) return;
  // 用賀 → 厚木（東名・海老名JCT で圏央道へ分かれる所を通る）
  const out = await buildRouteResponse({ from: [139.6335, 35.6262], to: [139.364, 35.442],
    displacement: "large", guidance: false }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const steps = out.body.route.steps;
  for (const s of steps) {
    for (const key of ["exitNames", "exitNumbers", "branchNames"]) {
      assert.ok(Array.isArray(s[key]), `${key} を渡していない指示がある: ${s.instruction}`);
    }
  }
  const jct = steps.find((s) => s.exitNames.includes("海老名JCT"));
  assert.ok(jct, "海老名JCT の名前をアプリへ渡していない");
  assert.deepStrictEqual(jct.exitNumbers, ["4-2"], "出口番号を渡していない・取り違えている");
  assert.deepStrictEqual(jct.branchNames.slice(0, 2), ["C4", "E20"], `その先の道路: ${jct.branchNames}`);
});

test("東京料金所（東名の下り）で本線の途中の出口をアプリへ返さない", async (t) => {
  // ⚠️ 料金所を通る本線の3車線が OSM で出口用の種別（motorway_link）になっていて、アプリが
  //    本線の上で「東名へ左の出口に進みます」と言っていた（`admin/lib/valhallaRoute.js` の `mergeFalseExits`）
  if (await skipIfDown(t)) return;
  const out = await buildRouteResponse({ from: [139.6335, 35.6262], to: [139.364, 35.442],
    displacement: "large", guidance: false }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const steps = out.body.route.steps;
  const bogus = steps.filter((s) => [20, 21].includes(s.valhallaType) && s.distanceMeters <= 400
    && s.roadName.includes("東名高速道路"));
  assert.deepStrictEqual(bogus.map((s) => s.instruction), [], "本線の途中の出口をアプリへ返している");
  // 東京IC の入口の次が海老名JCT（間に「出口」「左寄り」を挟まない）
  const jct = steps.findIndex((s) => s.exitNames.includes("海老名JCT"));
  assert.ok(jct > 0, "材料が悪い: 海老名JCT を通っていない");
  assert.strictEqual(steps[jct - 1].valhallaType, 18, "海老名JCT の手前が東京IC の入口でない");
  assert.ok(steps[jct - 1].distanceMeters > 32000, `入口の指示が ${steps[jct - 1].distanceMeters}m しかない`);
});

test("種類17（分岐を直進）の左右をアプリへ渡す（新座の国道254号→浦和所沢バイパス）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ アプリは「左車線に入ります」と言う（利用者の判断 2026-09-25）。詰め直すときに入れ忘れると届かない
  const out = await buildRouteResponse(
    { from: [139.5560, 35.8060], to: [139.5205, 35.8205], displacement: "large" }, { baseUrl: BASE });
  assert.strictEqual(out.status, 200, out.body.error);
  const steps = out.body.route.steps;
  const forks = steps.filter((x) => x.valhallaType === 17);
  assert.strictEqual(forks.length, 1, "材料が悪い: 浦和所沢バイパスへの分岐を通っていない");
  assert.strictEqual(forks[0].forkSide, "left");
  // 分からない・種類17でないものは null（古いアプリと同じ言い方になる）
  assert.deepStrictEqual([...new Set(steps.filter((x) => x.valhallaType !== 17).map((x) => x.forkSide))], [null]);
});
