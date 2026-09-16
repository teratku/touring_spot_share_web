"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { routeWithValhalla, speedSpans, ROAD_CLASS_TIERS, HIGHWAY_LADDER,
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
// ⚠️ 雁坂トンネル（有料）を通らないと着けない。有料回避の検査に使う。
//    ⚠️ 奥多摩からだと有料を通らない経路があり検査にならない（実測 72.5km・有料0km）
const OTAKI  = [138.93776, 35.94965];   // 道の駅大滝温泉
const HIROSE = [138.76376, 35.83867];   // 広瀬ダム
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
  // 内訳の合計が、区間の距離の合計と合うこと。
  // ⚠️ **ぴったり一致はしない。** 内訳は `/trace_attributes` の辺の長さから、
  //    指示の距離は maneuver の `length`（km・小数3桁）から来ていて、出どころが違う。
  //    実測のずれ: 77.8km で 6m、303.3km で 29m（どちらも 0.01% 未満）。
  //    ⚠️ **丸めて合わせないこと。** 数字を作り替えることになる
  const sum = Object.values(r.kindMeters).reduce((a, b) => a + b, 0);
  const stepSum = r.steps.reduce((a, s) => a + s.distanceMeters, 0);
  const 許容 = Math.max(50, stepSum * 0.0005);
  assert.ok(Math.abs(sum - stepSum) <= 許容,
    `内訳の合計が区間の合計と合わない（${sum} vs ${stepSum}・許容${Math.round(許容)}m）`);
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

test("辺ごとの速度と制限速度を取り出せる", async (t) => {
  // ⚠️ **焼き直しの前後を比べる道具。** `edge.speed` は経路計算に使う速度、
  //    `edge.speed_limit` は OSM の maxspeed（未登録なら0）。
  //    既定速度を焼き直しても `speed_limit` は動かないので、
  //    **「未登録率が変わっていない＝タグを壊していない」の証明に使える。**
  if (await skipIfDown(t)) return;
  // ⚠️ **大型で引くこと。** 原付（motor_scooter）は秩父往還を通らず、
  //    未登録の辺が275mしか出ない（＝検査にならない）
  const r = await routeWithValhalla(OTAKI, HIROSE,
    { displacement: "large", baseUrl: BASE });
  assert.ok(!r.error, r.error);
  const spans = await speedSpans(r.points, "motorcycle", BASE);
  assert.ok(Array.isArray(spans) && spans.length > 0, "辺が取れていない");
  for (const key of ["wayId", "roadClass", "meters", "speed", "speedLimit"]) {
    assert.ok(key in spans[0], `${key} が無い`);
  }
  // 材料の確認: この区間には maxspeed 未登録の辺が実際にあること
  const 未登録 = spans.filter((sp) => !sp.speedLimit)
    .reduce((a, sp) => a + sp.meters, 0);
  assert.ok(未登録 > 1_000,
    `未登録の辺が ${未登録}m しかない。この区間では検査にならない`);
});

//: 焼く前に固定した17区間の線。⚠️ **焼き直したあとに作り直さないこと**（比較の土台が消える）
const 速度標本 = require("./fixtures-speed-sections.json");

//: 秩父往還のうち maxspeed が未登録の way（この件の発端）
const 未登録の国道 = [138336643, 46145093, 731030715];
//: 雁坂トンネル。maxspeed=40 が登録済み。**上書きされていないことの見本**
const 登録済みの見本 = 43251581;

async function 区間の辺(name) {
  const s = 速度標本.sections.find((x) => x.name === name);
  assert.ok(s, `標本に「${name}」が無い`);
  return speedSpans(s.points, "motorcycle", BASE);
}

test("登録済みの maxspeed はそのまま経路計算に使われる", async (t) => {
  // ⚠️ **これは「既定速度の表を入れない」という判断を留める検査。**
  //    OSM に maxspeed が無い道が多く（全国17区間で国道の74%・平均88km/h扱い）、
  //    Valhalla の `mjolnir.default_speeds_config` で日本の値に寄せようとした。
  //    ⚠️ **実測でやめた。** その表は未登録だけを直すのではなく、
  //    **登録済みの maxspeed も必ず塗り替える**（`speed_assigner.h` で設定表の値が
  //    `SpeedType::kTagged` を守る分岐より先に当たり return する）。
  //    山梨で予行したところ、国道20号の `maxspeed=60` が 43／35km/h に化けた。
  //    失うもの（実際の標識 634.6km）が確実で、得るものは全国平均でしかない。
  //
  // ⚠️ **この検査が落ちたら、誰かが `use_default_speeds_config=True` で焼いた合図。**
  //    そのときは上の判断ごと見直すこと（`docs/valhalla-plan.md` に経緯がある）。
  if (await skipIfDown(t)) return;
  const spans = await 区間の辺("国道140号 道の駅大滝温泉→広瀬ダム");
  assert.ok(spans, "辺が取れていない");
  const 登録済み = spans.filter((e) => e.speedLimit > 0);
  // 材料の確認: この区間に登録済みの辺が十分あること
  const 登録m = 登録済み.reduce((a, e) => a + e.meters, 0);
  assert.ok(登録m > 5_000,
    `登録済みの辺が ${登録m}m しかない。この区間では検査にならない`);
  for (const e of 登録済み) {
    assert.strictEqual(e.speed, e.speedLimit,
      `way/${e.wayId} が maxspeed ${e.speedLimit} なのに ${e.speed}km/h。`
      + "既定速度の表が当たっている疑い");
  }
});

