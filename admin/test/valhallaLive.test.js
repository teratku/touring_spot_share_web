"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { routeWithValhalla, ROAD_CLASS_TIERS, HIGHWAY_LADDER,
        MAX_SIDE_DETOUR_METERS, FERRY_EXCLUDE_DEGREES, FERRY_EXCLUDE_TRIES,
        FERRY_MANEUVER, BASE } = require("../lib/valhallaRoute");

/**
 * 実際に動いている Valhalla に繋ぐ確認。
 *
 * ⚠️ **Valhalla が居ないときは飛ばす。** 他のテストを巻き込まないこと。
 *    立ち上げ方:
 *      docker run -d --name valhalla-jp -p 8002:8002 valhalla-jp-cloudrun:latest
 */
async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}
const skipIfDown = async (t) => (await up()) ? false : t.skip(`Valhalla が居ない（${BASE}）`);

//: 甲府 → 富士吉田。ほかのテストや文書と同じ2点で揃える
const KOFU = [138.5684, 35.6642];
const FUJI = [138.8087, 35.4876];

test("線と曲がる指示の両方が返る", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI);
  assert.ok(!r.error, r.error);
  // ⚠️ 自前探索との違いがここ。線だけなら roadRoute.js で足りる
  assert.ok(r.steps.length > 5, `曲がる指示が ${r.steps.length} 個しかない`);
  assert.ok(r.points.length > 100, `線の点が ${r.points.length} 個しかない`);
  assert.ok(r.steps.every((s) => s.maneuver), "maneuver が空の指示がある");
});

test("線は指した両端から始まって終わる", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI);
  const m = (a, b) => Math.hypot((b[1] - a[1]) * 110574, (b[0] - a[0]) * 90527);
  assert.ok(m(KOFU, r.points[0]) < 500,
            `始まりが ${Math.round(m(KOFU, r.points[0]))}m 離れている`);
  assert.ok(m(FUJI, r.points[r.points.length - 1]) < 500,
            `終わりが ${Math.round(m(FUJI, r.points[r.points.length - 1]))}m 離れている`);
});

test("点は日本の中に収まる（精度の取り違えが起きていない）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 6桁を5桁として解くと10倍ずれ、必ずここで捕まる
  const r = await routeWithValhalla(KOFU, FUJI);
  const outside = r.points.filter(([lng, lat]) =>
    !(lat > 24 && lat < 46 && lng > 122 && lng < 154));
  assert.strictEqual(outside.length, 0,
    `${outside.length}点が日本の外。最初の1点: ${JSON.stringify(outside[0])}`);
});

test("経由地を通すと大きく遠回りになる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **遠回りを作っているのは経由地。** costing の重みではない（実測で確認済み）
  const plain = await routeWithValhalla(KOFU, FUJI);
  const via = await routeWithValhalla(KOFU, FUJI, {
    vias: [[138.669922, 35.712639], [138.576882, 35.685643]],   // 甲府山梨線の両端
  });
  assert.ok(!via.error, via.error);
  assert.ok(via.lengthMeters > plain.lengthMeters * 1.5,
    `経由させても ${(plain.lengthMeters/1000).toFixed(1)}km → `
    + `${(via.lengthMeters/1000).toFixed(1)}km にしかならない`);
});

test("経由地を通してもUターンが出ない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **これが Google から乗り換える一番の理由。**
  //    いまは Uターンが出るたび最大5回引き直している
  //    （RouteCandidatesView.swift:442 maxFunRouteUTurnRetries = 5）
  const via = await routeWithValhalla(KOFU, FUJI, {
    vias: [[138.669922, 35.712639], [138.576882, 35.685643]],
  });
  assert.strictEqual(via.uTurns, 0, `Uターンが ${via.uTurns} 回出ている`);
});

/**
 * ⚠️ **Uターンの数え方が合っていること。** 「0回だった」を報告する以上、
 *    出るときにちゃんと数えられないと意味がない。
 *    材料は、同じあたりを往復させて実際にUターンが出る組（実測3回）。
 */
test("Uターンが出るときは、ちゃんと数える", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI, {
    vias: [[138.60, 35.68], [138.62, 35.69], [138.60, 35.68]],
  });
  assert.ok(!r.error, r.error);
  assert.ok(r.uTurns > 0, "Uターンが出る組なのに0回と数えている");
  // 指示の中身とも合っていること（数だけ別に作っていないこと）
  const actual = r.steps.filter((x) => x.maneuver.startsWith("uturn")).length;
  assert.strictEqual(r.uTurns, actual,
    `数えた数(${r.uTurns})と指示の中身(${actual})が食い違う`);
});

