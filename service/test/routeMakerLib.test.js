"use strict";
const test = require("node:test");
const assert = require("node:assert");
const R = require("../../public/route-maker-lib.js");

/**
 * Web でルートを作る画面の計算部分（public/route-maker-lib.js）。
 * ⚠️ アプリと同じ決めごと（TouringSpot.navDestination・NavWaypointBudget.fitted・ValhallaRouteService.send）
 */

const road = (i, mids) => {
  const pts = Array.from({ length: mids + 2 }, (_, k) => ({ lat: 35 + i * 0.1, lng: 139 + k * 0.01 }));
  return { name: `道${i}`, kind: "road", lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lng, approach: pts.slice(0, -1) };
};
const spot = (i) => ({ name: `S${i}`, kind: "place", lat: 36 + i * 0.1, lng: 139.5, approach: [] });
const count = (ds) => ds.reduce((n, d) => n + d.approach.length + 1, 0);

test("プランの1件を行き先にする（道は通り道の最後がゴール・古い形の通り道も読む）", () => {
  const spots = [
    { name: "B", order: 2, lat: 35.2, lng: 139.2 },
    { name: "峠", order: 1, isRoad: true, roadId: "r:x", roadSection: { entry: "北の端", goal: "南の端", meters: 3000 },
      path: [{ lat: 35.0, lng: 139.0 }, { lat: 35.05, lng: 139.0 }, { lat: 35.1, lng: 139.0 }] },
    { name: "古い道", order: 3, isRoad: true, path: [[36.0, 139.0], [36.1, 139.0]] },
    { name: "壊れた", order: 4, lat: NaN, lng: 139 },
  ];
  const ds = R.toDestinations(spots);
  assert.deepStrictEqual(ds.map((d) => d.name), ["峠", "B", "古い道"], "並び順・壊れた点の除外が違う");
  assert.deepStrictEqual([ds[0].lat, ds[0].approach.length, ds[0].roadID], [35.1, 2, "r:x"], "道のゴール・中継点が違う");
  assert.strictEqual(ds[0].section.entry, "北の端");
  assert.deepStrictEqual([ds[2].kind, ds[2].approach[0].lat], ["road", 36.0], "[緯度, 経度] の古い形を読めない");
});

test("地点が上限を超えたら道の途中の点だけをまんべんなく間引く（アプリと同じ: 39地点・入口とゴールは残す）", () => {
  const ds = [...Array.from({ length: 8 }, (_, i) => road(i, 8)), spot(0), spot(1)];
  assert.strictEqual(count(ds), 82, "材料");
  assert.strictEqual(R.MAX_DESTINATION_POINTS, 39, "アプリの NavWaypointBudget.maxDestinationPoints と違う");
  const fit = R.fitted(ds, R.MAX_DESTINATION_POINTS);
  assert.strictEqual(count(fit), 39, "上限ちょうどまで使っていない／超えている");
  fit.forEach((d, i) => {
    assert.strictEqual(d.lat, ds[i].lat, "ゴールを動かした");
    if (ds[i].approach.length) assert.strictEqual(d.approach[0], ds[i].approach[0], "入口を落とした");
  });
  const kept = fit.slice(0, 8).map((d) => d.approach.length - 1);
  assert.ok(Math.max(...kept) - Math.min(...kept) <= 1, "道によって残す点が偏っている");
  const lngs = fit[0].approach.map((p) => p.lng);
  assert.deepStrictEqual(lngs, [...lngs].sort((a, b) => a - b), "並びが崩れた");
  assert.ok(lngs[lngs.length - 1] - lngs[0] > 0.05, "途中の点が入口に寄っている");
  assert.strictEqual(R.fitted([road(0, 8), spot(0)], 39).length, 2);
  assert.deepStrictEqual(R.fitted([road(0, 8), spot(0)], 39)[0].approach.length, 9, "収まっているのに間引いた");
});