test("登録済みの maxspeed を上書きしていない", async (t) => {
  // ⚠️ **`default_speeds_config` は登録済みの maxspeed も塗り替える**
  //    （`speed_assigner.h` で設定表の値が `kTagged` の分岐より先に当たる）。
  //    だから触らないクラスは `null` にしてある。壊れていないことを見張る。
  if (await skipIfDown(t)) return;
  const spans = await 区間の辺("国道140号 道の駅大滝温泉→広瀬ダム");
  assert.ok(spans, "辺が取れていない");
  const 見本 = spans.filter((e) => e.wayId === 登録済みの見本);
  assert.ok(見本.length > 0, `way/${登録済みの見本}（雁坂トンネル）が経路に無い`);
  assert.ok(見本.every((e) => e.speedLimit === 40),
    "見本の maxspeed が40でなくなった。OSM 側が変わったなら見本を選び直すこと");
  for (const e of 見本) {
    // ⚠️ 舗装の悪い道は Valhalla が速度を下げるので、少し緩める
    assert.ok(Math.abs(e.speed - e.speedLimit) <= 10,
      `way/${e.wayId} が maxspeed ${e.speedLimit} に対し ${e.speed}km/h。上書きされている`);
  }
});

test("maxspeed の未登録がどれだけあるかを見張る", async (t) => {
  // ⚠️ **直せない問題を、見えるところに置いておくための検査。**
  //    全国17区間1,290kmの実測（2026-09）:
  //      trunk 74%未登録・平均88km/h / primary 79%・73km/h
  //      secondary 76%・60km/h / tertiary 78%・53km/h / motorway 7%・103km/h
  //    国道の既定88km/hは日本の山間国道としてあり得ないが、
  //    Valhalla の設定表で直すと登録済みまで壊れるのでやめた（上の検査を読むこと）。
  //
  // ⚠️ **未登録率が大きく下がったら、OSM 側が改善した合図。**
  //    そのときは「既定速度をどうするか」を測り直す価値がある。
  if (await skipIfDown(t)) return;
  const 合計 = {};
  for (const s of 速度標本.sections) {
    const spans = await speedSpans(s.points, "motorcycle", BASE);
    assert.ok(spans, `${s.name} の辺が取れていない`);
    for (const e of spans) {
      const k = 合計[e.roadClass] = 合計[e.roadClass] || { 未登録: 0, 登録: 0 };
      if (e.speedLimit) k.登録 += e.meters; else k.未登録 += e.meters;
    }
  }
  const trunk = 合計.trunk;
  assert.ok(trunk && trunk.未登録 + trunk.登録 > 300_000,
    `国道の標本が ${trunk ? Math.round((trunk.未登録 + trunk.登録) / 1000) : 0}km しかない`);
  const 率 = trunk.未登録 / (trunk.未登録 + trunk.登録);
  assert.ok(率 > 0.5 && 率 < 0.9,
    `国道の maxspeed 未登録率が ${(100 * 率).toFixed(0)}%。`
    + "実測時（74%）から大きく動いた。既定速度の判断を測り直すこと");
});

test("指示ごとに、そのうち何mが有料かを返す", async (t) => {
  // ⚠️ **指示(maneuver)の有料の旗は、一部でも有料を含むと丸ごう立つ。**
  //    実測: 実際6.8kmの雁坂トンネルを含む28.4kmの指示が、丸ごと「有料」になる。
  //    画面の「通る道」がその28.4kmを有料として出すので、4倍に見える。
  //    **指示を分割はできない**（曲がり方が狂う）。代わりに、その指示のうち
  //    何mが有料かを添える。
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(OTAKI, HIROSE,
    { displacement: "small125", avoidTolls: true, baseUrl: BASE });
  assert.ok(!r.error, r.error);
  const 有料の指示 = r.steps.filter((x) => x.roadKind === "toll");
  // 材料の確認: 旗の立った指示が実際にあること
  assert.ok(有料の指示.length > 0, "有料の旗が立った指示が無い。この区間では検査にならない");
  for (const x of 有料の指示) {
    assert.ok(typeof x.tollMeters === "number", "指示に tollMeters が無い");
    assert.ok(x.tollMeters <= x.distanceMeters,
      `tollMeters(${x.tollMeters}) が指示の長さ(${x.distanceMeters}) を超えている`);
  }
  const 合計 = r.steps.reduce((a, x) => a + (x.tollMeters || 0), 0);
  assert.ok(Math.abs(合計 - r.tollUnavoidableMeters) < 500,
    `指示ごとの合計(${合計}m)が、全体の有料(${r.tollUnavoidableMeters}m)と合わない`);
  // ⚠️ 旗の立った指示の長さの合計より、実際の有料はずっと短いはず
  const 旗の長さ = 有料の指示.reduce((a, x) => a + x.distanceMeters, 0);
  assert.ok(合計 < 旗の長さ * 0.5,
    `膨らみが直っていない: 旗 ${旗の長さ}m に対し実際 ${合計}m`);
});

test("避けきれなかった有料の距離を返す", async (t) => {
  // ⚠️ **実機で報告された形。**「有料を避ける」にしたのに雁坂トンネルを通り、
  //    画面は何も言わなかった。`use_tolls: 0` は**重みであって禁止ではない**ので、
  //    代替路が無ければ通る。通ったことは必ず伝える。
  // ⚠️ **指示(maneuver)の旗で数えないこと。** 一部でも有料を含む指示は
  //    丸ごと有料の旗が立つ。実測: 実際は 6.8km なのに指示の旗では 28.4km（4倍）。
  //    道の区間(edge)から数えること
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(OTAKI, HIROSE,
    { displacement: "small125", avoidTolls: true, baseUrl: BASE });
  assert.ok(!r.error, r.error);
  assert.ok(typeof r.tollUnavoidableMeters === "number",
    "避けきれなかった有料の距離を返していない");
  assert.ok(r.tollUnavoidableMeters > 5_000 && r.tollUnavoidableMeters < 9_000,
    `雁坂トンネルは約6.8kmのはず: ${r.tollUnavoidableMeters}m`);
});

