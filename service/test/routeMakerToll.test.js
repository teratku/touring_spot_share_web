"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const R = require("../../public/route-maker-lib.js");
const F = require("../../public/route-maker-fun.js");

/**
 * Web のルート作成の有料のおすすめ道路（アプリの RoadToll・NavTollRoads と同じ決めごと。NavTollRoadTests と同じ例）。
 * 利用者の要望（2026-10-11）・判断: 有料を使わない設定で有料の道を選んだら、警告して、その道の上だけ有料を通す。
 * 有料を使わない区間では、有料のおすすめ道路を楽しい道に選ばない
 */
const p = (lat, lng) => ({ lat, lng });
const avoid = { avoidTolls: true, avoidHighways: false, funRoads: true };
const allow = { avoidTolls: false, avoidHighways: false, funRoads: true };
const road = (name, pts, toll, legSetting) =>
  ({ name, kind: "road", lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lng, approach: pts.slice(0, -1), toll, legSetting });

test("配信データの有料を読み、道のIDから有料を引き当てる（まとめた道は全部なら有料・一部なら一部有料）", () => {
  assert.strictEqual(R.tollKind({ toll: "full" }), "full");
  assert.strictEqual(R.tollKind({ toll: "partial" }), "partial");
  assert.strictEqual(R.tollKind({ tags: ["toll"] }), "full", "古い配信データの札「有料道路」を見ていない");
  assert.strictEqual(R.tollKind({ tags: ["有料道路"] }), "full");
  assert.strictEqual(R.tollKind({ toll: "yes" }), null);
  assert.strictEqual(R.mergedToll(["full", "full"]), "full");
  assert.strictEqual(R.mergedToll(["full", null]), "partial", "一部の区間だけ有料の道を「有料」にした");
  assert.strictEqual(R.mergedToll([null, null]), null);
  // アプリのまとめキー（EnjoyableRoadsService.groupKey）と同じ
  assert.strictEqual(R.roadKeyOf({ id: "神奈川県:47", ref: "135", name: "国道135号", highway: "trunk" }), "r:神奈川県|135|trunk");
  assert.strictEqual(R.roadKeyOf({ id: "神奈川県:20", ref: "", name: "芦ノ湖スカイライン", highway: "tertiary" }),
                     "n:神奈川県|芦ノ湖スカイライン|tertiary");
  assert.strictEqual(R.roadKeyOf({ id: "埼玉県:3", ref: "299", name: "x", highway: "trunk", boost: 10 }), "s:埼玉県:3",
                     "手直しした区間を1本の道にしていない");
  const segments = [
    { id: "神奈川県:47", ref: "135", name: "国道135号", highway: "trunk", lengthKm: 18.7, toll: "partial", tollKm: 0.96 },
    { id: "神奈川県:48", ref: "135", name: "真鶴道路", highway: "trunk", lengthKm: 3 },
    { id: "神奈川県:53", ref: "", name: "熱海ビーチライン", highway: "primary", lengthKm: 3.7, tags: ["toll"] },
  ];
  assert.deepStrictEqual(R.tollOfRoad("r:神奈川県|135|trunk", segments), { toll: "partial", km: 0.96 });
  assert.deepStrictEqual(R.tollOfRoad("n:神奈川県|熱海ビーチライン|primary", segments), { toll: "full", km: 3.7 },
                         "札だけの有料の長さを出していない");
  assert.strictEqual(R.tollOfRoad("n:神奈川県|無い道|primary", segments), null);
  assert.strictEqual(R.tollOfRoad(null, segments), null);
});