test("経路サーバへの体（立ち寄り先・道の終点の番号・経度緯度の順）", () => {
  const ds = [road(0, 1), spot(1), road(2, 0)];
  const body = R.buildBody({ lat: 35.5, lng: 139.9 }, ds, { displacement: "large", avoidTolls: true, avoidHighways: false, avoidFerries: true });
  assert.deepStrictEqual(body.from, [139.9, 35.5], "[経度, 緯度] の順でない");
  // vias: 道0の入口・中継点・ゴール(2)・S1(3)・道2の入口(4)。to は道2のゴール
  assert.strictEqual(body.vias.length, 5);
  assert.deepStrictEqual(body.stopAt, [2, 3], "立ち寄り先の番号が違う");
  assert.deepStrictEqual(body.throughStopAt, [2], "道の終点で引き返させない印が無い");
  assert.deepStrictEqual(body.to, [139.01, 35.2]);
  assert.strictEqual(body.alternates, 2);
  assert.strictEqual(body.guidance, false);
  assert.strictEqual(body.avoidTolls, true);
});

test("線を読む（5桁）", () => {
  assert.deepStrictEqual(R.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"),
    [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
});

// ---- アプリにそろえた設定と見た目（利用者の要望 2026-10-09:「アプリと同じような設定で生成したい 線の色など」） ----

test("地図の色がアプリと同じ（下道=青・高速=緑・有料=オレンジ・金色の縁・ほかの候補の色は順に回る）", () => {
  assert.deepStrictEqual(R.ROAD_KINDS.map((k) => [k.kind, k.label, k.color]),
    [["expressway", "高速", "#34C759"], ["toll", "有料", "#FF9500"], ["surface", "下道", "#007AFF"]],
    "NavRoadKind の色・名前・並び（凡例の順）と違う");
  assert.strictEqual(R.RECOMMENDED_EDGE_COLOR, "#F5B700", "NavRecommendedSpans.edgeColor と違う");
  assert.deepStrictEqual(R.CANDIDATE_PALETTE, ["#FF2D55", "#30B0C7", "#5856D6", "#A2845E", "#00C7BE"]);
  assert.deepStrictEqual([R.candidateColor(0), R.candidateColor(5), R.candidateColor(6), R.candidateColor(-1)],
    ["#FF2D55", "#FF2D55", "#30B0C7", "#00C7BE"], "候補が5本を超えたとき・負の番号で色が回らない");
  assert.strictEqual(R.kindInfo("toll").color, "#FF9500");
  assert.strictEqual(R.kindInfo("unknown").kind, "surface", "知らない種類は下道として塗る");
});

test("選んだ候補を道の種類で塗り分ける（区間の無い所は下道・区間は始まり順・端は線に収める）", () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ lat: 35, lng: 139 + i * 0.001 }));
  const segs = R.kindSegments(pts, [
    { begin: 5, end: 7, kind: "expressway", meters: 200 },
    { begin: 2, end: 3, kind: "toll", meters: 100 },
  ]);
  assert.deepStrictEqual(segs.map((s) => [s.kind, s.path[0].lng, s.path.length]), [
    ["surface", 139, 3], ["toll", 139.002, 2], ["surface", 139.003, 3], ["expressway", 139.005, 3], ["surface", 139.007, 3],
  ], "隙間を下道で埋めていない／並べ替えていない");
  assert.deepStrictEqual(R.kindSegments(pts, [{ begin: 8, end: 99, kind: "toll" }]).map((s) => [s.kind, s.path.length]),
    [["surface", 9], ["toll", 2]], "線より先まで伸びた区間を線に収めていない");
  assert.deepStrictEqual(R.kindSegments(pts, []).map((s) => [s.kind, s.path.length]), [["surface", 10]]);
  assert.deepStrictEqual(R.kindSegments(pts.slice(0, 1), []), [], "点が1つでは線にならない");
});

test("通る道の内訳と、距離・所要の書き方（アプリの NavFormat・compositionSummary と同じ）", () => {
  const route = { kindSpans: [
    { begin: 0, end: 5, kind: "surface", meters: 12000 }, { begin: 5, end: 9, kind: "expressway", meters: 9200 },
    { begin: 9, end: 12, kind: "surface", meters: 5900 }] };
  assert.deepStrictEqual(R.presentKinds(route).map((k) => k.kind), ["expressway", "surface"], "凡例の順（高速・有料・下道）でない");
  assert.strictEqual(R.kindMeters(route, "surface"), 17900, "同じ種類の区間を足していない");
  assert.strictEqual(R.compositionSummary(route), "高速 9.2 km ・ 下道 17.9 km");
  assert.strictEqual(R.compositionSummary({ kindSpans: [{ kind: "surface", meters: 800 }] }), "下道のみ");
  assert.deepStrictEqual([R.km(999), R.km(1000), R.km(12345)], ["999 m", "1.0 km", "12.3 km"]);
  assert.deepStrictEqual([R.dur(3599), R.dur(3600), R.dur(7170), R.dur(-5)], ["59分", "1時間0分", "1時間59分", "0分"],
    "分を四捨五入している（「1時間60分」になる）");
});

