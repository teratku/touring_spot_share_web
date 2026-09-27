"use strict";
const test = require("node:test");
const assert = require("node:assert");
const S = require("../lib/rerouteSim");

/**
 * 外れたときの引き直しを、アプリと同じ手順でなぞる（`lib/rerouteSim.js`）。
 *
 * ⚠️ 利用者の要望（2026-09-27）:「web でリルートのテストができるようにしたい」。
 *    画面で外れた地点と向きを置き、アプリと同じ手順（どの行き先から引き直すか・
 *    向き直しを避ける誘導点・問題の中継点を落とす）で引き直す。
 * ⚠️ 場面はアプリのテスト（NavRouteSpliceTests・NavWaypointSkipTests・
 *    NavIntersectionNameTests の向き直し）と同じものを使う。食い違ったら移し方の誤り
 */

/** 北へ1kmずつ進むステップ（経度139.0の線上）。点は [経度, 緯度] */
function northRoute(n = 5, { legEndAfter = [] } = {}) {
  const points = [];
  const steps = [];
  for (let i = 0; i < n; i++) {
    const begin = points.length ? points.length - 1 : 0;
    for (let k = points.length ? 1 : 0; k < 20; k++) {
      points.push([139.0, 35.0 + i * 0.009 + (0.009 * k) / 19]);
    }
    steps.push({ maneuver: "turnRight", distanceMeters: 1000, durationSeconds: 100,
                 beginIndex: begin, endIndex: points.length - 1, roadKind: "surface", roadName: "国道17号線" });
    if (legEndAfter.includes(i)) {
      steps.push({ maneuver: "none", isLegEnd: true, distanceMeters: 0, durationSeconds: 0,
                   beginIndex: points.length - 1, endIndex: points.length - 1, roadKind: "surface" });
    }
  }
  steps.push({ maneuver: "none", isLegEnd: true, distanceMeters: 0, durationSeconds: 0,
               beginIndex: points.length - 1, endIndex: points.length - 1, roadKind: "surface" });
  return { points, steps, lengthMeters: n * 1000, durationSeconds: n * 100 };
}

/** 戻る道（末尾に到着が付く＝サーバが必ず付ける形） */
function detour(meters = 800) {
  const points = Array.from({ length: 10 }, (_, k) => [139.001, 35.05 - (0.03 * k) / 9]);
  return {
    points, lengthMeters: meters, durationSeconds: meters / 10,
    steps: [
      { maneuver: "turnLeft", distanceMeters: meters, durationSeconds: meters / 10, beginIndex: 0, endIndex: 9,
        roadKind: "surface", roadName: "県道1号線" },
      { maneuver: "none", isLegEnd: true, distanceMeters: 0, durationSeconds: 0, beginIndex: 9, endIndex: 9 },
    ],
  };
}

const at = (lat, lng = 139.0) => [lng, lat];
const leg = (lat, o = {}) => ({ destination: at(lat), isUserWaypoint: true, ...o });

// MARK: 繋ぎ先（NavRouteSpliceTests と同じ場面）

test("少し先の区切りを選ぶ", () => {
  // ⚠️ 目の前の点へ繋ごうとすると、いま来た道を逆走する形になる
  assert.strictEqual(S.rejoinStepIndex(northRoute().steps, 0, 1500), 2, "1.5km 先の区切りを選んでいない");
  assert.strictEqual(S.MIN_AHEAD_METERS, 1500, "アプリの値（1.5km）と違う");
});

test("立ち寄り先を跨いで繋がない・先が足りなければ繋がない", () => {
  // ⚠️ **跨ぐとその立ち寄り先が黙って消える。** 全体の引き直しに任せる
  const withStop = northRoute(5, { legEndAfter: [0] });
  assert.deepStrictEqual(S.rejoinSearch(withStop.steps, 0, 1500), { index: null, reason: "legEnd" });
  // ⚠️ 最後の「到着」までは繋ぎ先にできる（アプリと同じ）。到着まで1kmしか無ければ繋がない
  assert.deepStrictEqual(S.rejoinSearch(northRoute().steps, 4, 1500), { index: null, reason: "short" });
  assert.strictEqual(S.rejoinStepIndex(northRoute().steps, 3, 1500), 5, "到着まで2kmあるのに繋がない");
});