test("有料を完全に避けると遠回りになる", async (t) => {
  // ⚠️ **決め打ちの距離で判定しないこと。** 区間を変えると意味を失う。
  //    塞がない経路と比べる。実測（道の駅大滝温泉→広瀬ダム）: 約30km → 143.6km
  if (await skipIfDown(t)) return;
  const [ふつう, 塞ぐ] = await Promise.all([
    routeWithValhalla(OTAKI, HIROSE,
      { displacement: "small125", avoidTolls: true, baseUrl: BASE }),
    routeWithValhalla(OTAKI, HIROSE,
      { displacement: "small125", avoidTolls: true, excludeTolls: true, baseUrl: BASE }),
  ]);
  assert.ok(!ふつう.error, ふつう.error);
  assert.ok(!塞ぐ.error, 塞ぐ.error);
  assert.ok(ふつう.tollUnavoidableMeters > 0,
    "前提: 塞がなければ有料を通るはずの区間で試すこと");
  assert.strictEqual(塞ぐ.tollUnavoidableMeters, 0,
    `塞いだのに有料が ${塞ぐ.tollUnavoidableMeters}m 残っている`);
  assert.ok(塞ぐ.lengthMeters > ふつう.lengthMeters * 2,
    `遠回りになっていない: ${ふつう.lengthMeters}m → ${塞ぐ.lengthMeters}m`);
});

test("段階の一番ゆるい値は0.3より上", () => {
  // ⚠️ **実機で報告された症状。** 高速を避けると国道140号まで捨てられ、
  //    細い道へ逃げていた。実測（新座→道の駅大滝温泉→広瀬ダム・大型・有料も回避）:
  //      0.15 … 138.5km 指示43 国道140号30.4km 細い道15.6km
  //      0.3  … 139.1km 指示39 国道140号36.7km 細い道 7.4km
  //      0.5  … 135.0km 指示20 国道140号51.1km 細い道 0.3km  ← 高速は0kmのまま
  //    上限が0.3だと、この14.4kmぶんの国道に届かない。
  // ⚠️ ゆるくしても危なくない理由: 段階は1つずつ試し、高速が混ざったら
  //    そこで**却下して下の段へ落ちる**（`ridesExpressway`）。上限を上げても
  //    「高速が混ざらない一番ゆるい値」という性質は変わらない
  assert.ok(HIGHWAY_LADDER[0] > 0.3,
    `一番ゆるい段階が ${HIGHWAY_LADDER[0]} で、国道を捨てる側に寄っている`);
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

// MARK: 走る日時で規制の避け方が変わる

test("時間限定の規制は、効いていない時刻には避けない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **これが日時を渡す理由。** 二輪の規制は時間・曜日で切られていることが多い
  //    （実測: JARTIC の全国1,442件のうち388件が時間つき）。
  //    日時を渡さないと時間限定も避ける対象になり、走れる道を回り込む
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "..", "data", "road-restrictions", "saitama.json");
  if (!fs.existsSync(file)) return t.skip("埼玉の規制データが無い環境");
  const { decode } = require("../lib/polyline");
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).restrictions || [];
  const timed = saved
    .filter((r) => r.activeHours && r.kind === "noMotorcycle")
    .map((r) => ({ ...r, points: decode(r.polyline) }))
    .sort((a, b) => b.points.length - a.points.length)[0];
  if (!timed) return t.skip("時間つきの規制が無い環境");

  const p = timed.points;
  const from = p[0];
  const to = p[p.length - 1];
  const draw = (at) => routeWithValhalla(from, to,
    { variant: "normal", displacement: "large", withRoadClass: false,
      restrictions: saved.map((r) => ({ ...r })), at });

  // 22:00〜06:00 の規制。効いている時刻と、効いていない時刻で比べる
  const hours = timed.activeHours;
  const startHour = Number(hours.from.split(":")[0]);
  const inside = new Date(2026, 7, 30, (startHour + 1) % 24, 0);
  const outside = new Date(2026, 7, 30,
    (Number(hours.to.split(":")[0]) + 3) % 24, 0);

  const a = await draw(inside);
  const b = await draw(outside);
  assert.ok(!a.error && !b.error, `${a.error || b.error}`);
  assert.ok(a.restrictionTries >= b.restrictionTries,
    `効いている時刻のほうが避けていない（${a.restrictionTries} vs ${b.restrictionTries}）`);
});

test("日時を渡さなければ、時間限定でも避ける", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **走る時刻が分からないのに「いまは通れる」と決めない。**
  //    避けすぎより見落としのほうが危ない
  const { applicable } = require("../lib/restrictionAvoid");
  const timed = [{
    id: "t1", kind: "noMotorcycle", name: "試験",
    points: [[139.0, 35.0], [139.01, 35.0]],
    minCc: 0, maxCc: 99999, activeHours: { from: "22:00", to: "06:00" },
  }];
  assert.strictEqual(applicable(timed, {}).length, 1,
    "日時を渡していないのに、時間限定の規制を対象から外している");
});

// MARK: 規制を読む県