test("立ち寄り先ごとの有料・高速（地点のあいだごとの条件・混ざったときだけ渡す・全体は一番厳しい組み合わせ）", () => {
  const ds = [Object.assign(road(0, 1), { legSetting: { avoidTolls: false, avoidHighways: null } }), spot(1)];
  const cond = { displacement: "large", avoidTolls: true, avoidHighways: false, avoidFerries: true };
  const body = R.buildBody({ lat: 35.5, lng: 139.9 }, ds, cond);
  // 道0: 入口・中継点・ゴールの3つのあいだは有料を使う。S1 へ向かう1つは全体の設定（避ける）
  assert.deepStrictEqual(body.legConditions.map((c) => c.avoidTolls), [false, false, false, true], "区間の設定が地点のあいだに広がっていない");
  assert.strictEqual(body.legConditions.length, body.vias.length + 1, "あいだの数が地点の数と合わない");
  assert.strictEqual(body.avoidTolls, true, "全体の条件が一番厳しい組み合わせでない");
  const same = R.buildBody({ lat: 35.5, lng: 139.9 }, [road(0, 1), spot(1)], cond);
  assert.ok(!("legConditions" in same), "そろっているのにサーバへ区間ごとの条件を渡した");
  // 125cc 以下は区間で「使う」にしても高速に乗せない
  const small = R.buildBody({ lat: 35.5, lng: 139.9 },
    [Object.assign(spot(0), { legSetting: { avoidHighways: false } }), spot(1)], Object.assign({}, cond, { displacement: "small125" }));
  assert.strictEqual(small.avoidHighways, true, "125cc 以下で高速を使わせた");
  assert.ok(!("legConditions" in small), "125cc 以下で高速を使う区間ができた");
});

test("区間の札を押すと切り替わり、全体と同じになったら「全体に従う」に戻る", () => {
  const defaults = R.legDefaults({ displacement: "large", avoidTolls: true, avoidHighways: false });
  const once = R.toggledLeg(null, "avoidTolls", defaults);
  assert.deepStrictEqual(once, { avoidTolls: false, avoidHighways: null, funRoads: null }, "避けている区間を押しても使うにならない");
  assert.deepStrictEqual(R.toggledLeg(once, "avoidTolls", defaults), { avoidTolls: null, avoidHighways: null, funRoads: null },
    "全体と同じに戻したのに区間の設定が残った（全体を変えても追従しなくなる）");
  assert.deepStrictEqual(R.toggledLeg(null, "avoidHighways", defaults), { avoidTolls: null, avoidHighways: true, funRoads: null });
  assert.deepStrictEqual(R.effectiveLeg({ avoidTolls: false }, defaults), { avoidTolls: false, avoidHighways: false, funRoads: false });
  assert.strictEqual(R.legDefaults({ displacement: "moped50", avoidHighways: false }).avoidHighways, true, "50cc で高速を使う既定になった");
  assert.strictEqual(R.highwaysForbidden("medium250"), false);
});

test("ETC 車載器なし・走る日時（決めたときだけ送る・秒までの UTC）", () => {
  const base = { displacement: "large", avoidTolls: false, avoidHighways: false, avoidFerries: true };
  const plain = R.buildBody({ lat: 35, lng: 139 }, [spot(1)], Object.assign({}, base, { etc: true, rideAt: null }));
  assert.ok(!("etc" in plain) && !("at" in plain) && !("isHoliday" in plain), "決めていない条件を送った");
  const set = R.buildBody({ lat: 35, lng: 139 }, [spot(1)], Object.assign({}, base,
    { etc: false, rideAt: new Date(Date.UTC(2026, 9, 10, 0, 30, 15, 250)), isHoliday: true }));
  assert.strictEqual(set.etc, false, "車載器なしを伝えていない（スマート IC に入れてしまう）");
  assert.strictEqual(set.at, "2026-10-10T00:30:15Z", "アプリ（ISO8601DateFormatter）と同じ形でない");
  assert.strictEqual(set.isHoliday, true);
  const bad = R.buildBody({ lat: 35, lng: 139 }, [spot(1)], Object.assign({}, base, { rideAt: new Date("x") }));
  assert.ok(!("at" in bad), "読めない日時を送った");
});