test("案によって違う経路になる", async (t) => {
  if (await skipIfDown(t)) return;
  const short = await routeWithValhalla(KOFU, FUJI, { variant: "shortest" });
  const fun = await routeWithValhalla(KOFU, FUJI, { variant: "fun" });
  assert.ok(!short.error && !fun.error);
  assert.notStrictEqual(short.polyline, fun.polyline, "最短と楽しいが同じ経路");
  assert.ok(fun.lengthMeters > short.lengthMeters,
    `楽しい(${fun.lengthMeters}m) が 最短(${short.lengthMeters}m) より短い`);
});

test("通れない範囲を渡すと避ける", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 手で直した規制（data/road-restrictions/*.json・279件）を
  //    exclude_polygons として渡す道が使えるか
  const plain = await routeWithValhalla(KOFU, FUJI);
  const mid = plain.points[Math.floor(plain.points.length / 2)];
  const d = 0.0015;
  const box = [[mid[0]-d, mid[1]-d], [mid[0]+d, mid[1]-d],
               [mid[0]+d, mid[1]+d], [mid[0]-d, mid[1]+d], [mid[0]-d, mid[1]-d]];
  const avoided = await routeWithValhalla(KOFU, FUJI, { excludePolygons: [box] });
  assert.ok(!avoided.error, avoided.error);
  const inside = avoided.points.filter(([lng, lat]) =>
    lng >= mid[0]-d && lng <= mid[0]+d && lat >= mid[1]-d && lat <= mid[1]+d);
  assert.strictEqual(inside.length, 0,
    `避けたはずの範囲を ${inside.length} 点通っている`);
});

test("繋がらないときは原因が分かる文言で返す", async (t) => {
  // ⚠️ Valhalla が居ないのが圧倒的に多い。ここは居ても居なくても確かめられる
  const { routeWithValhalla: broken } = require("../lib/valhallaRoute");
  const kept = process.env.VALHALLA_URL;
  process.env.VALHALLA_URL = "http://127.0.0.1:9";   // 誰も居ないポート
  delete require.cache[require.resolve("../lib/valhallaRoute")];
  const fresh = require("../lib/valhallaRoute");
  try {
    const r = await fresh.routeWithValhalla(KOFU, FUJI);
    assert.ok(r.error, "繋がらないのにエラーが返っていない");
    assert.ok(r.error.includes("docker run"),
      "立ち上げ方が書かれていない: " + r.error);
  } finally {
    if (kept === undefined) delete process.env.VALHALLA_URL;
    else process.env.VALHALLA_URL = kept;
    delete require.cache[require.resolve("../lib/valhallaRoute")];
  }
});

// MARK: バイク（motorcycle）

/** その経路が高速道路を何m走るか */
function highwayMeters(route) {
  return (route.steps || [])
    .filter((s) => /自動車道|Expressway|圏央|高速道路/.test(s.roadName || ""))
    .reduce((a, s) => a + s.distanceMeters, 0);
}

//: 新座 → 愛川。バイクの既定だと関越道・圏央道・中央道を66.5km走る組
const NIIZA = [139.57376, 35.79677];
const AIKAWA = [139.26171, 35.55400];

test("バイクの楽しい案が高速道路を走らない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **これが実機で報告された不具合そのもの。**
  //    原付と同じ設定を渡していて、`use_primary` がバイクに効かず、
  //    77.8km のうち 66.5km が高速道路になっていた
  const r = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motorcycle", variant: "fun" });
  assert.ok(!r.error, r.error);
  const hw = highwayMeters(r);
  assert.ok(hw < 1000,
    `楽しい案が高速道路を ${(hw / 1000).toFixed(1)}km 走っている`);
});

test("バイクの楽しい案は、ふつうより高速が少ない", async (t) => {
  if (await skipIfDown(t)) return;
  const normal = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motorcycle", variant: "normal" });
  const fun = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motorcycle", variant: "fun" });
  assert.ok(!normal.error && !fun.error);
  assert.ok(highwayMeters(fun) < highwayMeters(normal),
    `楽しい${(highwayMeters(fun) / 1000).toFixed(1)}km が `
    + `ふつう${(highwayMeters(normal) / 1000).toFixed(1)}km より高速が多い`);
});

test("原付は、そもそも高速に乗らない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 原付・原二は法律で高速に乗れない。Valhalla の motor_scooter も乗せない。
  //    ここが崩れたら costing の取り違えを疑うこと
  for (const variant of ["shortest", "normal", "fun"]) {
    const r = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motor_scooter", variant });
    assert.ok(!r.error, r.error);
    assert.strictEqual(highwayMeters(r), 0, `原付の${variant}が高速に乗っている`);
  }
});

test("バイクの最短は高速を使わずに済んでいる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 最短は距離を詰めるので、結果として高速から降りる。
  //    ここが変わったら shortest が効いていない
  const r = await routeWithValhalla(NIIZA, AIKAWA, { costing: "motorcycle", variant: "shortest" });
  assert.ok(!r.error, r.error);
  assert.ok(highwayMeters(r) < 1000, `最短が高速を ${highwayMeters(r)}m 走っている`);
});