test("経路が通る県の規制を、すべて読む", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **両端の県だけでは足りない。** 実測: 東京→大阪の両端は [東京都, 大阪府] だが
  //    実際に通るのは8県で、**6県ぶんの規制を見落としていた**。
  //    ⚠️ **短い区間では確かめられない**（東京→箱根・名古屋→伊勢は両端で足りる）。
  //       長距離で試すこと
  const { PrefectureLocator } = require("../lib/prefectureLocator");
  const locator = new PrefectureLocator();
  const seen = [];
  const r = await routeWithValhalla([139.7671, 35.6812], [135.5023, 34.6937], {
    variant: "normal", displacement: "moped50", withRoadClass: false, withAdmins: false,
    restrictionsFor: (points) => {
      const step = Math.max(1, Math.floor(points.length / 400));
      const names = new Set();
      for (let i = 0; i < points.length; i += step) {
        const n = locator.locate(points[i][0], points[i][1]);
        if (n) names.add(n);
      }
      seen.push(...names);
      return { restrictions: [], prefectures: [...names] };
    },
  });
  assert.ok(!r.error, `経路が引けない: ${r.error}`);

  for (const pref of ["東京都", "神奈川県", "静岡県", "愛知県", "三重県", "大阪府"]) {
    assert.ok(seen.includes(pref), `${pref} の規制を読んでいない（読んだ県: ${seen.join(",")}）`);
  }
  assert.ok(seen.length >= 6, `${seen.length}県しか読んでいない`);
  // ⚠️ 広く取りすぎてもいけない。おすすめ道路用の円は35県を返す
  assert.ok(seen.length <= 12, `${seen.length}県は多すぎる（実際に通るのは8県）`);
});

test("長距離でも県を取り違えない（Valhalla の上限に当たらない）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **`trace_attributes` は200kmまで。** 使うと長距離で
  //    「Path distance exceeds the max distance limit: 200000 meters」になり
  //    **0県**になる（実測: 東京→大阪561kmで起きた）。県の判断に使ってはいけない
  const { adminSpans } = require("../lib/valhallaRoute");
  const res = await fetch(`${BASE}/route`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [{ lon: 139.7671, lat: 35.6812 }, { lon: 135.5023, lat: 34.6937 }],
      costing: "motorcycle",
    }),
  });
  const trip = (await res.json()).trip;
  const long = trip.legs.map((l) => l.shape).join("");
  const spans = await adminSpans(long, "motorcycle");
  assert.ok(!spans || spans.length === 0,
    "材料が悪い（200kmの上限に当たっていない。もっと長い区間で試すこと）");
});

//: 青梅。立ち寄り先を挟んだ2区間の経路を作るための起点
const OME = [139.2436, 35.7880];

test("立ち寄り先の先にある有料も測れる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **立ち寄り先(`break`)を置くと Valhalla の区間(leg)が割れる。**
  //    実測: 有料の測りを `trip.legs[0].shape` だけで掛けていたため、
  //    2区間目の雁坂トンネル6.8kmが丸ごと数えられず 0m になっていた
  //    （実機で報告: 有料を避ける設定なのに知らせも内訳も出ない）。
  // ⚠️ **`withRoadClass: false` を渡すこと。配信と同じ道筋。**
  //    渡さないと種別の内訳の方で測られてしまい、有料だけの測りを通らない
  const opts = { displacement: "small125", avoidTolls: true,
                 vias: [OTAKI], withRoadClass: false };
  const through = await routeWithValhalla(OME, HIROSE, { ...opts, stopAt: [] });
  const broken  = await routeWithValhalla(OME, HIROSE, { ...opts, stopAt: [0] });

  // 材料の確認: どちらも有料を避けられていない同じ道であること。
  // ⚠️ ここが崩れると「区間割れ」ではなく「別の道になった」を見てしまう
  assert.ok(!through.error && !broken.error, through.error || broken.error);
  assert.ok(through.tollUnavoidableMeters > 5000,
            `材料が悪い: 通るだけの版で有料が ${through.tollUnavoidableMeters}m しかない`);
  const km = (r) => r.steps.reduce((a, s) => a + s.distanceMeters, 0) / 1000;
  assert.ok(Math.abs(km(through) - km(broken)) < 1,
            `材料が悪い: 別の道になっている（${km(through).toFixed(1)} / ${km(broken).toFixed(1)}km）`);
  assert.ok(broken.steps.some((s) => s.roadKind === "toll" || s.roadKind === "expressway"),
            "材料が悪い: 有料を通る指示が1本も無い");

  // 本体①: 立ち寄り先を置いても同じだけ測れること
  assert.ok(Math.abs(broken.tollUnavoidableMeters - through.tollUnavoidableMeters) < 200,
            `立ち寄り先を置くと有料が ${broken.tollUnavoidableMeters}m になる`
            + `（通るだけなら ${through.tollUnavoidableMeters}m）`);

  // 本体②: **正しい指示に付いていること。**
  //    ⚠️ 合計だけ見ても番号の付け直しの誤りは見つからない（合計は番号に依らない）。
  //       区間の中の番号のまま繋ぐと、2区間目の有料が1区間目の下道の指示に付く
  const 付いた = broken.steps.filter((s) => s.tollMeters > 0);
  assert.ok(付いた.length > 0, "立ち寄り先を置くと指示ごとの tollMeters が全部落ちる");
  const よそ = 付いた.filter((s) => s.roadKind !== "toll" && s.roadKind !== "expressway");
  assert.equal(よそ.length, 0,
    `有料でない指示に有料が付いている: ${よそ.map((s) => `${s.roadName || s.maneuver}=${s.tollMeters}m`).join(" / ")}`);
  const 合計 = 付いた.reduce((a, s) => a + s.tollMeters, 0);
  assert.ok(Math.abs(合計 - broken.tollUnavoidableMeters) < 300,
            `指示ごとの合計 ${合計}m が全体の ${broken.tollUnavoidableMeters}m と合わない`);
});