test("おすすめ道路を続けて300m以上走る区間だけ金色の縁にする（横切るだけ・短い道は光らせない）", () => {
  const step = 50 / (111320 * Math.cos(35 * Math.PI / 180));   // 50m ぶんの経度
  const route = Array.from({ length: 60 }, (_, i) => ({ lat: 35, lng: 139 + i * step }));
  const at = (i) => 139 + i * step;
  const along = [{ lat: 35, lng: at(4) }, { lat: 35, lng: at(30) }];            // 4〜30 番（1.3km）を走る
  const crossing = [{ lat: 34.99, lng: at(45) }, { lat: 35.01, lng: at(45) }];  // 45 番で横切るだけ
  const short = [{ lat: 35, lng: at(50) }, { lat: 35, lng: at(54) }];           // 200m だけ
  const far = [{ lat: 36, lng: 139 }, { lat: 36.1, lng: 139 }];
  assert.deepStrictEqual(R.recommendedSpans(route, [along, crossing, short, far]), [[4, 30]]);
  const near = along.map((p) => ({ lat: p.lat + 25 / 111320, lng: p.lng }));   // 25m 横にずれた道
  assert.deepStrictEqual(R.recommendedSpans(route, [near]), [[4, 30]], "30m 以内のずれを同じ道とみなしていない");
  const off = along.map((p) => ({ lat: p.lat + 40 / 111320, lng: p.lng }));
  assert.deepStrictEqual(R.recommendedSpans(route, [off]), [], "40m 離れた道を走っているとみなした");
  const toEnd = [{ lat: 35, lng: at(40) }, { lat: 35, lng: at(59) }];
  assert.deepStrictEqual(R.recommendedSpans(route, [toEnd]), [[40, 59]], "線の終わりまで走る区間を閉じていない");
  assert.deepStrictEqual(R.recommendedSpans(route, []), []);
});

test("経路が掛かる県（外接矩形が重なる県）と、行き先ごとの内訳（数が合わなければ出さない）", () => {
  const prefs = [
    { name: "A県", bounds: { latMin: 35, latMax: 36, lngMin: 139, lngMax: 140 } },
    { name: "B県", bounds: { latMin: 36.5, latMax: 37, lngMin: 139, lngMax: 140 } },
    { name: "C県", bounds: { latMin: 35.5, latMax: 36.2, lngMin: 140.1, lngMax: 141 } },
  ];
  assert.deepStrictEqual(R.prefecturesFor([[{ lat: 35.2, lng: 139.5 }], [{ lat: 35.9, lng: 140.5 }]], prefs), ["A県", "C県"],
    "候補ぜんぶの線で見ていない／重なりの判定が違う");
  assert.deepStrictEqual(R.prefecturesFor([[]], prefs), []);
  const route = { steps: [
    { distanceMeters: 1000, durationSeconds: 60 }, { distanceMeters: 2000, durationSeconds: 120, isLegEnd: true },
    { distanceMeters: 500, durationSeconds: 30, isLegEnd: true }] };
  assert.deepStrictEqual(R.legBreakdown(route, [{ name: "道" }, { name: "S" }]), [
    { name: "道", distanceMeters: 3000, durationSeconds: 180 }, { name: "S", distanceMeters: 500, durationSeconds: 30 }]);
  assert.deepStrictEqual(R.legBreakdown(route, [{ name: "道" }]), [], "行き先の数と合わないのに内訳を出した");
});

