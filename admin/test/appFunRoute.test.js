"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const F = require("../lib/appFunRoute");
const { createDeliveredRoads } = require("../lib/deliveredRoads");
const { encode } = require("../lib/polyline");

/**
 * 調整ツールで、おすすめ道路を**アプリと同じ選び方**で選ぶ（`lib/appFunRoute.js`）と、
 * **本番に配信中のデータ**を読む（`lib/deliveredRoads.js`）。
 *
 * ⚠️ 利用者の要望（2026-09-28）:「web でおすすめ道路などの現在のも選択できるようにしたい（web だけだとわからない）」。
 * ⚠️ **いちばん大事なのは、アプリの実物と同じ答えになること。** 材料（fixtures-app-fun-parity.json）は、
 *    アプリの `FunRouteBuilder`（Swift）に同じ入力を渡して出させた答え。ずれたら移し方の誤りか、
 *    アプリ側が変わったか（そのときは材料を作り直す）
 */

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const parity = JSON.parse(read("test", "fixtures-app-fun-parity.json"));
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const dump = (r) => (r ? { ids: r.segments.map((s) => s.id), waypoints: r.waypoints.map((p) => [r5(p[0]), r5(p[1])]),
                           detour: Math.round(r.detourRatio * 1000) / 1000 } : null);

// MARK: アプリの実物との突き合わせ

test("アプリの FunRouteBuilder と同じ道・同じ順・同じ経由地を選ぶ（6区間×まわり方4・たっぷり・ひかえめ）", () => {
  assert.strictEqual(parity.trips.length, 6, "材料が足りない");
  for (const t of parity.trips) {
    const common = { origin: t.from, destination: t.to, segments: t.segments, funWeight: t.funWeight,
                     baselineMeters: t.baselineMeters, referenceAxis: t.referenceAxis, choose: F.topChoice };
    for (const side of F.SIDE_ORDER) {
      assert.deepStrictEqual(dump(F.build({ ...common, side })), t.expected[`side:${side}`], `${t.name} ${side}まわり`);
    }
    assert.deepStrictEqual(dump(F.build(common)), t.expected.generous, `${t.name} たっぷり`);
    assert.deepStrictEqual(dump(F.build({ ...common, kind: "modest",
      budgetRatio: Math.min(F.MODEST_DETOUR_RATIO, F.detourBudgetRatio(t.funWeight)) })), t.expected.modest, `${t.name} ひかえめ`);
  }
});

// ⚠️ 利用者の判断（2026-10-03）:「ルート生成時に、おすすめ道路の札で林道ぎみは選択されないようにする」
test("林道ぎみ・砂利道の札が付いた道は、点数の高い峠でもどの案にも選ばない（6区間×まわり方4・たっぷり）", () => {
  let near = 0;
  for (const t of parity.trips) {
    const forest = new Set(t.segments.filter((s) => (s.tags || []).some((x) => x === "forest" || x === "gravel"))
      .map((s) => s.id));
    near += forest.size;
    const common = { origin: t.from, destination: t.to, segments: t.segments, funWeight: t.funWeight,
                     baselineMeters: t.baselineMeters, referenceAxis: t.referenceAxis, choose: F.topChoice };
    for (const r of [...F.SIDE_ORDER.map((side) => F.build({ ...common, side })), F.build(common)]) {
      const picked = r ? r.segments.filter((s) => forest.has(s.id)).map((s) => s.name) : [];
      assert.deepStrictEqual(picked, [], `${t.name}: 林道ぎみ・砂利道の道を選んだ`);
    }
  }
  assert.ok(near >= 10, `材料が悪い（林道ぎみの道が ${near} 本しかない）`);
});

test("規制と重なって外れる道がアプリと同じ（大型・原付一種）", () => {
  const c = parity.restrictionCase;
  for (const d of ["large", "moped50"]) {
    const got = c.segments.filter((s) => F.isBlockedByRestrictions(F.polylineOf(s), c.restrictions, d, undefined))
      .map((s) => s.id);
    assert.deepStrictEqual(got, c.expected[d], `${d}: 外れる道がアプリと違う`);
  }
  assert.ok(c.expected.moped50.length > c.expected.large.length, "材料が悪い: 原付のほうが多く外れるはず");
});

// MARK: 部品