test("元の続きをそのまま残し、合流点で到着と言わない", () => {
  const original = northRoute();
  const spliced = S.splice(detour(), original, 2);
  assert.ok(spliced, "繋げていない");
  // 戻る道1本 ＋ 元の3本 ＋ 最後の到着
  assert.deepStrictEqual(spliced.steps.map((s) => s.roadName || null),
    ["県道1号線", "国道17号線", "国道17号線", "国道17号線", null], "元の続きが残っていない");
  assert.strictEqual(spliced.steps.filter((s) => s.isLegEnd).length, 1, "戻る道の到着が残っている");
  assert.strictEqual(spliced.lengthMeters, 800 + 3000, "距離の足し方が違う");
  // ⚠️ **点の番号も付け替えること。** 付け替えないと、続きの案内が戻る道の上に出る
  const s = spliced.steps[1];
  assert.deepStrictEqual(spliced.points[s.beginIndex], original.points[original.steps[2].beginIndex],
    "続きの指示が元の場所を指していない");
  assert.deepStrictEqual(spliced.points[spliced.points.length - 1], original.points[original.points.length - 1]);
});

test("遠回りすぎるなら繋がない", () => {
  // ⚠️ 合流点が反対車線・立体交差の向こうだと大回りが要る
  assert.strictEqual(S.isReasonable(detour(20_000), at(35.05, 139.001), at(35.02, 139.001)), false,
    "大回りでも繋いでしまう");
  assert.strictEqual(S.isReasonable(detour(), at(35.05, 139.001), at(35.02, 139.001)), true,
    "ふつうの戻り道を諦めている");
});

// MARK: 向き直し（NavIntersectionNameTests の向き直しと同じ場面）

test("いきなり向きを変えさせる形を見分ける", () => {
  const r = (ms) => ms.map((maneuver) => ({ maneuver }));
  assert.ok(S.startsWithUTurn(r(["none", "turnRight", "turnRight", "turnLeft"])), "右→右を見逃す");
  assert.ok(S.startsWithUTurn(r(["none", "turnLeft", "turnLeft", "turnLeft"])), "左→左を見逃す");
  assert.ok(S.startsWithUTurn(r(["none", "turnLeft", "uturnRight"])), "Uターンを見逃す");
  assert.ok(!S.startsWithUTurn(r(["none", "turnLeft", "turnRight", "turnRight"])), "左→右を向き直しとしている");
  // ⚠️ 見るのは先頭4つだけ（引き直した直後に向きを変えさせられるか）
  assert.ok(!S.startsWithUTurn(r(["none", "straight", "straight", "straight", "uturnLeft"])),
    "先の方のUターンまで拾っている");
});

test("誘導点は進行方向の100m先・目的地が背後や向きが無ければ置かない", () => {
  const here = at(35.0);
  const nudge = S.forwardNudge(here, 0, at(35.05));
  assert.ok(nudge, "前方の目的地なのに置かない");
  assert.ok(Math.abs(nudge[1] - 35.0 - 100 / 111_195) < 1e-5 && Math.abs(nudge[0] - 139.0) < 1e-9,
    `北へ100mの点でない: ${nudge}`);
  assert.strictEqual(S.forwardNudge(here, 0, at(34.95)), null, "背後の目的地に置いている");
  assert.strictEqual(S.forwardNudge(here, null, at(35.05)), null, "向きが無いのに置いている");
  assert.ok(S.forwardNudge(here, 0, [139.05, 35.0]), "真横（90度）は前方として扱う");
});

// MARK: どの行き先から（NavWaypointSkipTests と同じ場面）

/** 北へ1kmおきの行き先5つ */
const northbound = () => [0, 1, 2, 3, 4].map((i) => leg(35.0 + (i + 1) * 0.009));

test("通り過ぎた行き先を飛ばす", () => {
  // 3番目のあたりから北向きに走り出した
  assert.strictEqual(S.firstLegAhead(northbound(), 0, at(35.0 + 2.9 * 0.009), 0), 2 + 0,
    "まだ前方にある行き先を飛ばした／通り過ぎた行き先を残した");
  assert.strictEqual(S.firstLegAhead(northbound(), 0, at(35.0 + 3.9 * 0.009), 0), 3);
  assert.strictEqual(S.firstLegAhead(northbound(), 0, at(34.999), 0), 0, "出発地の近くで飛ばした");
  // ⚠️ 目的地を通り過ぎていても、行き先を空にしない
  assert.strictEqual(S.firstLegAhead(northbound(), 0, at(35.0 + 9 * 0.009), 0), 4);
  // ⚠️ 既に通った区間を見に戻らない
  assert.strictEqual(S.firstLegAhead(northbound(), 3, at(35.0), 0), 3);
  // ⚠️ 向きが取れなければ落とさない
  assert.strictEqual(S.firstLegAhead(northbound(), 0, at(35.0 + 2.9 * 0.009), null), 0);
});