test("選んだ道をアプリへ渡す形（サーバの応答そのまま・画面で足した線は入れない・大きすぎれば渡さない）", () => {
  // 利用者の報告（2026-10-09）: Web で作ったルートをアプリに送ると、新しく作り直されていた
  const c = { totalDistanceMeters: 1200, polyline: "_p~iF~ps|U", steps: [{ instruction: "右です", isLegEnd: true }],
              kindSpans: [{ begin: 0, end: 1, kind: "surface", meters: 1200 }], path: [{ lat: 1, lng: 2 }] };
  const text = R.routeForApp(c);
  const back = JSON.parse(text);
  assert.ok(!("path" in back), "画面で足した線まで送った（重い・アプリは読まない）");
  assert.deepStrictEqual(back.steps, c.steps, "曲がり方を落とした（アプリが引き直すことになる）");
  assert.deepStrictEqual(back.kindSpans, c.kindSpans, "道の種類の区間を落とした（線の色が変わる）");
  assert.strictEqual(back.polyline, c.polyline);
  assert.ok("path" in c, "元の候補を書き換えた（地図の線が消える）");
  assert.strictEqual(R.routeForApp(c, text.length - 1), null, "上限を超えたのに渡した（Firestore が断る）");
  assert.strictEqual(R.routeForApp(c, text.length + 6), text, "上限の内なのに渡さなかった");
  assert.strictEqual(R.MAX_ROUTE_BYTES, 900000);
  const jp = Object.assign({}, c, { steps: [{ instruction: "あ".repeat(100) }] });
  const jpText = R.routeForApp(jp);
  assert.strictEqual(R.routeForApp(jp, jpText.length + 50), null, "文字数で測っている（日本語は1文字3バイト）");
  assert.strictEqual(R.routeForApp({ polyline: "x" }), null, "曲がり方の無いものを渡した");
  assert.strictEqual(R.routeForApp(null), null);
});

// ---- 楽しい道・距離ガバのつなぎ（利用者の判断 2026-10-09: Web に楽しい道＋距離ガバを持ってくる） ----
const B = require("../../public/route-maker-fun.js");
const geo = B.geometry, fun = B.appFun;
const P = (lat, lng) => ({ lat, lng });

test("楽しい道の経由地は、いちばん近い区間の行き先の手前に進む順で差し込む（道の中継点は区切りにしない・道の終点は引き返さない）", () => {
  const origin = P(35, 139);
  const stops = [
    { point: P(35.0, 139.05), isUserStop: false, isRoadCourseEnd: false },   // 道の中継点
    { point: P(35.0, 139.1), isUserStop: true, isRoadCourseEnd: true },      // 道の終点
    { point: P(35.1, 139.1), isUserStop: true, isRoadCourseEnd: false },     // スポット
    { point: P(35.2, 139.1), isUserStop: true, isRoadCourseEnd: false },     // ゴール
  ];
  const d0 = P(35.15, 139.11), d1 = P(35.02, 139.03), d2 = P(35.01, 139.08), d3 = P(35.05, 139.11);
  const seq = R.viaSequence(origin, [d0, d2, d3, d1], stops, geo);
  assert.deepStrictEqual(seq.vias, [stops[0].point, d1, d2, stops[1].point, d3, stops[2].point, d0],
    "区間の振り分け・区間の中の並び（進む順）が違う");
  assert.deepStrictEqual(seq.stopAt, [3, 5], "止まる場所の番号が違う（道の中継点で止めている／止める場所を落とした）");
  assert.deepStrictEqual(seq.throughStopAt, [3], "道の終点で引き返させない印が無い");
  assert.deepStrictEqual(R.destinationStops([
    { kind: "road", lat: 35, lng: 139.1, approach: [P(35, 139.05)] }, { kind: "place", lat: 35.1, lng: 139.1, approach: [] },
  ]).map((s) => [s.isUserStop, s.isRoadCourseEnd]), [[false, false], [true, true], [true, false]]);
});

test("楽しい道の案の体（variant=fun・代替なし・区間の有料／高速は決めた区間があるときだけ・立ち寄り先を過ぎるたび次の区間）", () => {
  const dests = [{ name: "A", kind: "place", lat: 35.0, lng: 139.1, approach: [], legSetting: null },
                 { name: "B", kind: "place", lat: 35.1, lng: 139.1, approach: [], legSetting: { avoidHighways: false } }];
  const cond = { displacement: "large", avoidTolls: false, avoidHighways: true, avoidFerries: true, funWeight: 1 };
  const body = R.buildFunBody(P(35, 139), dests, [[139.05, 35.01], [139.11, 35.05]], cond, geo);
  assert.strictEqual(body.variant, "fun", "楽しい道として頼んでいない（サーバの重みが変わる）");
  assert.strictEqual(body.alternates, 0);
  assert.deepStrictEqual(body.vias, [[139.05, 35.01], [139.1, 35.0], [139.11, 35.05]]);
  assert.deepStrictEqual(body.stopAt, [1]);
  assert.deepStrictEqual(body.legConditions.map((c) => c.avoidHighways), [true, true, false, false],
    "A を過ぎたあとの区間（B へ向かう）で高速を使っていない");
  assert.strictEqual(body.avoidHighways, true, "全体の条件が一番厳しい組み合わせでない");
  const plain = R.buildFunBody(P(35, 139), dests.map((d) => Object.assign({}, d, { legSetting: null })),
    [[139.05, 35.01]], cond, geo);
  assert.ok(!("legConditions" in plain), "区間で決めていないのに区間ごとの条件を渡した");
  assert.deepStrictEqual(R.funGapConditions(2, [0], dests, R.legDefaults(cond), true).map((c) => c.avoidHighways),
    [true, true, true], "下道のみの案で区間の「使う」を通した");
});