test("つまみ → 寄り道の倍率（アプリの NavRoutePreference と同じ）", () => {
  assert.strictEqual(F.detourBudgetRatio(0), 1.0, "入れていないのに寄り道する");
  assert.strictEqual(F.detourBudgetRatio(0.005), 1.0);
  assert.ok(Math.abs(F.detourBudgetRatio(0.01) - (1.1 + 1.9 * 0.01)) < 1e-9, "入れたら最低1.1倍から");
  assert.ok(Math.abs(F.detourBudgetRatio(0.5) - 2.05) < 1e-9);
  assert.strictEqual(F.detourBudgetRatio(1), 3.0);
  assert.strictEqual(F.detourBudgetRatio(2), 3.0, "全開を超えた");
  // つまみ0なら、選べる道があっても選ばない
  const segs = [roadAt("a", 35.02, 90), roadAt("b", 35.08, 88)];
  assert.ok(F.build({ origin: [139.0, 35.0], destination: [139.0, 35.2], segments: segs, funWeight: 1 }), "材料が悪い");
  assert.strictEqual(F.build({ origin: [139.0, 35.0], destination: [139.0, 35.2], segments: segs, funWeight: 0 }), null,
    "つまみ0なのに楽しい道を選んだ");
});

/** 北へまっすぐの旅の横に並べた道（曲率は十分・長さ3km） */
function roadAt(id, lat, score, o = {}) {
  const start = [lat, 139.0 + (o.lngOffset ?? 0.01)], end = [lat + 0.027, 139.0 + (o.lngOffset ?? 0.01)];
  return { id, name: id, score, curviness: o.curviness ?? 400, lengthKm: 3, tags: o.tags,
           start, end, polyline: encode([[start[1], start[0]], [end[1], end[0]]]) };
}

test("同じくらい良い道（点数の差8以内・5本まで）からランダムに選ぶ", () => {
  const segments = [roadAt("a", 35.02, 90), roadAt("b", 35.05, 89), roadAt("c", 35.08, 84),
                    roadAt("d", 35.11, 81), roadAt("e", 35.14, 70)];
  const pools = [];
  const choose = (pool) => { pools.push(pool.map((s) => s.id)); return pool[0]; };
  F.build({ origin: [139.0, 35.0], destination: [139.0, 35.2], segments, funWeight: 1, choose });
  assert.deepStrictEqual(pools[0], ["a", "b", "c"], "点数の差が8を超える道まで母数に入れた／近い道を落とした");
  assert.ok(pools.length >= 2, "2本目を選んでいない");
  // 6本以上同じくらい良い道があっても母数は5本
  const many = Array.from({ length: 8 }, (_, i) => roadAt(`m${i}`, 35.01 + i * 0.02, 90 - i * 0.5));
  const seen = [];
  F.build({ origin: [139.0, 35.0], destination: [139.0, 35.2], segments: many, funWeight: 1,
            choose: (pool) => { seen.push(pool.length); return pool[0]; } });
  assert.strictEqual(seen[0], 5, "母数を5本で打ち切っていない（アプリは5本）");
  // 既定はランダム（毎回同じとは限らない）: 何度か引いて2通り以上出る
  const firsts = new Set();
  for (let i = 0; i < 40; i++) {
    const r = F.build({ origin: [139.0, 35.0], destination: [139.0, 35.2], segments, funWeight: 1, maxSegmentCount: 1 });
    firsts.add(r.segments[0].id);
  }
  assert.ok(firsts.size >= 2, "ランダムに選んでいない（アプリは毎回違う道になる）");
});

test("札の付いた道は曲率の下限を緩める・最大5本", () => {
  const plain = roadAt("p", 35.05, 90, { curviness: 200 });
  const tagged = roadAt("t", 35.05, 90, { curviness: 200, tags: ["scenic"] });
  const direct = 22_000;
  assert.strictEqual(F.isWithinCorridor(plain, [139.0, 35.0], [139.0, 35.2], direct, null, 1), false,
    "曲率200の札なしの道を通した");
  assert.strictEqual(F.isWithinCorridor(tagged, [139.0, 35.0], [139.0, 35.2], direct, null, 1), true,
    "札の付いた道を曲率で落とした");
  const many = Array.from({ length: 8 }, (_, i) => roadAt(`m${i}`, 35.01 + i * 0.02, 90));
  const r = F.build({ origin: [139.0, 35.0], destination: [139.0, 35.2], segments: many, funWeight: 1, choose: F.topChoice });
  assert.strictEqual(r.segments.length, 5, "5本を超えて選んだ／足りない");
});