test("行き先を落とすのは「後ろにある」かつ「次のほうが近い」ときだけ", () => {
  // 立ち寄り先 A を 1.1km 行き過ぎた。次の B は 50km 先
  // ⚠️ A を落とすと、寄るはずの A が黙って消える。向きを変えて戻るのが正しい
  assert.strictEqual(S.firstLegAhead([leg(34.99), leg(35.45)], 0, at(35.0), 0), 0,
    "次のほうが遠いのに後ろの行き先を落とした");
  // A は 1km 先、B は 330m 先（B のほうが近い）。⚠️ 前方にあるならまだ向かっている途中
  assert.strictEqual(S.firstLegAhead([leg(35.009), leg(35.003)], 0, at(35.0), 0), 0,
    "前方の行き先を落とした");
  // 後ろにあって、次のほうが近い → 落とす
  assert.strictEqual(S.firstLegAhead([leg(34.99), leg(35.005)], 0, at(35.0), 0), 1);
});

test("通り過ぎた直後の中継点はまだ落とさない", () => {
  // ⚠️ 100m間隔の中継点。少し行き過ぎただけで次々に落とすと道筋が失われる
  const dense = [0, 1, 2, 3, 4, 5].map((i) => leg(35.0 + i * 0.0009, { isUserWaypoint: i === 5 }));
  assert.strictEqual(S.firstLegAhead(dense, 0, at(35.0 + 0.0009 + 0.00108), 0), 1);
});

test("往復ルートで行きの目的地を通過済みにしない", () => {
  // ⚠️ 出発地にいる時点で「Aまで50km・Bまで1km」。北へ向かっているなら A は前方
  const legs = [leg(35.45), leg(35.009)];
  assert.strictEqual(S.firstLegAhead(legs, 0, at(35.0), 0), 0, "行きの目的地を通過済みにしている");
});

// MARK: 区間の数え方

test("経路の区間は止まる場所で数える（通るだけの点は区間を作らない）", () => {
  // 通る点 T1・T2 → 立ち寄り先 S → 最終目的地 D。サーバは S と D でしか区間を分けない
  const legs = [leg(35.01, { isUserWaypoint: false }), leg(35.02, { isUserWaypoint: false }),
                leg(35.03), leg(35.04)];
  const route = northRoute(5, { legEndAfter: [2] });
  assert.strictEqual(S.routeLegIndexForStep(route.steps, 1), 0);
  assert.strictEqual(S.routeLegIndexForStep(route.steps, 4), 1, "到着の印を数えていない");
  assert.deepStrictEqual(S.routeLegEnds(legs), [2, 3]);
  // 区間の行き先（到着を知らせる相手）
  assert.strictEqual(S.routeLegEndIndex(0, legs), 2, "区間0の行き先が S でない");
  assert.strictEqual(S.routeLegEndIndex(1, legs), 3);
  // 区間の最初の行き先（引き直しはここから）
  assert.strictEqual(S.routeLegStartIndex(0, legs), 0, "区間0の中継点を飛ばしている");
  // ⚠️ **S を過ぎたら D から。** 2026-09-27 までのアプリは「区間1＝legs[1]＝T2」と数えていた
  assert.strictEqual(S.routeLegStartIndex(1, legs), 3, "S を過ぎたのに手前の行き先から引き直す");
  // 通るだけの点が無ければ、区間 i＝i 番目の行き先
  const plain = [leg(35.03), leg(35.04)];
  assert.deepStrictEqual([S.routeLegStartIndex(1, plain), S.routeLegEndIndex(1, plain)], [1, 1]);
});

test("最後の行き先は立ち寄り先でなくても区間の終わり（なぞっただけの経路）", () => {
  // ⚠️ サーバは最後の行き先で必ず区間を終える（止まる場所の番号は最後を除いて数える）
  const legs = [leg(35.01, { isUserWaypoint: false }), leg(35.02, { isUserWaypoint: false })];
  assert.deepStrictEqual(S.routeLegEnds(legs), [1], "最後の行き先で区間を終えていない");
  assert.strictEqual(S.routeLegEndIndex(0, legs), 1, "区間0の行き先が最後の点でない");
  assert.strictEqual(S.routeLegStartIndex(0, legs), 0);
});