test("楽しい道は「楽しい道を使う区間」の上の道だけにする（区間の札・道の真ん中で決める）", () => {
  const route = Array.from({ length: 21 }, (_, i) => P(35, 139 + i * 0.01));   // 東へ 20 刻み
  const goals = [P(35, 139.1), P(35, 139.2)];
  assert.deepStrictEqual(R.legRanges(route, goals, geo), [[0, 10], [10, 20]]);
  const seg = (id, lng) => ({ id, polyline: B.geometry && require("../../admin/lib/polyline").encode([[lng - 0.005, 35.002], [lng, 35.002], [lng + 0.005, 35.002]]) });
  const west = seg("west", 139.04), east = seg("east", 139.16);
  assert.deepStrictEqual(R.filterFunSegments([west, east], route, goals, [1], geo, fun).map((s) => s.id), ["east"],
    "楽しい道を使わない区間の道を残した");
  assert.deepStrictEqual(R.filterFunSegments([west, east], route, goals, [0, 1], geo, fun).length, 2, "全部の区間で使うのに絞った");
  assert.deepStrictEqual(R.filterFunSegments([west, east], route, goals, [], geo, fun), []);
  // 経路の線がまだ無いとき（区間に分けられない）も、使う区間が無ければ空・あれば全部
  assert.deepStrictEqual(R.filterFunSegments([west, east], route.slice(0, 1), goals, [], geo, fun), [],
    "楽しい道を使う区間が無いのに、線が無いときだけ全部の道を残した");
  assert.strictEqual(R.filterFunSegments([west, east], route.slice(0, 1), goals, [1], geo, fun).length, 2);
  const dests = [{ legSetting: { funRoads: false } }, { legSetting: null }];
  assert.deepStrictEqual(R.funLegs(dests, R.legDefaults({ funWeight: 1 })), [1]);
  assert.deepStrictEqual(R.funLegs(dests, R.legDefaults({ funWeight: 0 })), [], "つまみ0でも楽しい道を使う区間ができた");
  const d = R.legDefaults({ funWeight: 1 });
  assert.deepStrictEqual(R.toggledLeg(null, "funRoads", d), { avoidTolls: null, avoidHighways: null, funRoads: false });
  assert.deepStrictEqual(R.toggledLeg({ funRoads: false }, "funRoads", d).funRoads, null, "全体と同じに戻したのに区間の設定が残った");
});

test("余計に走らせた原因の道（Uターンの指示・往復の先端・輪の出入口・ゴールを通り過ぎた先）。覚えるのは往復だけ", () => {
  const enc = require("../../admin/lib/polyline").encode;
  const line = (id, pts) => ({ id, polyline: enc(pts), start: [pts[0][1], pts[0][0]], end: [pts[pts.length - 1][1], pts[pts.length - 1][0]] });
  // 東へ 0〜20 進んで 12 まで戻る（同じ線を往復）
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push([139 + i * 0.001, 35]);
  for (let i = 19; i >= 12; i--) pts.push([139 + i * 0.001, 35]);
  const apexRoad = line("apex", [[139.0195, 35.0005], [139.0205, 35.0005]]);
  const uturnRoad = line("uturn", [[139.004, 35.0003], [139.006, 35.0003]]);
  const farRoad = line("far", [[139.5, 35.5], [139.51, 35.5]]);
  const route = { steps: [{ maneuver: "uturn-left", beginIndex: 5 }, { maneuver: "right", beginIndex: 2 }] };
  const r = R.funCulprits(route, pts, [apexRoad, uturnRoad, farRoad], P(35, 139.012), geo, fun);
  assert.deepStrictEqual(r.banned.map((s) => s.id).sort(), ["apex", "uturn"], "原因の道の見つけ方が違う（遠い道を外した／原因を落とした）");
  assert.deepStrictEqual(r.forever.map((s) => s.id), ["apex"], "Uターンの指示の道まで覚えた（入る端で変わるので覚えない）");
  const loops = R.funCulprits({ steps: [], wastefulLoopSpans: [{ begin: 2, end: 3 }] }, pts.slice(0, 21),
    [line("loop", [[139.003, 35.015], [139.004, 35.015]])], P(35, 139.02), geo, fun);
  assert.deepStrictEqual(loops.banned.map((s) => s.id), ["loop"], "輪の出入口から 2km 以内の道を外していない");
  assert.deepStrictEqual(loops.forever, []);
});