test("ルート候補画面と同じ組み合わせ: まわり方を先に・予算違いは2案まで・同じ顔ぶれはまとめる", () => {
  const t = parity.trips.find((x) => x.name === "新座→愛川");
  const out = F.appFunVariants({ origin: t.from, destination: t.to, segments: t.segments, funWeight: 0.5,
                                 baselineMeters: t.baselineMeters, referencePolyline: t.referenceAxis, choose: F.topChoice });
  const kinds = out.variants.map((v) => (v.sides.length ? `side:${v.sides.join("+")}` : v.kind));
  assert.ok(kinds.length >= 2, "材料が悪い");
  const firstBudget = kinds.findIndex((k) => !k.startsWith("side:"));
  assert.ok(firstBudget === -1 || kinds.slice(firstBudget).every((k) => !k.startsWith("side:")), "まわり方より先に予算違いを並べた");
  assert.ok(!kinds.includes("alternate") && !kinds.includes("wide"), "ルート候補画面に無い案（別ルート・もっと寄り道）を出した");
  const lineups = out.variants.map((v) => v.segments.map((s) => s.id).sort().join("|"));
  assert.strictEqual(new Set(lineups).size, lineups.length, "同じ顔ぶれの案を並べた");
  assert.ok(out.common && out.common.baselineMeters === t.baselineMeters, "選び直しに使う条件を返していない");
});

test("規制と重なる道を候補から外す（渡したときだけ）", () => {
  const c = parity.restrictionCase;
  const t = parity.trips.find((x) => x.name === c.name);
  const blocked = new Set(c.expected.moped50);
  const args = { origin: t.from, destination: t.to, segments: c.segments, funWeight: 1, baselineMeters: t.baselineMeters,
                 referencePolyline: t.referenceAxis, displacement: "moped50", choose: F.topChoice };
  const withR = F.appFunVariants({ ...args, restrictions: c.restrictions });
  assert.strictEqual(withR.blockedCount, blocked.size, "外した本数が違う");
  assert.ok(withR.variants.every((v) => v.segments.every((s) => !blocked.has(s.id))), "規制と重なる道を選んだ");
  assert.strictEqual(F.appFunVariants({ ...args, restrictions: [] }).blockedCount, 0);
});

test("ふつうのルートの線を間引いて進み具合の軸にする（アプリの directionAxis）", () => {
  // 222km（1,000点・点の間隔222m）→ 間隔 全長÷400＝555m を超えるたびに残すので3点ごと（334点）
  const line = Array.from({ length: 1000 }, (_, i) => [139.0, 35.0 + i * 0.002]);
  const axis = F.directionAxis(line);
  assert.ok(axis.length <= 402 && axis.length >= 300, `長い線の点の数 ${axis.length}（400点ほどに収まっていない）`);
  assert.deepStrictEqual(axis[0], line[0]);
  assert.deepStrictEqual(axis[axis.length - 1], line[line.length - 1], "終点を落とした");
  // 11km（1,000点）→ 最低250m間隔なので45点ほど
  const dense = Array.from({ length: 1000 }, (_, i) => [139.0, 35.0 + i * 0.0001]);
  const thin = F.directionAxis(dense);
  assert.ok(thin.length >= 40 && thin.length <= 50, `短い線の点の数 ${thin.length}（250m間隔になっていない）`);
  const short = line.slice(0, 300);
  assert.strictEqual(F.directionAxis(short), short, "400点以下なのに間引いた");
});

const KM_LAT = 1 / 111.195;             // 緯度1km
const KM_LNG = 1 / (111.195 * Math.cos(35 * Math.PI / 180));   // 北緯35度の経度1km
const at = (eastKm, northKm) => [139.0 + eastKm * KM_LNG, 35.0 + northKm * KM_LAT];
/** 点の並び（[経度, 緯度]）から区間を作る */
function roadFrom(id, points, o = {}) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot((points[i][0] - points[i - 1][0]) / KM_LNG, (points[i][1] - points[i - 1][1]) / KM_LAT);
  const first = points[0], last = points[points.length - 1];
  return { id, name: id, score: o.score ?? 80, curviness: 400, lengthKm: len,
           start: [first[1], first[0]], end: [last[1], last[0]], polyline: encode(points) };
}