test("選んだ有料の道の上だけ有料を許し、道へ向かう区間は設定のまま（座標で見分ける）", () => {
  const o = p(35.0, 139.0), e = p(35.1, 139.1), m = p(35.15, 139.15), x = p(35.2, 139.2);
  const all = [0, 1, 2].map(() => ({ avoidTolls: true, avoidHighways: true }));
  const out = R.allowingChosenTollRoads(all, [o, e, m, x], [[e, m, x]]);
  assert.deepStrictEqual(out.map((c) => c.avoidTolls), [true, false, false]);
  assert.deepStrictEqual(out.map((c) => c.avoidHighways), [true, true, true], "高速の条件まで変えた");
  assert.deepStrictEqual(R.allowingChosenTollRoads(all, [o, x, e, m], [[e, m, x]]).map((c) => c.avoidTolls),
                         [true, true, false], "続いていない2点のあいだを道の上とみなした");
  assert.deepStrictEqual(R.allowingChosenTollRoads(all, [o, e, m], [[e, m, x]]).map((c) => c.avoidTolls), [true, true, true]);
});

test("有料を避ける区間で選んだ有料の道だけを数え、頼む体に道の上だけ有料を許す条件を入れる", () => {
  const pts = [p(35.1, 139.1), p(35.15, 139.15), p(35.2, 139.2)];
  const dests = [road("芦ノ湖スカイライン", pts, "full"), road("有料を使う", pts, "full", { avoidTolls: false }),
                 road("無料の道", pts, null), { name: "S", kind: "place", lat: 35.3, lng: 139.3, approach: [], toll: "full" }];
  assert.deepStrictEqual(R.chosenTollRoads(dests, avoid), [0]);
  assert.deepStrictEqual(R.chosenTollRoads(dests, allow), [], "有料を使う設定なのに警告する");

  const cond = { displacement: "large", avoidTolls: true, avoidHighways: false, avoidFerries: true, funWeight: 0 };
  const body = R.buildBody(p(35.0, 139.0), [road("芦ノ湖スカイライン", pts, "full")], cond);
  assert.deepStrictEqual(body.legConditions.map((c) => c.avoidTolls), [true, false, false],
                         "最初の経路で選んだ有料の道の上の有料を許していない");
  assert.strictEqual(body.avoidTolls, true, "全体の条件は一番厳しい組み合わせ（古いサーバ向け）");
  assert.strictEqual(R.buildBody(p(35.0, 139.0), [road("無料の道", pts, null)], cond).legConditions, undefined,
                     "無料の道で条件を混ぜた");
  const fun = R.buildFunBody(p(35.0, 139.0), [road("芦ノ湖スカイライン", pts, "full")], [[139.05, 35.05]], cond, F.geometry);
  assert.ok(fun.legConditions && fun.legConditions.some((c) => !c.avoidTolls) && fun.legConditions.some((c) => c.avoidTolls),
            "楽しい道の頼み方で選んだ有料の道の上の有料を許していない");
});

test("楽しい道は有料を使わない区間で有料のおすすめ道路を選ばない", () => {
  const { encode } = require("../../admin/lib/polyline");
  const line = (lng0) => encode([0, 1, 2, 3, 4].map((k) => [lng0 + k * 0.01, 35.0]));
  const free = { id: "無料の峠", polyline: line(139.0) }, full = { id: "スカイライン", polyline: line(139.0), toll: "full" };
  const part = { id: "一部", polyline: line(139.0), toll: "partial" }, legacy = { id: "札だけ", polyline: line(139.0), tags: ["toll"] };
  const all = [free, full, part, legacy];
  const goal = { name: "ゴール", kind: "place", lat: 35.0, lng: 139.5, approach: [] };
  const route = Array.from({ length: 51 }, (_, k) => p(35.0, 139.0 + k * 0.01));
  const ids = (list) => list.map((s) => s.id);
  assert.deepStrictEqual(ids(R.funSegmentsRespectingTolls(all, [goal], avoid, route, F.geometry, F.appFun)), ["無料の峠"]);
  assert.deepStrictEqual(ids(R.funSegmentsRespectingTolls(all, [goal], allow, route, F.geometry, F.appFun)), ids(all));
  assert.deepStrictEqual(ids(R.funSegmentsRespectingTolls(all, [goal], allow, route, F.geometry, F.appFun, true)), ["無料の峠"]);
  const first = { name: "1つ目", kind: "place", lat: 35.0, lng: 139.2, approach: [], legSetting: { avoidTolls: false } };
  const near = { id: "前半の有料", polyline: line(139.0), toll: "full" }, far = { id: "後半の有料", polyline: line(139.4), toll: "full" };
  assert.deepStrictEqual(ids(R.funSegmentsRespectingTolls([free, near, far], [first, goal], avoid, route, F.geometry, F.appFun)),
                         ["無料の峠", "前半の有料"], "有料を使う区間の上の有料の道まで外した／避ける区間の道を残した");
});