test("案の名前・遠回りの書き方・つまみの表示・県の範囲（アプリと同じ）", () => {
  assert.strictEqual(R.variantLabel({ sides: ["north", "east"], recipe: { corridorScale: 1 } }), "北・東まわり");
  assert.strictEqual(R.variantLabel({ sides: ["west"], recipe: { corridorScale: 3 } }), "西まわり（広め）", "広げた案と見分けられない");
  assert.deepStrictEqual(["generous", "modest", "alternate", "wide"].map((kind) => R.variantLabel({ sides: [], kind, recipe: {} })),
    ["たっぷり", "ひかえめ", "別ルート", "もっと寄り道"]);
  assert.strictEqual(R.detourText(150000, 100000, 3), "遠回り 25%", "上限（+200%）に対する割合で出していない");
  assert.strictEqual(R.detourText(400000, 100000, 3), "+300km（約4.0倍）", "上限を超えた案を割合のまま（100%）出した");
  assert.strictEqual(R.detourText(99000, 100000, 3), "", "縮んだのに遠回りと書いた");
  assert.deepStrictEqual([0, 0.005, 0.2, 0.5, 0.9].map(R.funWeightLabel), ["最短", "最短", "少し寄り道", "ほどよく", "たっぷり"]);
  const prefs = [{ name: "近", bounds: { latMin: 35.2, latMax: 35.5, lngMin: 139, lngMax: 139.5 } },
                 { name: "遠", bounds: { latMin: 36.0, latMax: 36.5, lngMin: 139, lngMax: 139.5 } }];
  assert.deepStrictEqual(R.prefecturesWithin(P(35, 139.2), 30, prefs), ["近"], "半径の外の県まで読む");
  assert.deepStrictEqual(R.prefecturesWithin(P(35, 139.2), 120, prefs), ["近", "遠"]);
});

test("同じ道になった候補は畳む（有料・総距離・形）。好みは選んだ記録の道の特徴から", () => {
  const mk = (pts, total) => ({ route: { totalDistanceMeters: total, kindSpans: [] }, points: pts });
  const a = mk(Array.from({ length: 30 }, (_, i) => [139 + i * 0.002, 35]), 5400);
  const same = mk(Array.from({ length: 30 }, (_, i) => [139 + i * 0.002, 35.0001]), 5450);
  const other = mk(Array.from({ length: 30 }, (_, i) => [139 + i * 0.002, 35 + i * 0.001]), 5500);
  assert.deepStrictEqual(R.mergeCandidates([[a], [same, other]], geo), [a, other], "同じ形の候補を畳まない／違う形を畳んだ");
  const far = mk(a.points, 9000);
  assert.strictEqual(R.mergeCandidates([[a, far]], geo).length, 2, "総距離が 2km 以上違うのに畳んだ");
  assert.strictEqual(R.tasteFromChoices({ spots: {} }, B.rider), null, "道の記録が無いのに好みを作った");
  const taste = R.tasteFromChoices({ roads: {
    a: { key: "r:a", features: ["curvy:high", "hw:secondary"], count: 3 },
    b: { key: "r:b", features: ["curvy:low", "hw:primary"], count: 1 } } }, B.rider);
  // 重み: curvy:high .75・hw:secondary .75・curvy:low .25・hw:primary .25
  assert.strictEqual(taste({ tags: [], highway: "secondary", curviness: 700 }), 0.75, "選んだ回数で重みを付けていない");
  assert.strictEqual(taste({ tags: [], highway: "primary", curviness: 100 }), 0.25);
  assert.strictEqual(taste({ tags: [], highway: "trunk", curviness: 400 }), 0);
});