test("立ち寄り先の先でも県が分かる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 県は**読み上げ名を決めるのに要る**（「県道36号線」か「都道36号線」か）。
  //    実測: 県も `trip.legs[0].shape` だけで測っていたため、立ち寄り先より後ろの
  //    指示は 5本中4本が県なしになり、**山梨県が一度も出てこなかった**
  const r = await routeWithValhalla(OME, HIROSE,
    { displacement: "small125", vias: [OTAKI], stopAt: [0], withRoadClass: false });
  assert.ok(!r.error, r.error);

  // 材料の確認: 立ち寄り先で区間が割れ、その先にも指示が残っていること
  const 割れ = r.steps.findIndex((s) => s.isLegEnd) + 1;
  assert.ok(割れ > 0, "材料が悪い: 区間が割れていない");
  const 後ろ = r.steps.slice(割れ);
  assert.ok(後ろ.length >= 3, `材料が悪い: 立ち寄り先の先の指示が ${後ろ.length} 本しかない`);

  // 本体: 先の指示にも県が付き、またいだ先の県（山梨）が出ること
  const 県なし = 後ろ.filter((s) => !s.prefecture);
  assert.equal(県なし.length, 0,
    `立ち寄り先の先で県が分からない指示が ${県なし.length}/${後ろ.length} 本ある`);
  assert.ok(r.steps.some((s) => s.prefecture === "山梨県"),
            `県をまたいだ先が出ていない: ${[...new Set(r.steps.map((s) => s.prefecture))].join(",")}`);
});

test("立ち寄り先の先にある有料も塞いで避けられる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 塞ぎ直し(`excludeTolls`)も `trip.legs[0].shape` だけを見ていた。
  //    立ち寄り先の先にある有料は塞がれず、遠回りを選んでも通ってしまう
  const opts = { displacement: "small125", avoidTolls: true,
                 vias: [OTAKI], stopAt: [0], withRoadClass: false };
  const 素 = await routeWithValhalla(OME, HIROSE, opts);
  const 遠回り = await routeWithValhalla(OME, HIROSE, { ...opts, excludeTolls: true });

  // 材料の確認: 素の方は避けられていないこと（避けられていたら検査にならない）
  assert.ok(!素.error && !遠回り.error, 素.error || 遠回り.error);
  assert.ok(素.tollUnavoidableMeters > 5000,
            `材料が悪い: 素の版で有料が ${素.tollUnavoidableMeters}m しかない`);

  // 本体: 塞げば有料を通らないこと
  assert.equal(遠回り.tollUnavoidableMeters, 0,
    `塞いでも有料が ${遠回り.tollUnavoidableMeters}m 残る`);
  assert.equal(遠回り.steps.filter((s) => s.roadKind === "toll").length, 0,
    "塞いでも有料の指示が残る");
  // ⚠️ 遠回りになっている（＝別の道を引いている）ことも見る。
  //    同じ距離のまま0mになったら、測れていないだけ
  const km = (r) => r.steps.reduce((a, s) => a + s.distanceMeters, 0) / 1000;
  assert.ok(km(遠回り) > km(素) * 1.2,
            `遠回りしていない（${km(素).toFixed(1)} → ${km(遠回り).toFixed(1)}km）`);
});

test("左側に到着させても有料の塞ぎが外れない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **塞いだ囲いは、そのあとの引き直しでも残すこと。**
  //    有料を塞いで引き直したあと `body.exclude_polygons` を元に戻していたため、
  //    後ろに続く「左側に到着」の引き直しが**塞ぎ無しで**引き、
  //    しかも受け入れの条件が「遠回りより2km以上長くなければ採る」なので
  //    **短いトンネル経由が必ず採られていた**（実測 206.6km/0m → 92.7km/6811m）。
  //    ⚠️ アプリは `arriveOnNearSide: true` を**常に**渡す。ここを外して測らないこと。
  const 基 = { displacement: "small125", avoidTolls: true, vias: [OTAKI], stopAt: [0],
               withRoadClass: false, excludeTolls: true };
  const 素通り = await routeWithValhalla(OME, HIROSE, { ...基, arriveOnNearSide: false });
  const 左側   = await routeWithValhalla(OME, HIROSE, { ...基, arriveOnNearSide: true });
  assert.ok(!素通り.error && !左側.error, 素通り.error || 左側.error);

  // 材料の確認: 左側指定なしなら避けられていること（避けられないなら検査にならない）
  assert.equal(素通り.tollUnavoidableMeters, 0,
    `材料が悪い: 左側指定なしでも有料が ${素通り.tollUnavoidableMeters}m 残る`);

  // 本体: 左側に着けようとしても有料へ戻らないこと
  assert.equal(左側.tollUnavoidableMeters, 0,
    `左側に到着させると有料が ${左側.tollUnavoidableMeters}m 戻る`);
  const km = (r) => r.steps.reduce((a, s) => a + s.distanceMeters, 0) / 1000;
  assert.ok(Math.abs(km(左側) - km(素通り)) < km(素通り) * 0.2,
    `左側に到着させると別の（短い）道に戻る（${km(素通り).toFixed(1)} → ${km(左側).toFixed(1)}km）`);
});