// MARK: 排気量と回避（実際に引いて確かめる）

test("125cc以下は高速に乗らない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **法令の話。** 画面の指定では緩められないこと
  for (const key of ["moped50", "small125"]) {
    const r = await routeWithValhalla(KOFU, FUJI, { displacement: key });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.kindMeters.expressway, 0,
      `${key} が高速を ${(r.kindMeters.expressway / 1000).toFixed(1)}km 走っている`);
  }
});

test("高速回避を外しても、125cc以下は高速に乗らない", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI,
    { displacement: "moped50", avoidHighways: false });
  assert.strictEqual(r.kindMeters.expressway, 0,
    "画面の指定で法令の制約が緩んでいる");
  assert.strictEqual(r.costingOptions.use_highways, 0,
    "use_highways が最後に上書きされていない");
});

test("高速回避を入れると高速が消える", async (t) => {
  if (await skipIfDown(t)) return;
  // 新座→愛川。大型なら既定で65.9km高速を走る（実測）
  const from = [139.57386, 35.79677], to = [139.26211, 35.55413];
  const plain = await routeWithValhalla(from, to, { displacement: "large" });
  const avoid = await routeWithValhalla(from, to,
    { displacement: "large", avoidHighways: true });
  assert.ok(plain.kindMeters.expressway > 10_000,
    `材料が悪い（既定で高速${(plain.kindMeters.expressway / 1000).toFixed(1)}km。もっと乗る組で試すこと）`);
  assert.strictEqual(avoid.kindMeters.expressway, 0,
    `高速回避なのに ${(avoid.kindMeters.expressway / 1000).toFixed(1)}km 乗っている`);
});

test("区間ごとに道の種別が付く", async (t) => {
  if (await skipIfDown(t)) return;
  const from = [139.57386, 35.79677], to = [139.26211, 35.55413];
  const r = await routeWithValhalla(from, to, { displacement: "large" });
  assert.ok(r.steps.every((s) => s.roadKind), "種別の付いていない区間がある");
  const kinds = new Set(r.steps.map((s) => s.roadKind));
  for (const k of kinds) {
    assert.ok(["expressway", "toll", "surface"].includes(k), `知らない種別: ${k}`);
  }
  // 内訳の合計が、区間の距離の合計と合うこと
  const sum = Object.values(r.kindMeters).reduce((a, b) => a + b, 0);
  const stepSum = r.steps.reduce((a, s) => a + s.distanceMeters, 0);
  assert.strictEqual(sum, stepSum, "内訳の合計が区間の合計と合わない");
});

/**
 * ⚠️ **同じ点が続くと Valhalla が失敗する。**
 *    `leg_shape_index not set for intermediate location` が返る。
 *    実測: 陣馬街道の出口と和田林道の入口が**0m**（同じ交差点）で、
 *    楽しい道8本を通す案が**丸ごと引けなくなっていた**。
 *
 * ⚠️ 材料は手で作らないこと。同じ点を3つ並べただけでは Valhalla が耐えてしまい、
 *    まとめる処理を外しても落ちなかった。**実際に壊れた並びをそのまま使う。**
 */
test("重なった経由地でも引ける", async (t) => {
  if (await skipIfDown(t)) return;
  const from = [139.57386, 35.79677], to = [139.26211, 35.55413];
  // 実測で失敗した north まわり8本ぶんの経由地。3番目と4番目が同じ点
  const vias = [
    [139.214782, 35.67028], [139.168281, 35.657623],
    [139.168281, 35.657623], [139.154828, 35.656111],
    [139.139812, 35.638763], [139.122311, 35.627306],
    [139.104918, 35.629708], [139.011506, 35.608357],
    [139.061537, 35.631811], [139.07121, 35.614289],
    [139.131064, 35.584826], [139.149932, 35.590786],
    [139.150269, 35.581156], [139.199929, 35.60091],
    [139.172123, 35.59323], [139.206548, 35.563589],
  ];
  // 材料が正しいこと（重なりが本当に入っている）
  assert.deepStrictEqual(vias[1], vias[2], "材料に重なりが無い");

  const r = await routeWithValhalla(from, to, { vias, displacement: "large" });
  assert.ok(!r.error, `重なった経由地で落ちている: ${r.error}`);
  assert.ok(r.lengthMeters > 100_000,
    `${(r.lengthMeters / 1000).toFixed(0)}km しかない（8本通っていない）`);
});

// MARK: 道路クラス（色分けと重み）