test("避けられなかった有料を行き先ごとに分け、分けられなければ分けない（アプリと同じ例）", () => {
  const st = (meters, o = {}) => ({ distanceMeters: meters, ...o });
  const steps = [st(20000, { tollMeters: 6800, roadName: "雁坂トンネル" }), st(100, { isLegEnd: true }),
                 st(5000, { roadName: "国道140号" }), st(0, { isLegEnd: true })];
  assert.deepStrictEqual(R.unavoidableTolls(steps, 6800, [true, true], []),
    { byDestination: [{ destinationIndex: 0, meters: 6800, roadNames: ["雁坂トンネル"] }], unattributedMeters: 0 });
  const bridge = [st(5000), st(0, { isLegEnd: true }), st(8000, { expresswayMeters: 4000, roadName: "神戸淡路鳴門自動車道" }),
                  st(0, { isLegEnd: true })];
  assert.deepStrictEqual(R.unavoidableTolls(bridge, 4000, [true, true], []).byDestination,
                         [{ destinationIndex: 1, meters: 4000, roadNames: ["神戸淡路鳴門自動車道"] }]);
  const twice = [st(8000, { expresswayMeters: 3000 }), st(0, { isLegEnd: true }), st(8000, { expresswayMeters: 3000 }), st(0, { isLegEnd: true })];
  assert.deepStrictEqual(R.unavoidableTolls(twice, 3000, [true, true], []), { byDestination: [], unattributedMeters: 3000 },
                         "高速を通る区間が2つあるのにどちらかのせいにした");
  assert.deepStrictEqual(R.unavoidableTolls(steps, 6800, [true, true], [0]).byDestination, [], "選んだ有料の道の区間を数えた");
  assert.deepStrictEqual(R.unavoidableTolls(steps, 6800, [false, true], []).byDestination, [], "有料を使う区間を数えた");
  assert.strictEqual(R.unavoidableTolls(steps, 6800, [true], []).unattributedMeters, 6800);
  assert.deepStrictEqual(R.unavoidableTolls([st(1000, { tollMeters: 60 }), st(0, { isLegEnd: true })], 60, [true], []).byDestination, []);
});

test("画面は引く前に有料を引き当て、楽しい道の候補を絞り、有料の注意を候補に出す", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "route-maker.html"), "utf8");
  const resolve = html.indexOf("await resolveRoadTolls(dests);"), fit = html.indexOf("var fit = fitted(dests, MAX_DESTINATION_POINTS);");
  assert.ok(resolve > 0 && resolve < fit, "有料を引き当てる前に行き先を固めている（引き当てた有料が頼み方に入らない）");
  assert.match(html, /searchable = RM\.funSegmentsRespectingTolls\(searchable, dests, defaults, plain\.path, F\.geometry, F\.appFun\);/,
               "楽しい道の候補を有料で絞っていない");
  assert.match(html, /out = out\.concat\(tollNoticesOf\(c, cond\)\);/, "有料の注意を候補に出していない");
  // ⚠️ 2026-10-14 に別の道の絞り込みで v=6 に上げた。5 以上であればよい
  assert.match(html, /\/route-maker-lib\.js\?v=([5-9]|\d{2,})"/, "部品を変えたのに読み込みの版を上げていない（1年キャッシュされる）");
});