test("規制を避けて引き直しても有料の塞ぎが外れない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 実機の経路は「自前（規制を避ける）」。規制の引き直しも
  //    `body.exclude_polygons` を土台にするので、有料の塞ぎを外すとここでも戻る。
  const 基 = { displacement: "small125", avoidTolls: true, vias: [OTAKI], stopAt: [0],
               withRoadClass: false, arriveOnNearSide: true, excludeTolls: true };
  // ⚠️ 下見は**左側指定なし**で引く。材料の確認が「左側に到着」の直しに
  //    巻き添えを食うと、規制の道筋を見ているつもりで別の直しを見てしまう
  const 下見 = await routeWithValhalla(OME, HIROSE, { ...基, arriveOnNearSide: false });
  assert.ok(!下見.error, 下見.error);
  assert.equal(下見.tollUnavoidableMeters, 0, "材料が悪い: 規制なしでも有料が残る");

  // ⚠️ 引けた線の一部をそのまま規制にすれば必ず掛かる（実物の規制に頼らない）。
  //    `kind` が無いと `applicable` に弾かれて**掛からない**（0件になる）
  const i = Math.floor(下見.points.length * 0.75);
  const 規制 = [{ id: "t1", name: "試しの規制", kind: "closed",
                  prefecture: "山梨県", verified: true,
                  points: 下見.points.slice(i, i + 40) }];
  const r = await routeWithValhalla(OME, HIROSE, { ...基,
    restrictionsFor: async () => ({ restrictions: 規制, prefectures: ["山梨県"] }) });
  assert.ok(!r.error, r.error);

  // 材料の確認: 実際に引き直しが起きたこと（起きなければ検査になっていない）
  assert.ok(r.restrictionTries > 0, "材料が悪い: 規制の引き直しが起きていない");

  // 本体: 引き直しても有料へ戻らないこと
  assert.equal(r.tollUnavoidableMeters, 0,
    `規制を避けて引き直すと有料が ${r.tollUnavoidableMeters}m 戻る`);
});


test("一部が高速なだけの指示を丸ごと高速に数えない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **`maneuver.highway` は一部でも含めば丸ごと立つ**（`toll` と同じ）。
  //    実測（新座→道の駅大滝温泉→広瀬ダム・251cc・有料と高速を避ける）:
  //    「140を直進です 27.2km」の中身は **motorway 9.2km ＋ trunk 17.9km**。
  //    旗のまま塗ると普通の国道140号17.9kmまで高速の色になる（実機で報告）。
  const r = await routeWithValhalla(NIIZA, HIROSE, {
    displacement: "large", avoidTolls: true, avoidHighways: true,
    vias: [OTAKI], stopAt: [0], withRoadClass: false,
    arriveOnNearSide: true, excludeTolls: true });
  assert.ok(!r.error, r.error);

  // 材料の確認: 旗の立った長い指示が実際にあること
  const 旗 = r.steps.filter((s) => s.roadKind === "expressway");
  const 旗のm = 旗.reduce((a, s) => a + s.distanceMeters, 0);
  assert.ok(旗のm > 20_000,
    `材料が悪い: 高速の旗が立った指示が ${(旗のm / 1000).toFixed(1)}km しかない`);

  // 本体①: 種別ごとの距離は**区間**から数えること
  assert.ok(r.kindMeters.expressway < 旗のm * 0.6,
    `旗のまま数えている（旗 ${(旗のm / 1000).toFixed(1)}km に対し `
    + `${(r.kindMeters.expressway / 1000).toFixed(1)}km）`);
  assert.ok(r.kindMeters.expressway > 5_000,
    `本当の高速まで消している（${r.kindMeters.expressway}m）`);

  // 本体②: 線を塗り分けるための区間が返ること
  const 高速の区間 = (r.kindSpans || []).filter((sp) => sp.kind === "expressway");
  assert.ok(高速の区間.length > 0, "高速の区間が返っていない（線を塗り分けられない）");
  assert.equal(高速の区間.reduce((a, sp) => a + sp.meters, 0), r.kindMeters.expressway,
    "区間の合計と種別ごとの距離が食い違う");
  for (const sp of r.kindSpans) {
    assert.ok(sp.end > sp.begin && sp.end < r.points.length,
      `区間の番号が線の外を指している: ${sp.begin}-${sp.end} / 点${r.points.length}`);
  }

  // 本体③: 指示ごとの内訳も旗のままにしない
  const st = 旗[0];
  assert.ok(st.expresswayMeters != null && st.expresswayMeters < st.distanceMeters * 0.6,
    `指示の内訳が旗のまま（${st.expresswayMeters} / ${st.distanceMeters}）`);
});

test("下道だけの経路では区間を測りに行かない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 区間を測るのは `/trace_attributes` が1回増える。要らないところで呼ばない
  const r = await routeWithValhalla(KOFU, FUJI,
    { displacement: "large", avoidTolls: true, avoidHighways: true, withRoadClass: false });
  assert.ok(!r.error, r.error);
  assert.ok(r.steps.every((s) => s.roadKind === "surface"),
    "材料が悪い: 下道だけの経路になっていない");
  assert.equal((r.kindSpans || []).length, 0, "要らないのに区間を測っている");
  assert.ok(r.kindMeters.surface > 0, "下道の距離が0になっている");
});

//: 高崎 → 草津。⚠️ 峠越えなので、線が自分の近くへ戻るヘアピンが必ず出る
const TAKASAKI = [139.0130, 36.3219];
const KUSATSU  = [138.5470, 36.6210];