test("原付は3段階で通る道のクラスが変わる", async (t) => {
  if (await skipIfDown(t)) return;
  // 高崎→草津。実測: 最短は trunk47km、裏道は trunk10km で secondary27km に移る
  const from = [138.9985, 36.3219], to = [138.5966, 36.6208];
  const got = {};
  for (const variant of ["shortest", "normal", "fun"]) {
    const r = await routeWithValhalla(from, to, { variant, displacement: "small125" });
    assert.ok(!r.error, r.error);
    got[variant] = r;
  }
  const trunk = (r) => (r.classMeters.trunk || 0);
  assert.ok(trunk(got.shortest) > trunk(got.fun) * 2,
    `最短の幹線 ${(trunk(got.shortest) / 1000).toFixed(0)}km が `
    + `裏道 ${(trunk(got.fun) / 1000).toFixed(0)}km の2倍に届かない（重みが効いていない）`);
  assert.ok(got.fun.lengthMeters > got.shortest.lengthMeters,
    "裏道が最短より短い");
});

test("道路クラスの区間が取れる", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI, { displacement: "small125" });
  assert.ok(Array.isArray(r.classSpans) && r.classSpans.length > 0,
    "クラスの区間が取れていない（/trace_attributes が失敗している）");
  // ⚠️ 区間の番号が線の範囲に収まっていること。はみ出すと地図で線が飛ぶ
  for (const sp of r.classSpans) {
    assert.ok(sp.begin >= 0 && sp.end < r.points.length,
      `区間の番号が線の外（${sp.begin}〜${sp.end} / 線は${r.points.length}点）`);
    assert.ok(sp.end >= sp.begin, `終わりが始まりより前（${sp.begin}〜${sp.end}）`);
  }
  // 合計がおおよそ経路の長さと合うこと（辺の切り方で多少ずれる）
  const sum = Object.values(r.classMeters).reduce((a, b) => a + b, 0);
  const diff = Math.abs(sum - r.lengthMeters) / r.lengthMeters;
  assert.ok(diff < 0.1,
    `クラスの合計 ${(sum / 1000).toFixed(1)}km が経路 ${(r.lengthMeters / 1000).toFixed(1)}km と合わない`);
});

test("バイクには道路クラスの重みを渡さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ motorcycle では use_primary が効かない（実測）。渡すと設定だけ増えて紛らわしい
  const r = await routeWithValhalla(KOFU, FUJI, { variant: "fun", displacement: "large" });
  assert.ok(!("use_primary" in r.costingOptions),
    `バイクに use_primary を渡している: ${JSON.stringify(r.costingOptions)}`);
});

test("原付には道路クラスの重みが渡る", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(KOFU, FUJI, { variant: "fun", displacement: "small125" });
  assert.strictEqual(r.costingOptions.use_primary,
    ROAD_CLASS_TIERS.small125.fun.use_primary,
    `裏道の重みが渡っていない: ${JSON.stringify(r.costingOptions)}`);
});

test("原付一種と原付二種で、実際に選ぶ道が変わる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **以前は両方まったく同じ経路だった**（同じ costing・同じ設定）。
  //    画面で選び分けても1mも変わらず、選ぶ意味が無かった
  const [a, b] = await Promise.all([
    routeWithValhalla(KOFU, FUJI, { variant: "normal", displacement: "moped50",  withClasses: true }),
    routeWithValhalla(KOFU, FUJI, { variant: "normal", displacement: "small125", withClasses: true }),
  ]);
  assert.ok(!a.error && !b.error, `経路が引けない: ${a.error || b.error}`);

  const big = (r) => {
    const spans = r.classSpans || [];
    const m = spans.filter((s) => ["motorway", "trunk", "primary"].includes(s.roadClass))
                   .reduce((x, s) => x + s.meters, 0);
    return m / r.lengthMeters;
  };
  assert.ok(a.lengthMeters !== b.lengthMeters || big(a) !== big(b),
    "原付一種と原付二種で経路がまったく同じ（選び分けが効いていない）");
  assert.ok(big(a) < big(b),
    `原付一種(大きい道 ${(big(a) * 100).toFixed(0)}%) が `
    + `原付二種(${(big(b) * 100).toFixed(0)}%) より幹線を使っている`);

  // ⚠️ 所要時間も法定速度と合っていること
  const kmh = (r) => r.lengthMeters / 1000 / (r.durationSeconds / 3600);
  assert.ok(kmh(a) <= 31, `原付一種が ${kmh(a).toFixed(0)}km/h で走っている（法定30km/h）`);
  assert.ok(kmh(b) > kmh(a), `原付二種が原付一種より遅い（${kmh(b).toFixed(0)}km/h）`);
});