test("立ち寄り先を過ぎて引き直すと、通過済みの立ち寄り先へ戻らない", async () => {
  // ⚠️ この画面で再現した壊れ方: 通る点 → S → 終点で、S を過ぎて終点の近くで外れた（止まっていて向きが無い）。
  //    アプリは S へ戻る経路（終点1km手前で19.3km）を引いていた
  const route = northRoute(3, { legEndAfter: [0] });
  const legs = [leg(35.004, { isUserWaypoint: false }), leg(35.009), leg(35.027)];
  const fetch = fakeFetch((b) => straightTo(b));
  const out = await S.simulateReroute({ route, legs, position: [139.0001, 35.0225], heading: null,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.deepStrictEqual(fetch.calls[0].vias, [], "通過済みの立ち寄り先を経由させている");
  assert.deepStrictEqual(out.remaining, [2]);
});

test("外れた地点から、外れる前にいたステップを選ぶ", () => {
  const route = northRoute();
  // 2本目（35.009〜35.018）の途中の東に50m
  const got = S.stepAtPosition(route, [139.00055, 35.0135], 0);
  assert.strictEqual(got.stepIndex, 1);
  assert.ok(got.lateralMeters > 40 && got.lateralMeters < 60, `横のずれ ${got.lateralMeters}`);
});

test("行きと帰りで同じ道を通るなら、進行方向に沿う側を選ぶ", () => {
  // 北へ2km走って同じ道を南へ戻る
  const points = [];
  for (let k = 0; k <= 20; k++) points.push([139.0, 35.0 + (0.018 * k) / 20]);
  for (let k = 19; k >= 0; k--) points.push([139.0, 35.0 + (0.018 * k) / 20]);
  const steps = [
    { maneuver: "straight", distanceMeters: 2000, beginIndex: 0, endIndex: 20 },
    { maneuver: "uturnRight", distanceMeters: 2000, beginIndex: 20, endIndex: 40 },
    { maneuver: "none", isLegEnd: true, distanceMeters: 0, beginIndex: 40, endIndex: 40 },
  ];
  const route = { points, steps };
  assert.strictEqual(S.stepAtPosition(route, [139.0001, 35.009], 180).stepIndex, 1, "南向きなのに行きの側を選んだ");
  assert.strictEqual(S.stepAtPosition(route, [139.0001, 35.009], 0).stepIndex, 0, "北向きなのに帰りの側を選んだ");
});

// MARK: 問題の中継点

test("有料を避ける区間の中継点が有料の上にあれば落とす・立ち寄り先と最後は落とさない", () => {
  const route = northRoute();
  route.steps[1].roadKind = "toll";          // 35.009〜35.018 が有料
  const legs = [leg(35.0135, { isUserWaypoint: false, avoidTolls: true }), leg(35.03)];
  assert.deepStrictEqual(S.problemLegIndices(legs, route), [0], "有料の上の中継点を見逃す");
  // 有料を使ってよい区間なら、上にあるのは当たり前
  assert.deepStrictEqual(S.problemLegIndices([leg(35.0135, { isUserWaypoint: false }), leg(35.03)], route), []);
  // ⚠️ 利用者が決めた立ち寄り先は、有料の上でも落とさない（SA に寄るなど）
  assert.deepStrictEqual(S.problemLegIndices([leg(35.0135, { avoidTolls: true }), leg(35.03)], route), []);
});

test("往復の折り返しのそばの中継点を落とす", () => {
  // 北へ走り、東へ500m入って同じ道を戻り、また北へ（東の先端に中継点）
  const points = [];
  for (let k = 0; k <= 10; k++) points.push([139.0, 35.0 + 0.009 * k / 10]);
  for (let k = 1; k <= 10; k++) points.push([139.0 + 0.0055 * k / 10, 35.009]);
  for (let k = 9; k >= 0; k--) points.push([139.0 + 0.0055 * k / 10, 35.009]);
  for (let k = 1; k <= 10; k++) points.push([139.0, 35.009 + 0.009 * k / 10]);
  const route = { points, steps: [{ maneuver: "straight", beginIndex: 0, endIndex: points.length - 1 }] };
  const legs = [leg(35.009, { isUserWaypoint: false, destination: [139.0055, 35.009] }),
                leg(35.0, { isUserWaypoint: false, destination: [139.02, 35.0] }),   // 折り返しから遠い
                leg(35.018)];
  assert.deepStrictEqual(S.problemLegIndices(legs, route), [0], "往復を強いた中継点を見分けていない");
});

// MARK: 依頼の中身（アプリの requestNavRoutes と同じ）

test("止まる場所・おすすめ道路の終点・区間ごとの条件", () => {
  const legs = [leg(35.01, { isUserWaypoint: false, isRoadCourse: true }),
                leg(35.02, { isRoadCourse: true }), leg(35.03), leg(35.04)];
  const p = S.legPlan(legs, false);
  assert.deepStrictEqual(p.stopAt, [1, 2], "通るだけの点を止まる場所にしている");
  assert.deepStrictEqual(p.throughStopAt, [1], "おすすめ道路の終点で引き返させない印が無い");
  assert.strictEqual(p.legConditions, null, "条件が同じなのに区間ごとに渡している");
  const mixed = S.legPlan([leg(35.01, { avoidTolls: true }), leg(35.02)], false);
  assert.deepStrictEqual(mixed.legConditions,
    [{ avoidTolls: true, avoidHighways: false }, { avoidTolls: false, avoidHighways: false }]);
  assert.strictEqual(mixed.avoidTolls, true, "全体の条件は一番厳しい組み合わせ");
  // 125cc以下は高速に乗れない
  assert.strictEqual(S.legPlan([leg(35.01)], true).avoidHighways, true);
});

test("引き直しの依頼はアプリと同じ形", () => {
  const legs = [leg(35.02, { isUserWaypoint: false, isRoadCourse: true }), leg(35.04)];
  const b = S.rerouteBody(at(35.0), legs, 12, { displacement: "moped50", etc: false, at: "2026-09-27T09:00:00+09:00" });
  assert.deepStrictEqual([b.from, b.to, b.vias], [at(35.0), at(35.04), [at(35.02)]]);
  assert.strictEqual(b.arriveOnNearSide, true, "目的地を渡らずに着ける側へ寄せていない");
  assert.strictEqual(b.alternates, 0, "別の道まで頼んでいる");
  assert.strictEqual(b.heading, 12);
  assert.strictEqual(b.variant, "fun", "楽しい道の区間があるのに作り分けを引き継いでいない");
  assert.strictEqual(b.avoidHighways, true, "原付なのに高速を避けていない");
  assert.strictEqual(b.etc, false);
  assert.strictEqual(b.avoidFerries, true, "渡さなければ船を避ける");
  const plain = S.rerouteBody(at(35.0), [leg(35.04)], -1, { displacement: "large" });
  assert.strictEqual(plain.heading, undefined, "不明（-1）の向きを渡している");
  assert.strictEqual(plain.variant, undefined);
  assert.strictEqual(plain.avoidHighways, false);
  assert.ok(!Number.isNaN(Date.parse(plain.at)), "時刻を渡さなければ今で引く（アプリと同じ）");
});

// MARK: 通しでなぞる

/** 依頼を控えて、決めた経路を返す偽物 */
function fakeFetch(answer) {
  const calls = [];
  const fn = async (body) => { calls.push(body); return answer(body, calls.length); };
  fn.calls = calls;
  return fn;
}

/** 渡された行き先まで、北へ真っすぐ行く経路（先頭の曲がりを指定できる） */
function straightTo(body, maneuvers = ["straight"]) {
  const from = body.from, to = body.to;
  const points = Array.from({ length: 11 }, (_, k) => [from[0] + (to[0] - from[0]) * k / 10,
                                                        from[1] + (to[1] - from[1]) * k / 10]);
  const steps = maneuvers.map((m, i) => ({ maneuver: m, distanceMeters: 100, durationSeconds: 10,
    beginIndex: i === 0 ? 0 : 10, endIndex: 10, roadKind: "surface" }));
  steps.push({ maneuver: "none", isLegEnd: true, distanceMeters: 0, beginIndex: 10, endIndex: 10 });
  const len = Math.round(Math.hypot((to[0] - from[0]) * 91_000, (to[1] - from[1]) * 111_000));
  return { points, steps, lengthMeters: len, durationSeconds: len / 10 };
}

test("先が長ければ外れた分だけ引き直して繋ぐ", async () => {
  const route = northRoute();
  const fetch = fakeFetch((b) => straightTo(b));
  const out = await S.simulateReroute({ route, legs: [leg(35.045)], position: [139.001, 35.004], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.strictEqual(out.strategy, "rejoin", JSON.stringify(out.trace));
  assert.strictEqual(fetch.calls.length, 1);
  // ⚠️ 合流点は止まる場所にしない（止めると合流点で「到着しました」と言う）
  assert.strictEqual(fetch.calls[0].stopAt, undefined, "合流点を止まる場所にしている");
  assert.deepStrictEqual(fetch.calls[0].to, route.points[route.steps[2].beginIndex], "1.5km 先の区切りへ繋いでいない");
  assert.strictEqual(fetch.calls[0].heading, 0, "走っている向きを渡していない");
});

test("大回りなら繋がずに全体を引き直す", async () => {
  const route = northRoute();
  const fetch = fakeFetch((b, n) => (n === 1 ? { ...straightTo(b), lengthMeters: 50_000 } : straightTo(b)));
  const out = await S.simulateReroute({ route, legs: [leg(35.045)], position: [139.001, 35.004], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.strictEqual(out.strategy, "whole");
  assert.deepStrictEqual(fetch.calls[1].to, at(35.045), "全体の引き直しが最終目的地へ向いていない");
  assert.ok(out.trace.some((t) => t.kind === "rejoin" && t.reasonable === false), "大回りを見逃している");
});

test("向きつきで引けなければ向き無しで引き直す", async () => {
  const route = northRoute(2);   // 到着まで1kmしか無い → 繋がず全体
  const fetch = fakeFetch((b) => (b.heading != null ? { error: "No path" } : straightTo(b)));
  const out = await S.simulateReroute({ route, legs: [leg(35.05)], position: [139.001, 35.0135], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.strictEqual(out.strategy, "whole");
  assert.deepStrictEqual(fetch.calls.map((b) => b.heading), [0, undefined], "向き無しで引き直していない");
});

test("いきなり向きを変える形なら、進行方向100m先を挟んでもう一度だけ引く", async () => {
  const route = northRoute(2);
  const fetch = fakeFetch((b, n) => straightTo(b, n === 1 ? ["straight", "turnRight", "turnRight"] : ["straight"]));
  const out = await S.simulateReroute({ route, legs: [leg(35.05)], position: [139.001, 35.0135], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.strictEqual(out.strategy, "nudged", JSON.stringify(out.trace));
  assert.strictEqual(fetch.calls.length, 2);
  const retry = fetch.calls[1];
  assert.strictEqual(retry.vias.length, 1, "誘導点を挟んでいない");
  assert.ok(Math.abs(retry.vias[0][1] - 35.0135 - 100 / 111_195) < 1e-5, "誘導点が進行方向100m先でない");
  assert.strictEqual(retry.stopAt, undefined, "誘導点を止まる場所にしている");
  assert.strictEqual(retry.heading, undefined, "挟んだ引き直しに向きを渡している（アプリは渡さない）");
});

test("挟んでも直らなければ、挟まない経路を使う", async () => {
  const route = northRoute(2);
  const uturn = ["straight", "uturnLeft"];
  const fetch = fakeFetch((b) => straightTo(b, uturn));
  const out = await S.simulateReroute({ route, legs: [leg(35.05)], position: [139.001, 35.0135], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.strictEqual(out.strategy, "whole");
  assert.deepStrictEqual(out.route.points[out.route.points.length - 1], at(35.05));
  assert.strictEqual(fetch.calls[1].vias.length, 1, "挟んで試していない");
  assert.strictEqual(out.route.points.length, 11);
  assert.deepStrictEqual(out.route.points[0], [139.001, 35.0135], "挟まない経路を使っていない");
  assert.strictEqual(fetch.calls.length, 2, "再挑戦は1回だけ");
});

test("目的地が背後なら挟まない（向きを変えるのが正しい）", async () => {
  const route = northRoute(2);
  const fetch = fakeFetch((b) => straightTo(b, ["straight", "uturnLeft"]));
  const out = await S.simulateReroute({ route, legs: [leg(34.99)], position: [139.001, 35.0135], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.strictEqual(fetch.calls.length, 1, "背後の目的地なのに誘導点を挟んだ");
  assert.ok(out.trace.some((t) => t.kind === "uTurn" && t.reason === "destinationBehind"));
});

test("有料に乗せる中継点を落としてもう一度だけ引く", async () => {
  const route = northRoute(2);
  const legs = [leg(35.03, { isUserWaypoint: false, avoidTolls: true }), leg(35.05, { avoidTolls: true })];
  const fetch = fakeFetch((b, n) => {
    const r = straightTo(b);
    if (n === 1) r.steps[0].roadKind = "toll";   // 1回目は全部有料（中継点が上に乗る）
    return r;
  });
  const out = await S.simulateReroute({ route, legs, position: [139.0, 35.0135], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.strictEqual(out.strategy, "trimmed", JSON.stringify(out.trace));
  assert.deepStrictEqual(out.dropped, [0]);
  assert.deepStrictEqual(fetch.calls[1].vias, [], "中継点を落としていない");
  assert.deepStrictEqual(out.remaining, [1]);
});

test("全体を引き直すとき、通り過ぎた中継点へ戻らせない", async () => {
  // 通るだけの点 T1（2km 後ろ）・T2（170m 先）→ 終点。到着まで1km しか無いので全体を引き直す
  const route = northRoute(3);
  const legs = [leg(35.004, { isUserWaypoint: false }), leg(35.024, { isUserWaypoint: false }), leg(35.027)];
  const fetch = fakeFetch((b) => straightTo(b));
  const out = await S.simulateReroute({ route, legs, position: [139.0001, 35.0225], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.deepStrictEqual(fetch.calls[0].vias, [at(35.024)], "通り過ぎた中継点を経由させている");
  assert.deepStrictEqual(out.remaining, [1, 2]);
  assert.ok(out.trace.some((t) => t.kind === "firstLegAhead" && t.from === 0 && t.to === 1));
});

test("中継点を落としても直らなければ、落とさない経路を使う", async () => {
  // 有料を避ける区間の中継点が2つとも有料の上。1回目は近いほう1つだけ落とす（アプリと同じ）ので直らない
  const route = northRoute(2);
  const legs = [leg(35.02, { isUserWaypoint: false, avoidTolls: true }),
                leg(35.03, { isUserWaypoint: false, avoidTolls: true }), leg(35.05, { avoidTolls: true })];
  const fetch = fakeFetch((b, n) => {
    const r = straightTo(b);
    r.steps[0].roadKind = "toll";
    r.call = n;                                  // 何回目に引いた経路か
    return r;
  });
  const out = await S.simulateReroute({ route, legs, position: [139.0, 35.0135], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.strictEqual(fetch.calls.length, 2, "落として引き直していない／何度も引き直している");
  assert.strictEqual(out.strategy, "whole", JSON.stringify(out.trace));
  assert.deepStrictEqual(out.remaining, [0, 1, 2], "直らなかったのに中継点を落とした");
  assert.strictEqual(out.route.call, 1, "落とさない経路（1回目）を使っていない");
  assert.ok(out.trace.some((t) => t.kind === "trimResult" && t.good === false));
});

test("通り過ぎた立ち寄り先から引き直さない", async () => {
  // 立ち寄り先 A（35.009）を過ぎて北へ走っている。先が短いので全体を引き直す
  const route = northRoute(2, { legEndAfter: [0] });
  const legs = [leg(35.009), leg(35.03)];
  const fetch = fakeFetch((b) => straightTo(b));
  const out = await S.simulateReroute({ route, legs, position: [139.001, 35.015], heading: 0,
                                        bike: { displacement: "large" }, fetchRoute: fetch });
  assert.deepStrictEqual(fetch.calls[0].to, at(35.03));
  assert.deepStrictEqual(fetch.calls[0].vias, [], "通り過ぎた立ち寄り先へ戻らせている");
  assert.deepStrictEqual(out.remaining, [1]);
});

// MARK: 画面と窓口の配線

const fs = require("fs");
const path = require("path");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("画面は、出ている案の線と行き先の並びと外れた地点を窓口へ送る", () => {
  const html = read("public", "valhalla.html");
  assert.ok(html.includes("await fetch(\"/api/valhalla/reroute\""), "引き直しの窓口を呼んでいない");
  // ⚠️ **画面の線をそのまま送る。** サーバで引き直すと、画面の案と違う経路から外れたことになる
  assert.ok(html.includes("route:{ points:base.points, steps:base.steps,"), "画面の案の線を送っていない");
  assert.ok(html.includes("heading: checked(\"rrNoHeading\") ? null : rr.heading,"), "向きが取れないときに null を送っていない");
  // ⚠️ 置いている間の地図のクリックは、経由地を足さない
  assert.ok(html.includes("if (rr.placing) rrPlaceAt(p);\n    else addPoint(p);"), "置いている間も経由地を足している");
  // 行き先の並び: 手で置いた経由地 → 楽しい道の中継点（通るだけ・おすすめ道路）→ 終点
  assert.ok(html.includes("return [...hand, ...auto, { ...common, destination:state.to, isUserWaypoint:true,"),
    "行き先の並びがサーバの経由地の順と違う");
  assert.ok(/const auto = \(r\.autoVias \|\| \[\]\)\.map\(\(p, i\) => \(\{ \.\.\.common, destination:p,\s+isUserWaypoint:false, isRoadCourse:true,/.test(html),
    "楽しい道の中継点を「通るだけ・おすすめ道路」にしていない（作り分けが引き継がれない）");
});

test("手で置いた経由地は既定で立ち寄り先として引く（アプリの立ち寄り先と同じ）", () => {
  const html = read("public", "valhalla.html");
  assert.strictEqual((html.match(/vias:state\.vias, stopAt:viaStopAt\(\),/g) || []).length, 2,
    "ふつう・楽しい道の両方で止まる場所を送っていない");
  assert.ok(html.includes("else { state.vias.push(p); state.viaStops.push(true); }"), "経由地の既定が立ち寄るでない");
  assert.ok(html.includes("const viaStopAt = () => state.vias.map((_, i) => i).filter((i) => state.viaStops[i] !== false);"));
});

test("窓口はアプリと同じ引き方で1本ずつ引き、楽しい道の案は通した中継点を返す", () => {
  const server = read("server.js");
  const at = server.indexOf("app.post(\"/api/valhalla/reroute\"");
  assert.ok(at > 0, "引き直しの窓口が無い");
  const body = server.slice(at, server.indexOf("\n});", at));
  assert.ok(body.includes("const opts = routeOptionsFromBody(body, { restrictionsFor });"), "アプリと同じ関数で条件を作っていない");
  assert.ok(body.includes("return routeWithValhallaSegmented(body.from, body.to, opts);"), "アプリと同じ引き方でない");
  assert.ok(body.includes("heading: Number.isFinite(heading) ? heading : null,"), "向きの無い依頼を受けられない");
  assert.ok(server.includes("r.autoVias = refined.picked.waypoints;"), "楽しい道の案が中継点を返していない");
});

// MARK: 実際の経路で（Valhalla）

const { routeOptionsFromBody } = require("../../service/lib/buildRoute");
const { routeWithValhallaSegmented } = require("../lib/segmentedRoute");
const { BASE } = require("../lib/valhallaRoute");

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}

test("実際の経路: 先が長ければ繋ぎ、元の続きはそのまま・立ち寄り先の手前なら全体を引き直す（Valhalla）", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  const restrictionsFor = async () => ({ restrictions: [], prefectures: [] });
  const fetchRoute = (body) => routeWithValhallaSegmented(body.from, body.to, routeOptionsFromBody(body, { restrictionsFor }));
  const from = [139.5656, 35.7897], to = [139.0850, 35.9920], via = [139.35, 35.85];
  const route = await fetchRoute({ from, to, vias: [via], stopAt: [0], displacement: "large", arriveOnNearSide: true });
  const legs = [{ destination: via, isUserWaypoint: true }, { destination: to, isUserWaypoint: true }];
  const stopStep = route.steps.findIndex((s) => s.isLegEnd);
  assert.ok(stopStep > 0 && stopStep < route.steps.length - 1, "材料が悪い: 立ち寄り先で区間が分かれていない");
  const aside = (k) => {
    const p = route.points[k];
    const brg = S.bearing(p, route.points[k + 1]);
    return { pos: S.pointFrom(p, (brg + 90) % 360, 120), heading: Math.round(brg) };
  };

  // 走り出してすぐ外れた
  const a = aside(200);
  const early = await S.simulateReroute({ route, legs, position: a.pos, heading: a.heading,
                                          bike: { displacement: "large" }, fetchRoute });
  assert.strictEqual(early.strategy, "rejoin", JSON.stringify(early.trace));
  const tail = route.points.slice(route.steps[early.trace.find((x) => x.kind === "rejoin").rejoinAt].beginIndex);
  assert.deepStrictEqual(early.route.points.slice(-tail.length), tail, "元の続きの線が変わっている");
  assert.strictEqual(early.route.steps.filter((s) => s.isLegEnd).length, 2, "立ち寄り先の到着が消えた／合流点で到着と言う");

  // 立ち寄り先の少し手前で外れた（1.5km 先に立ち寄り先がある）
  const b = aside(route.steps[stopStep].beginIndex - 15);
  const calls = [];
  const near = await S.simulateReroute({ route, legs, position: b.pos, heading: b.heading,
    bike: { displacement: "large" }, fetchRoute: (body) => { calls.push(body); return fetchRoute(body); } });
  assert.ok(near.trace.some((x) => x.kind === "rejoinSkipped" && x.reason === "legEnd"), JSON.stringify(near.trace));
  assert.deepStrictEqual(calls[0].stopAt, [0], "全体の引き直しで立ち寄り先を止まる場所にしていない");
  assert.ok(["whole", "nudged", "trimmed"].includes(near.strategy), near.strategy);
});