test("峠のヘアピンを無駄な輪と決めつけない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **形だけでは見分けられない。** ヘアピンは無駄な輪とまったく同じ形に見える
  //    （60m以内を200m走って通り過ぎる）。実測で、大きさ・おすすめ道路の上か・
  //    入口と出口の向きの差——いずれでも分けられなかった。
  //    見分けられるのは「入口から出口へ直接引けるか」だけ。
  //    実測: ヘアピンは直接引いても0.99〜1.00倍、無駄な輪は0.00倍。
  const routeLoops = require("../lib/routeLoops");
  const r = await routeWithValhalla(TAKASAKI, KUSATSU,
    { displacement: "large", avoidTolls: true, avoidHighways: true });
  assert.ok(!r.error, r.error);

  // 材料の確認: 形のうえでは輪に見えるものが実際にあること
  const 見た目 = routeLoops.loops(r.points);
  assert.ok(見た目.length > 0,
    "材料が悪い: 形のうえで輪に見えるものが1つも無い（この経路では見分けを試せない）");

  // 本体: どれも無駄とは判定しないこと（＝経路を壊さない）
  assert.equal(r.wastefulLoops, 0,
    `ヘアピン ${見た目.length} 本のうち ${r.wastefulLoops} 本を無駄と決めつけている`);
  const km = r.steps.reduce((a, s) => a + s.distanceMeters, 0) / 1000;
  assert.ok(km > 65 && km < 80,
    `経路が壊れている（${km.toFixed(1)}km。塞ぐと172.8kmになった記録がある）`);
});

test("無駄な輪の見分けに使う確かめが重すぎない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 輪1本につき短い経路を1回引く。全部の経路で毎回走るので、
  //    重いと生成そのものが遅くなる。実測 1本 7〜13ms
  const started = Date.now();
  const r = await routeWithValhalla(TAKASAKI, KUSATSU,
    { displacement: "large", avoidTolls: true, avoidHighways: true });
  assert.ok(!r.error, r.error);
  const 秒 = (Date.now() - started) / 1000;
  assert.ok(秒 < 3, `1本引くのに ${秒.toFixed(1)}秒かかっている`);
});

/**
 * 実機で報告された「おすすめ道路を抜けてすぐ同じ道の反対車線を戻る」経路。
 *
 * ⚠️ **条件だけでは同じ経路にならない。** アプリのおすすめ道路の選び方は
 *    5本上限＋ランダムを含むので、同じ出発・行き先で引いても別の道になる
 *    （実測: 実機131.1km に対し手元では90〜94kmまでしか出なかった）。
 *    アプリが**実際に渡した経由地**を焼き込んである。
 */
const FUN_LOOPS = require("./fixtures-fun-loops.json");

test("おすすめ道路を抜けてすぐ戻る形を残さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 利用者の方針:「おすすめ道路は上りか下りのどちらか一度だけ通って、
  //    出口からそのまま進む。同じ道を戻ってよいのは立ち寄り先へ寄るときだけ」。
  //    ⚠️ **立ち寄り先が無い経路なので、おすすめ道路の中継点は守らない。**
  //       ここで中継点まで守ると1本も見つからない（実測: v12でそうなっていた）
  const routeLoops = require("../lib/routeLoops");
  const 基 = {
    displacement: FUN_LOOPS["排気量"],
    avoidTolls: FUN_LOOPS["有料を避ける"],
    avoidHighways: FUN_LOOPS["高速を避ける"],
    stopAt: FUN_LOOPS["立ち寄り先の番号"],
    arriveOnNearSide: true, variant: "fun", withRoadClass: false,
  };
  const 北 = FUN_LOOPS["候補"].find((k) => k["要約"].startsWith("北まわり"));
  assert.ok(北, "材料が悪い: 北まわりの案が焼かれていない");

  const r = await routeWithValhalla(FUN_LOOPS["出発"], FUN_LOOPS["行き先"],
    { ...基, vias: 北["経由地"] });
  assert.ok(!r.error, r.error);
  assert.ok(r.steps.length > 20, `材料が悪い: 指示が ${r.steps.length} 本しかない`);

  // 材料の確認: この経路には実際に戻る形があること（無ければ検査にならない）
  assert.ok(r.wastefulLoops > 0,
    "戻る形を1本も見つけていない（中継点まで守っていないか）");
  // 数え方が壊れていないこと（消した数が見つけた数を超えない）
  assert.ok(r.wastefulLoopsDropped <= r.wastefulLoops,
    `見つけ${r.wastefulLoops}／消せ${r.wastefulLoopsDropped} と辻褄が合わない`);

  // 本体: 仕上がった経路に、守られていない戻る形が残っていないこと。
  //   ⚠️ 残るなら場所を返し、かつ原因のおすすめ道路が近くにあること
  //      （アプリがその道を外す。2,000m以内でなければ外す相手が居ない）
  const 守る = routeLoops.viasToKeep(北["経由地"], FUN_LOOPS["立ち寄り先の番号"]);
  const 全長 = r.steps.reduce((a, s2) => a + s2.distanceMeters, 0);
  const 残り = [];
  for (const l of routeLoops.loopBands(r.points, 全長)) {
    if (routeLoops.holdsVia(r.points, l, 守る)) continue;
    const 直 = await routeWithValhalla(r.points[l.begin], r.points[l.end],
      { displacement: FUN_LOOPS["排気量"], avoidTolls: true, avoidHighways: true,
        withAdmins: false, withRoadClass: false, dropWastefulLoops: false });
    const m = 直 && !直.error
      ? 直.steps.reduce((a2, s2) => a2 + s2.distanceMeters, 0) : null;
    if (routeLoops.isWasteful(l.meters, m)) 残り.push(l);
  }
  if (残り.length) {
    assert.ok((r.wastefulLoopSpans || []).length > 0,
      `戻る形が ${残り.length}本 残っているのに場所を返していない`);
    const 端 = 北["おすすめ道路"].flatMap((m) => [[m["入口"][0], m["入口"][1]],
                                                  [m["出口"][0], m["出口"][1]]]);
    const 当たり = r.wastefulLoopSpans.some((w) =>
      [w.begin, w.end].some((i) => 端.some((e) =>
        routeLoops.distance(r.points[i], e) <= 2_000)));
    assert.ok(当たり, "残った輪の2,000m以内におすすめ道路が無い（外す相手が居ない）");
  }
});