test("高速を通る経路でも道路クラスが取れる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **`edge_walk` だけでは駄目。** 実測: 新座→愛川の「ふつう」
  //    （77.8km・うち高速65.8km）で error_code 443 を返し、
  //    画面のクラス内訳が**黙って全部0km**になっていた
  const r = await routeWithValhalla([139.57382, 35.79678], [139.26196, 35.55397],
    { variant: "normal", displacement: "large", withClasses: true });
  assert.ok(!r.error, `経路が引けない: ${r.error}`);

  const spans = r.classSpans || [];
  assert.ok(spans.length > 0, "道路クラスが1区間も取れていない（色分けが消える）");

  const total = spans.reduce((a, s) => a + s.meters, 0);
  assert.ok(Math.abs(total - r.lengthMeters) / r.lengthMeters < 0.05,
    `クラスの合計 ${(total / 1000).toFixed(1)}km が経路長 `
    + `${(r.lengthMeters / 1000).toFixed(1)}km と合わない`);

  // ⚠️ この材料が「高速を通る」ものであること（そうでないと edge_walk でも通る）
  const motorway = spans.filter((s) => s.roadClass === "motorway")
                        .reduce((a, s) => a + s.meters, 0);
  assert.ok(motorway > 10_000,
    `材料が悪い（高速 ${(motorway / 1000).toFixed(1)}km）。高速を通る経路であること`);
});

test("top_speed 30 は「速い道の禁止」ではなく「傾き」である", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **以前ここを取り違えていた。** 「30を渡すと60km/hの一般道をほぼ全部避ける」
  //    と書いて `top_speed` を使わない判断をしていたが、実測すると違った。
  //    5区間で測って主要地方道を16〜30%使っており、距離の増えかたも最大+7%。
  //    この事実の上に原付一種の設定が乗っているので、崩れたら気づけるようにする
  const r = await routeWithValhalla([139.57382, 35.79678], [139.26196, 35.55397],
    { variant: "normal", displacement: "moped50", withClasses: true });
  assert.ok(!r.error, `経路が引けない: ${r.error}`);
  assert.strictEqual(r.costingOptions.top_speed, 30, "材料が悪い（30が渡っていない）");

  const spans = r.classSpans || [];
  assert.ok(spans.length > 0, "道路クラスが取れていない");
  const fast = spans.filter((s) => ["trunk", "primary", "secondary"].includes(s.roadClass))
                    .reduce((a, s) => a + s.meters, 0);
  assert.ok(fast > 0,
    "30km/h超の道を1mも使っていない（禁止として効いてしまっている）");

  // 遠回りになりすぎないこと（実測は最大+7%）
  const plain = await routeWithValhalla([139.57382, 35.79678], [139.26196, 35.55397],
    { variant: "normal", displacement: "small125" });
  assert.ok(r.lengthMeters < plain.lengthMeters * 1.3,
    `原付一種が ${(r.lengthMeters / 1000).toFixed(1)}km と遠回りしすぎている`
    + `（原付二種 ${(plain.lengthMeters / 1000).toFixed(1)}km）`);
});

// MARK: 高速を外すために国道まで捨てない

/** 報告の区間: 鳥屋川尻線の出口 → 愛川の目的地（直線1.5km・国道412号沿い） */
const AIKAWA_FROM = [139.25537, 35.56612];
const AIKAWA_TO = [139.26199, 35.55401];

test("国道が使えるところでは、裏道に逃げない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **利用者からの報告そのもの。**「大きな道路があるのにわざわざ狭い道路に出る」
  //    原因は `use_highways: 0` が高速だけでなく国道（trunk）も0.5倍で罰すること。
  //    実測: 0 のままだと 2.59km・指示14・生活道路1.26km（412号を3回出入り）
  const r = await routeWithValhalla(AIKAWA_FROM, AIKAWA_TO,
    { variant: "fun", displacement: "large", withClasses: true });
  assert.ok(!r.error, `経路が引けない: ${r.error}`);

  const tot = {};
  for (const s of r.classSpans || []) tot[s.roadClass] = (tot[s.roadClass] || 0) + s.meters;
  const small = ["tertiary", "unclassified", "residential", "service_other"]
    .reduce((a, k) => a + (tot[k] || 0), 0);

  assert.ok(small < 500,
    `細い道を ${small}m 走っている（国道412号を避けて裏道へ逃げている）`);
  assert.ok((tot.trunk || 0) > 1_500,
    `国道（幹線）を ${(tot.trunk || 0)}m しか走っていない`);
  assert.ok(r.steps.length <= 4,
    `指示が ${r.steps.length} 個ある（蛇行している。直進なら2個）`);
});