test("幅: 直線距離の3割・25km・区間の長さ×3（下限5km）の いちばん厳しいもの", () => {
  // 北へ22km の旅。3km の道なら許す横ズレは min(22×0.3=6.6km, max(5km, 9km)) = 6.6km
  const origin = at(0, 0), destination = at(0, 22);
  const road = (east) => roadFrom(`e${east}`, [at(east, 10), at(east, 13)]);
  assert.strictEqual(F.isWithinCorridor(road(6), origin, destination, 22_000, null, 1), true, "6km 横の道を落とした");
  assert.strictEqual(F.isWithinCorridor(road(8), origin, destination, 22_000, null, 1), false, "8km 横の道を通した（幅が広すぎる）");
  // 「もっと寄り道」だけは幅を2倍に
  assert.strictEqual(F.isWithinCorridor(road(8), origin, destination, 22_000, null, 2), true);
});

test("区間の入口: 道の上にいるときは直線ではなく道沿いの距離で選ぶ", () => {
  // 東へ5km 行って折り返し、500m 北を西へ戻る道（S は南西の端、E は北西の端）。
  // 戻る側の、E の100m 手前の道の上から北（20km 先）へ向かう。
  // 直線なら S も E もすぐそば（0.5km と 0.1km）だが、道沿いでは S まで10km 以上ある → E から入る
  const road = roadFrom("fold", [at(0, 0), at(5, 0), at(5, 0.5), at(0, 0.5)]);
  const cursor = at(0.1, 0.5);
  const t = F.traversal(road, cursor, at(0, 20), at(0, -1), at(0, 20), null);
  assert.ok(t, "入口が決まらない");
  const endPoint = [road.end[1], road.end[0]];
  assert.ok(Math.abs(t.entry[0] - endPoint[0]) < 1e-9 && Math.abs(t.entry[1] - endPoint[1]) < 1e-9,
    `道沿いで近い E から入っていない（入口 ${t.entry}）`);
  // 道から2km より離れているときは直線で比べる（道沿いの距離が当てにならない）
  const far = F.traversal(road, at(-3, 0.25), at(0, 20), at(-3, -1), at(0, 20), null);
  assert.ok(far, "離れているときに入口が決まらない");
});

test("まわり方: 軸の真上の道は方角を持たない・半平面で見る", () => {
  const origin = at(0, 0), destination = at(0, 22);
  assert.strictEqual(F.sideBearing(roadFrom("on", [at(0, 9), at(0, 12)]), origin, destination, null), null,
    "軸の真上の道に方角を付けた（誤差でどちらにも倒れる）");
  const east = F.sideBearing(roadFrom("east", [at(2, 9), at(2, 12)]), origin, destination, null);
  assert.ok(Math.abs(east - 90) < 1, `東の道の向きが ${east}`);
  const t = { origin, destination, funWeight: 1, choose: F.topChoice };
  const segs = [roadFrom("east", [at(2, 9), at(2, 12)], { score: 90 })];
  assert.ok(F.build({ ...t, segments: segs, side: "east" }), "東の道を東まわりで選ばない");
  assert.ok(F.build({ ...t, segments: segs, side: "north" }), "東の道は北まわりにも入る（真横まで同じ側）");
  assert.strictEqual(F.build({ ...t, segments: segs, side: "west" }), null, "東の道を西まわりで選んだ");
});

test("規制: 線から40m以内を300m以上続けて走る道だけ外す（入った1辺も数える・排気量で絞る）", () => {
  const line = [at(0, 0), at(0, 2)];
  const restrictions = [{ id: "r1", kind: "noMotorcycle", polyline: encode(line), minCc: 0, maxCc: 50 }];
  const blocked = (points, d = "moped50") => F.isBlockedByRestrictions(points, restrictions, d, undefined);
  assert.strictEqual(blocked([at(0, 0.2), at(0, 1.8)]), true, "重なる道を外していない");
  assert.strictEqual(blocked([at(0.1, 0.2), at(0.1, 1.8)]), false, "100m 横の並行する道まで外した");
  assert.strictEqual(blocked([at(0, 0.2), at(0, 0.45)]), false, "250m しか重ならない道を外した");
  // 500m 西の点から線に入り、線の上を250m 走る。入った1辺（500m）も数えるので外す（アプリと同じ）
  assert.strictEqual(blocked([at(-0.5, 0.5), at(0, 0.5), at(0, 0.75)]), true, "入った1辺を数えていない");
  // 51cc以上には当たらない規制
  assert.strictEqual(blocked([at(0, 0.2), at(0, 1.8)], "large"), false, "排気量で絞っていない");
});