test("別の道も一緒に返る", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ Google のように選ばせるため。⚠️ **塞ぎ（規制・有料・無駄な輪）と併用できる**
  //    ので、代替も安全側を通っている（実測: 塞いだ場所を3本とも通らなかった）
  const r = await routeWithValhalla(NIIZA, [139.2621, 35.5541], {
    displacement: "large", avoidTolls: true, avoidHighways: true,
    arriveOnNearSide: true, alternates: 2 });
  assert.ok(!r.error, r.error);
  assert.ok(Array.isArray(r.alternates) && r.alternates.length >= 1,
    `別の道が ${(r.alternates || []).length} 本しか返っていない`);

  // 本体①: 代替も「使える経路」になっていること（指示・線・種別が揃う）
  for (const a of r.alternates) {
    assert.ok(a.steps.length > 5, `代替の指示が ${a.steps.length} 件しかない`);
    assert.ok(a.points.length > 100, `代替の線の点が ${a.points.length} 個しかない`);
    assert.ok(a.steps.every((s) => s.maneuver), "代替に maneuver の無い指示がある");
    assert.ok(a.lengthMeters > 0 && a.durationSeconds > 0, "代替の距離・時間が空");
  }

  // 本体②: 本命と**違う道**であること（同じものを並べても選べない）
  const km = (x) => x.lengthMeters / 1000;
  const 違う = r.alternates.some((a) => Math.abs(km(a) - km(r)) > 0.5);
  assert.ok(違う,
    `本命 ${km(r).toFixed(1)}km と代替 ${r.alternates.map((a) => km(a).toFixed(1)).join(",")}km が同じ`);
});

test("立ち寄り先があるときは別の道を返さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **Valhalla の性質**（設定では変えられない）。実測で1本だけだった。
  //    頼んでも無駄なので、2点のときだけ付ける
  const r = await routeWithValhalla(NIIZA, HIROSE, {
    displacement: "large", avoidTolls: true, avoidHighways: true,
    vias: [OTAKI], alternates: 2 });
  assert.ok(!r.error, r.error);
  assert.ok(!r.alternates || r.alternates.length === 0,
    `立ち寄り先があるのに別の道が ${(r.alternates || []).length} 本返っている`);
});

// MARK: - 所要時間を実際の走りに近づける

test("下道の所要時間が生の Valhalla より長くなる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **実機で報告された壊れ方。** maxspeed 未登録の国道に 90km/h が当たり、
  //    372.3km を 402分（平均55.5km/h）と見積もっていた。
  //    実際に動いていたのは617分（平均39.1km/h）
  const r = await routeWithValhalla(KOFU, FUJI,
    { displacement: "large", costing: "motorcycle", withRoadClass: false,
      withAdmins: false, avoidHighways: true, avoidTolls: true, excludeTolls: true });
  assert.ok(r, "経路が引けない");
  assert.ok(r.timeAdjust, "補正の記録が無い（組み込みが外れている）");
  // 材料の確認: 生の見積りが実際に楽観的であること
  const kmhRaw = (r.lengthMeters / 1000) / (r.timeAdjust.rawSeconds / 3600);
  assert.ok(kmhRaw > 45,
            `この道は元から遅く、検査の材料にならない: ${kmhRaw.toFixed(1)}km/h`);
  assert.ok(r.durationSeconds > r.timeAdjust.rawSeconds,
            `補正が効いていない: ${r.timeAdjust.rawSeconds}s → ${r.durationSeconds}s`);
  const kmh = (r.lengthMeters / 1000) / (r.durationSeconds / 3600);
  assert.ok(kmh <= 46, `下道なのに速すぎる: ${kmh.toFixed(1)}km/h`);
});

test("合計と指示ごとの時間がずれない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **画面は区間ごとの合計を足して出す。** 合計だけ直すと内訳と合わなくなり、
  //    到着予定と各区間の足し算が食い違う
  const r = await routeWithValhalla(KOFU, FUJI,
    { displacement: "large", costing: "motorcycle", withRoadClass: false,
      withAdmins: false, avoidHighways: true, avoidTolls: true, excludeTolls: true });
  assert.ok(r, "経路が引けない");
  const sum = r.steps.reduce((a, st) => a + st.durationSeconds, 0);
  assert.strictEqual(r.durationSeconds, sum,
                     `合計 ${r.durationSeconds}s と内訳の総和 ${sum}s が違う`);
  assert.ok(r.steps.length > 3, "指示が少なすぎて検査にならない");
});

test("高速を使う経路の時間はほとんど変えない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **高速は実際に速く走れる。** ここまで遅くすると、高速を使う意味が消える。
  //    実測: 東京→名古屋（高速あり）は +1分しか変わらない
  const TOKYO = [139.7006, 35.6896], NAGOYA = [136.8816, 35.1709];
  const r = await routeWithValhalla(TOKYO, NAGOYA,
    { displacement: "large", costing: "motorcycle", withRoadClass: false,
      withAdmins: false });
  assert.ok(r, "経路が引けない");
  // 材料の確認: ちゃんと高速を使っていること
  const fastM = r.steps.filter((st) => st.roadKind !== "surface")
                       .reduce((a, st) => a + st.distanceMeters, 0);
  assert.ok(fastM > r.lengthMeters * 0.5,
            `高速をほとんど使っておらず検査にならない: ${(fastM / 1000).toFixed(0)}km`);
  const ratio = r.durationSeconds / r.timeAdjust.rawSeconds;
  assert.ok(ratio < 1.05,
            `高速なのに ${((ratio - 1) * 100).toFixed(0)}% も伸びている`);
});