test("緩めても高速が増えない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **ここは以前「緩めても高速には乗らない」と書いていたが、言い過ぎだった。**
  //    `use_highways: 0` 自体が高速を完全には防げない（罰であって禁止ではない）。
  //    実測: 8区間21案で固定0でも高速15.6km 走っていた（仙台→蔵王など）。
  //    **言えるのは「緩めたせいで増えることはない」。** 緩めた案は
  //    高速の指示が1つも無いときだけ採るので、固定0を超えない
  for (const [label, from, to] of [
    ["新座→愛川", [139.57378, 35.79677], [139.26199, 35.55401]],
    ["東京→箱根", [139.7671, 35.6812], [139.1069, 35.2324]],
    ["仙台→蔵王", [140.8694, 38.2606], [140.44, 38.13]],
  ]) {
    const [loose, strict] = await Promise.all([
      routeWithValhalla(from, to, { variant: "fun", displacement: "large", withClasses: true }),
      routeWithValhalla(from, to, { variant: "fun", displacement: "large", withClasses: true,
                                    highwayLadder: false }),
    ]);
    assert.ok(!loose.error && !strict.error, `${label}: ${loose.error || strict.error}`);
    const mw = (r) => (r.classSpans || []).filter((s) => s.roadClass === "motorway")
                                          .reduce((a, s) => a + s.meters, 0);
    assert.ok(mw(loose) <= mw(strict) + 100,
      `${label}: 緩めたことで高速が増えている（${mw(strict)}m → ${mw(loose)}m）`);
  }
});

test("緩めると国道を使うようになる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **1区間で「細い道が減る」とは言えない。** 集計では減るが
  //    （8区間21案・幅×5・8本: 固定0 細い道701.6km → 段階あり419.7km）、
  //    新座→愛川の単発では 4,040m → 4,530m と**わずかに増える**。
  //    経路そのものが変わるので、区間ごとの増減は一様ではない。
  //    **この材料で確かに言えるのは、国道を使うようになることと道のりが縮むこと。**
  //    「裏道に逃げない」は報告の区間の方で押さえてある（上のテスト）
  const trunk = (r) => (r.classSpans || []).filter((s) => s.roadClass === "trunk")
    .reduce((a, s) => a + s.meters, 0);

  const [loose, strict] = await Promise.all([
    routeWithValhalla([139.57378, 35.79677], [139.26199, 35.55401],
      { variant: "fun", displacement: "large", withClasses: true }),
    routeWithValhalla([139.57378, 35.79677], [139.26199, 35.55401],
      { variant: "fun", displacement: "large", withClasses: true, highwayLadder: false }),
  ]);
  assert.ok(!loose.error && !strict.error, `${loose.error || strict.error}`);
  assert.ok(loose.highwayTries > 1, "緩めていない（材料が悪い）");
  assert.ok(trunk(loose) > trunk(strict) * 10,
    `国道がほとんど増えていない（${trunk(strict)}m → ${trunk(loose)}m）`);
  assert.ok(loose.lengthMeters < strict.lengthMeters,
    `道のりが縮んでいない（${(strict.lengthMeters / 1000).toFixed(1)}km → `
    + `${(loose.lengthMeters / 1000).toFixed(1)}km）`);
});

test("原付では緩めない（motor_scooter は use_highways を無視する）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 5区間で 0/1 どちらでも同じ経路・高速0.0kmだった。
  //    50cc/125cc が高速に乗らないのは costing の作りによる保証であって、
  //    この値のおかげではない。無駄に引き直さないこと
  const r = await routeWithValhalla(KOFU, FUJI,
    { variant: "fun", displacement: "small125" });
  assert.strictEqual(r.highwayTries, 1,
    `原付で ${r.highwayTries} 回引いている（motor_scooter では意味がない）`);
});

test("段階は緩い順に並んでいる", () => {
  // ⚠️ 順番が崩れると「一番ゆるい値を採る」が成り立たない
  for (let i = 1; i < HIGHWAY_LADDER.length; i++) {
    assert.ok(HIGHWAY_LADDER[i] < HIGHWAY_LADDER[i - 1],
      `緩い順になっていない: ${JSON.stringify(HIGHWAY_LADDER)}`);
  }
  assert.strictEqual(HIGHWAY_LADDER[HIGHWAY_LADDER.length - 1], 0,
    "最後は0（高速を必ず外せる値）であること");
});

// MARK: 目的地の側

test("目的地を対向車線側にしない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **左と決め打ちしないこと。** 向きは Valhalla が国ごとに持っている
  //    （admins.sqlite の drive_on_right）。日本は左側通行なので left になる
  const off = await routeWithValhalla(AIKAWA_FROM, AIKAWA_TO,
    { variant: "fun", displacement: "large" });
  const on = await routeWithValhalla(AIKAWA_FROM, AIKAWA_TO,
    { variant: "fun", displacement: "large", arriveOnNearSide: true });

  assert.strictEqual(off.arrivedSide, "right", "材料が悪い（指定なしでも左に着く）");
  assert.strictEqual(on.arrivedSide, "left",
    `指定しても ${on.arrivedSide} 側に着いている`);
  assert.ok(/左側/.test(on.steps[on.steps.length - 1].instruction),
    `最後の指示が左側になっていない: ${on.steps[on.steps.length - 1].instruction}`);
  // 遠回りは小さいこと（実測 +0.40km）
  assert.ok(on.lengthMeters < off.lengthMeters * 1.3,
    `遠回りしすぎ（${(off.lengthMeters / 1000).toFixed(2)}km → `
    + `${(on.lengthMeters / 1000).toFixed(2)}km）`);
});