test("ひかえめの予算は、つまみが低ければつまみのまま（1.35倍まで広げない）", () => {
  const t = parity.trips.find((x) => x.name === "新座→愛川");
  const low = F.detourBudgetRatio(0.05);
  const out = F.buildVariants({ origin: t.from, destination: t.to, segments: t.segments, funWeight: 0.05,
                                baselineMeters: t.baselineMeters, referenceAxis: t.referenceAxis,
                                choose: F.topChoice, maxVariants: 2 });
  assert.ok(out.length >= 1, "材料が悪い");
  for (const v of out) assert.ok(v.detourRatio <= low + 1e-9, `${v.kind} が つまみの予算 ${low} を超えた（${v.detourRatio}）`);
});

// MARK: 本番のデータ

function fakeStore({ index, files }) {
  const calls = { index: 0, files: [] };
  const db = {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          assert.strictEqual(`${name}/${id}`, "road_recommend/_index", "索引以外を読んでいる");
          calls.index++;
          return { exists: true, data: () => ({ prefectures: index }) };
        },
      }),
    }),
  };
  const bucket = {
    file: (p) => ({
      download: async () => {
        calls.files.push(p);
        if (!(p in files)) throw new Error(`無いファイル ${p}`);
        return [Buffer.from(JSON.stringify(files[p]))];
      },
    }),
  };
  return { db, bucket, calls };
}

test("本番: 索引から県ごとの本体を読み、手元と中身が同じかを添える", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "delivered-"));
  fs.writeFileSync(path.join(dir, "saitama.json"), JSON.stringify({ generation: 9, contentHash: "h9" }));
  fs.writeFileSync(path.join(dir, "tokyo.json"), JSON.stringify({ generation: 4, contentHash: "h4" }));
  const store = fakeStore({
    index: { saitama: { prefecture: "埼玉県", generation: 9, fileName: "saitama_v9.json", contentHash: "h9" },
             tokyo: { prefecture: "東京都", generation: 2, fileName: "tokyo_v2.json", contentHash: "h2" } },
    files: { "Json/road_recommend/saitama_v9.json": { segments: [{ id: "埼玉県:0" }, { id: "埼玉県:1" }] },
             "Json/road_recommend/tokyo_v2.json": { segments: [{ id: "東京都:0" }] } },
  });
  let clock = 0;
  const d = createDeliveredRoads({ db: store.db, bucket: store.bucket, now: () => clock, localDir: dir });
  const got = await d.segmentsFor(["saitama", "tokyo", "kanagawa"]);
  assert.deepStrictEqual(got.segments.map((s) => s.id), ["埼玉県:0", "埼玉県:1", "東京都:0"]);
  assert.deepStrictEqual(got.missing, ["kanagawa"], "本番に無い県を黙って飛ばした");
  const byPref = Object.fromEntries(got.versions.map((v) => [v.romaji, v]));
  assert.strictEqual(byPref.saitama.sameAsLocal, true);
  assert.strictEqual(byPref.tokyo.sameAsLocal, false, "手元と中身が違うのを見逃した");
  assert.deepStrictEqual([byPref.tokyo.generation, byPref.tokyo.localGeneration], [2, 4]);
  // ⚠️ 本体は世代つきのファイル名なので取っておく。索引は少し経ったら読み直す
  await d.segmentsFor(["saitama"]);
  assert.strictEqual(store.calls.files.filter((f) => f.includes("saitama")).length, 1, "同じ本体を読み直した");
  assert.strictEqual(store.calls.index, 1, "すぐに索引を読み直した");
  clock += 6 * 60 * 1000;
  await d.segmentsFor(["saitama"]);
  assert.strictEqual(store.calls.index, 2, "時間が経っても索引を読み直さない（配信が反映されない）");
});