test("経由地があっても、目的地の側だけが変わる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **経由地に側を付けても Valhalla は無視する。** `through` は通過するだけで
  //    停まらないため。実際に経由地へ `preferred_side` を付けて試したが
  //    経路は1mも変わらなかった。**つまり「経由地には付けない」を守るテストは書けない。**
  //    ここで確かめるのは「経由地があっても目的地の側は効く」の方
  const vias = [[139.30, 35.62], [139.28, 35.59]];
  const [off, on] = await Promise.all([
    routeWithValhalla([139.57378, 35.79677], AIKAWA_TO,
      { vias, variant: "fun", displacement: "large" }),
    routeWithValhalla([139.57378, 35.79677], AIKAWA_TO,
      { vias, variant: "fun", displacement: "large", arriveOnNearSide: true }),
  ]);
  assert.ok(!off.error && !on.error, `${off.error || on.error}`);
  assert.strictEqual(on.arrivedSide, "left",
    `経由地があると側の指定が効かない（${on.arrivedSide}）`);
  assert.ok(Math.abs(on.lengthMeters - off.lengthMeters) < off.lengthMeters * 0.1,
    `遠回りが大きすぎる（${(off.lengthMeters / 1000).toFixed(1)}km → `
    + `${(on.lengthMeters / 1000).toFixed(1)}km）`);
});

test("側のために大きく遠回りするなら諦める", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **実測の実例。** 仙台→蔵王は左側に着けるために **65km → 94km**
  //    （往復28.9km・折り返しの先端はゴールから5.4km）になった。
  //    12地点の追加距離は 0.00〜0.40km に11件、29.06km に1件。あいだが空いている
  const [off, on] = await Promise.all([
    routeWithValhalla([140.8694, 38.2606], [140.44, 38.13],
      { variant: "fun", displacement: "large" }),
    routeWithValhalla([140.8694, 38.2606], [140.44, 38.13],
      { variant: "fun", displacement: "large", arriveOnNearSide: true }),
  ]);
  assert.ok(!off.error && !on.error, `${off.error || on.error}`);
  assert.strictEqual(off.arrivedSide, "right", "材料が悪い（元から左に着く）");
  assert.strictEqual(on.sideGaveUp, true,
    `${((on.lengthMeters - off.lengthMeters) / 1000).toFixed(1)}km の遠回りを受け入れている`);
  assert.strictEqual(on.lengthMeters, off.lengthMeters,
    "諦めたのに経路が変わっている");
});

test("諦める線引きが実測と合っている", () => {
  // ⚠️ 実測の切れ目は 0.40km と 29.06km のあいだ。2km はその中に入る
  assert.ok(MAX_SIDE_DETOUR_METERS > 400,
    `${MAX_SIDE_DETOUR_METERS}m では、街区を回る程度（実測0.40km）も諦めてしまう`);
  assert.ok(MAX_SIDE_DETOUR_METERS < 29_000,
    `${MAX_SIDE_DETOUR_METERS}m だと、山を回る遠回り（実測29.06km）を受け入れてしまう`);
});

// MARK: 船（フェリー）に乗らない

/** 東京→秋田。何もしないと新日本海フェリー（新潟－秋田）229kmに乗ってしまう */
const TOKYO = [139.7671, 35.6812];
const AKITA = [140.03598, 39.78634];

test("最短の案でも船に乗らない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **利用者からの報告そのもの。** `shortest: true` は距離だけで決めるので
  //    `use_ferry` も `ferry_cost` も無視される。船は地図の上ではまっすぐ短いため
  //    必ず選ばれる。実測: 557.7km 12.8時間・うち船229.5km
  //    （陸まわりは583.9km 6.3時間。**26km縮めるために6.5時間よけい**）
  const r = await routeWithValhalla(TOKYO, AKITA,
    { variant: "shortest", displacement: "large" });
  assert.ok(!r.error, `経路が引けない: ${r.error}`);
  assert.strictEqual(r.ferryMeters, 0,
    `船に ${(r.ferryMeters / 1000).toFixed(0)}km 乗っている`);
  assert.ok(r.ferryTries > 1, "船を外すために引き直していない（材料が悪い）");
  assert.ok(!r.steps.some((x) => x.valhallaType === FERRY_MANEUVER),
    "指示に船が残っている");
});

test("ふつう・楽しいの案でも船に乗らない", async (t) => {
  if (await skipIfDown(t)) return;
  for (const variant of ["normal", "fun"]) {
    const r = await routeWithValhalla(TOKYO, AKITA, { variant, displacement: "large" });
    assert.ok(!r.error, `${variant}: ${r.error}`);
    assert.strictEqual(r.ferryMeters, 0,
      `${variant}: 船に ${(r.ferryMeters / 1000).toFixed(0)}km 乗っている`);
  }
});

test("船を避けられる区間では、遠回りしてでも陸を通る", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 東京湾フェリー（久里浜－金谷）。**乗れば45km、陸まわりだと114km。**
  //    それでも乗らないこと（利用者の指示）
  const r = await routeWithValhalla([139.672, 35.2814], [139.87, 34.997],
    { variant: "shortest", displacement: "large" });
  assert.ok(!r.error, `経路が引けない: ${r.error}`);
  assert.strictEqual(r.ferryMeters, 0, `船に乗っている`);
  assert.ok(r.lengthMeters > 90_000,
    `${(r.lengthMeters / 1000).toFixed(0)}km しかない（船に乗っているのでは）`);
});

test("船なしで行けないところは、船が残ったと返す", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **北海道へは船なしで行けない。** 黙って遠回りしたり失敗したりせず、
  //    残った船の距離を返すこと（画面で「避けられない航路」と出す）。
  //    実測: 青函の39km が残る
  const r = await routeWithValhalla(TOKYO, [141.3544, 43.0621],
    { variant: "shortest", displacement: "large" });
  assert.ok(!r.error, `経路が引けない: ${r.error}`);
  assert.ok(r.ferryMeters > 0, "避けられないはずの船が0になっている");
  assert.ok(r.ferryMeters < 100_000,
    `船が ${(r.ferryMeters / 1000).toFixed(0)}km もある（もっと短い航路があるはず。実測39km）`);
});

test("船が無い区間では引き直さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 無駄に引き直さないこと。ほとんどの経路は船と関係ない
  const r = await routeWithValhalla([139.57378, 35.79677], [139.26199, 35.55401],
    { variant: "shortest", displacement: "large" });
  assert.strictEqual(r.ferryTries, 1,
    `船が無いのに ${r.ferryTries} 回引いている`);
});

test("塞ぐ四角が、Valhalla の上限に収まる", () => {
  // ⚠️ **`exclude_polygons` は四角の周囲の合計に上限がある**（10,000m）。
  //    実測: ±0.005度の四角は3個で
  //    「Exceeded maximum circumference for exclude_polygons」になった
  const side = FERRY_EXCLUDE_DEGREES * 2 * 111_000;      // 緯度方向のざっくり長さ(m)
  const perimeter = side * 4;
  assert.ok(perimeter * FERRY_EXCLUDE_TRIES < 10_000,
    `四角${FERRY_EXCLUDE_TRIES}個で周囲 ${Math.round(perimeter * FERRY_EXCLUDE_TRIES)}m。`
    + "Valhalla の上限 10,000m を超える");
});

test("船を避けられるところは、塞がずに一発で避ける", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **`use_ferry: 0` を入れておく意味はここ。** 塞いで引き直す処理でも
  //    最後は同じ答えになるが、そのぶん通信が増える。
  //    実測（横須賀→館山 ふつう）: `use_ferry: 0` あり 1回 / なし 2回
  //    ⚠️ `shortest` では効かない。効くのはこちらだけ（FERRY_EXCLUDE_DEGREES の説明）
  const r = await routeWithValhalla([139.672, 35.2814], [139.87, 34.997],
    { variant: "normal", displacement: "large" });
  assert.ok(!r.error, `経路が引けない: ${r.error}`);
  assert.strictEqual(r.ferryMeters, 0, "船に乗っている");
  assert.strictEqual(r.ferryTries, 1,
    `${r.ferryTries} 回引いている。use_ferry: 0 が渡っていないのでは`);
  assert.strictEqual(r.costingOptions.use_ferry, 0, "use_ferry が渡っていない");
});

test("塞いで悪くなったら、塞ぐ前を採る", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **いたちごっこで悪化することがある。** 実測: 東京→札幌で
  //    八戸－苫小牧（235km）を塞いだら舞鶴－小樽（700km）に化けた。
  //    減らないなら打ち切って、いちばん船が短い案を採ること
  // ⚠️ **「最短」では確かめられない。** 塞いでも駄目なら shortest を諦める処理が
  //    結果を救ってしまい、打ち切りの有無で答えが変わらない（実測で確認）。
  //    差が出るのは「ふつう」「楽しい」の方
  for (const variant of ["normal", "fun"]) {
    const r = await routeWithValhalla(TOKYO, [141.3544, 43.0621],
      { variant, displacement: "large" });
    assert.ok(!r.error, `${variant}: ${r.error}`);
    assert.ok(r.ferryMeters <= 40_000,
      `${variant}: 船が ${(r.ferryMeters / 1000).toFixed(0)}km。`
      + "塞いで悪くなった案を採っている（実測: 打ち切れば39km、打ち切らないと411km）");
  }
});