test("本番のデータは読むだけ（書き込む口が無い）", () => {
  const src = read("lib", "deliveredRoads.js");
  // Firestore・Storage に書く呼び出し（取っておく用の Map.set は別）
  assert.ok(!/\.doc\([^)]*\)\s*\.(set|update|delete|create)\(/.test(src), "本番の Firestore に書き込んでいる");
  assert.ok(!/\.(upload|save|makePublic|batch|runTransaction)\(/.test(src), "本番に書き込む呼び出しがある");
  assert.ok(src.includes(".get();") && src.includes(".download();"), "読み方がアプリと違う（索引を get・本体を download）");
});

// MARK: 窓口と画面の配線

test("窓口: データは手元か本番から、選び方はアプリと同じならふつうのルートを基準に", () => {
  const server = read("server.js");
  const at = server.indexOf("app.post(\"/api/valhalla/fun-routes\"");
  const body = server.slice(at, server.indexOf("\n});", at));
  assert.ok(body.includes("const near = await funSegmentsBetween(from, to, dataSource);"), "データの切り替えが効かない");
  assert.ok(body.includes("baselineMeters: plain.lengthMeters, referencePolyline: plain.points,"),
    "ふつうのルートを遠回りの基準・進み具合の形にしていない");
  assert.ok(body.includes("restrictions: req.body.avoidRestrictions === false ? [] : restrictionsForRomajis(near.prefectures),"),
    "規制と重なる道を外していない");
  assert.ok(body.includes("choose: pickMode === \"top\" ? appFun.topChoice : appFun.randomChoice,"), "選ぶ道の切り替えが効かない");
  assert.ok(body.includes("const rebuild = pick.rebuildWith\n        ? (banIds) => pick.rebuildWith(banIds) || { segments: [], waypoints: [] }"),
    "往復の原因を外して選び直すとき、Web の選び方に戻っている");
  assert.ok(body.includes("const source = { dataSource: near.dataSource, versions: near.versions || null, missing: near.missing || null, app: appInfo };"),
    "どのデータから選んだかを返していない");
  assert.ok(server.includes("const prefectures = prefecturesBetween(from, to);"), "本番で読む県が手元と違う");
});

test("画面: 既定はアプリと同じ選び方・手元のデータ。本番なら世代と手元との違いを出す", () => {
  const html = read("public", "valhalla.html");
  assert.ok(/<option value="app" selected>アプリと同じ<\/option>/.test(html), "選び方の既定がアプリと同じでない");
  assert.ok(/<option value="local" selected>手元（調整中）<\/option>/.test(html));
  assert.ok(html.includes("funCount, budgetRatio, corridorScale, minScore, maxVariants:3, ...bike, ...funSource };"),
    "選び方とデータを送っていない");
  assert.ok(html.includes("const wantsFun = funSelection === \"app\" ? funWeight >= 0.01 : funCount > 0;"),
    "アプリのつまみ0%でも楽しい道を入れる");
  assert.ok(html.includes("(v.sameAsLocal === false ? `<strong style=\"color:var(--warn)\">（手元 v${v.localGeneration} と中身が違う）</strong>` : \"\")"),
    "手元と中身が違う県を出していない");
  const m = html.match(/function funWeightText\(percent\) \{[\s\S]*?\n\}/);
  const text = new Function(`${m[0]}; return funWeightText;`)();
  assert.strictEqual(text(0), "0%・楽しい道を入れない");
  assert.strictEqual(text(50), "50%・寄り道2.05倍まで", "つまみの表示がアプリの倍率と違う");
  assert.strictEqual(text(100), "100%・寄り道3.00倍まで");
  const lm = html.match(/const funLabel = [^\n]+/);
  const BUDGET_LABEL = { generous: "たっぷり", modest: "ひかえめ" };
  const sidesLabel = (sides) => `${(sides || []).join("・")}まわり`;
  const funLabel = new Function("BUDGET_LABEL", "sidesLabel", `${lm[0]}; return funLabel;`)(BUDGET_LABEL, sidesLabel);
  assert.strictEqual(funLabel({ budgetKind: "modest", sides: [] }), "ひかえめ", "予算違いの案に名前が付かない");
  assert.strictEqual(funLabel({ sides: ["north"] }), "northまわり");
});
