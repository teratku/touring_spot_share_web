"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { segmentsBetween } = require("../lib/roadRecommendIndex");
const {
  selectFunRoads, isWithinCorridor, orderedByProgress, twoOptImprove,
  worstBackwardExcursion, waypointsFor, pathLength, project, distance, midpoint,
  MIN_AUTO_SCORE, MIN_CURVINESS, MIN_SEGMENT_LENGTH_KM,
  CORRIDOR_CAP_METERS, CIRCUITY_FACTOR, MAX_BACKWARD_EXCURSION_METERS,
  MAX_OVERSHOOT_RATIO, buildFunVariants, overlapRatio, MAX_VARIANT_OVERLAP,
  bearing, sideBearing, matchesSide, normalizeSide, SIDES, SIDE_LABELS,
  buildSideVariants,
} = require("../lib/funRouteSelect");

/**
 * 楽しい道を何本か選んで並べるところ（`FunRouteBuilder.swift` の移植）。
 *
 * ⚠️ ネットワークは叩かない。実際に Valhalla で引いて確かめるのは
 *    test/valhallaLive.test.js の方。
 */

const KOFU = [138.5684, 35.6642];
//: 手で作る材料の基準（甲府のあたり・東西にまっすぐ並べる）
const KOFU_LNG = 138.5684;
const FUJI_LAT = 35.6642;
const FUJI = [138.8087, 35.4876];

/** 手で作った区間。start / end は配信データと同じ [緯度, 経度] */
function seg(o) {
  return {
    id: o.id || o.name, name: o.name,
    score: o.score ?? 80, lengthKm: o.lengthKm ?? 5, curviness: o.curviness ?? 600,
    start: o.start, end: o.end,
  };
}

const yamanashi = (() => {
  const p = path.join(__dirname, "..", "data", "road-recommend", "yamanashi.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).segments : null;
})();

// MARK: 候補を絞る

test("点数の低い道は自動では選ばない", () => {
  // ⚠️ 配信データは県ごとに上位150区間を残すので、平地の県では
  //    「数合わせ」の道が混じる。それを勝手に組み込むと遠回りしたのに面白くない
  const dd = distance(KOFU, FUJI);
  const low = seg({ name: "数合わせ", score: MIN_AUTO_SCORE - 1,
                    start: [35.60, 138.65], end: [35.59, 138.66] });
  const out = selectFunRoads(KOFU, FUJI, [low], { count: 4 });
  assert.strictEqual(out.segments.length, 0,
    `${MIN_AUTO_SCORE}点未満の道を選んでいる`);
  // コリドー自体は通ることを確かめておく（落ちた理由が点数であること）
  assert.ok(isWithinCorridor(low, KOFU, FUJI, dd), "そもそもコリドーで落ちている");
});

test("曲がっていない道は「楽しい道」として選ばない", () => {
  // ⚠️ どれだけ寄り道が少なくて済んでも、直線の幹線を「楽しい道」にしない。
  //    実測で本物の峠は曲率600〜870、平野の幹線は170前後
  const dd = distance(KOFU, FUJI);
  const straight = seg({ name: "平野の幹線", curviness: MIN_CURVINESS - 1,
                         start: [35.60, 138.65], end: [35.59, 138.66] });
  assert.ok(!isWithinCorridor(straight, KOFU, FUJI, dd), "直線の幹線を通している");
});

test("短すぎる道は拾わない", () => {
  const dd = distance(KOFU, FUJI);
  const tiny = seg({ name: "短い道", lengthKm: MIN_SEGMENT_LENGTH_KM - 0.1,
                     start: [35.60, 138.65], end: [35.59, 138.66] });
  assert.ok(!isWithinCorridor(tiny, KOFU, FUJI, dd), "短すぎる道を通している");
});

test("横に離れすぎた道は落とす", () => {
  const dd = distance(KOFU, FUJI);
  const near = seg({ name: "近い", lengthKm: 5, start: [35.58, 138.68], end: [35.57, 138.69] });
  // ⚠️ 直線から遠く離れた道。**離れているほど遠回りが大きくなる**
  const far = seg({ name: "遠い", lengthKm: 5, start: [36.30, 138.20], end: [36.29, 138.21] });
  assert.ok(isWithinCorridor(near, KOFU, FUJI, dd), "近い道が落ちている");
  assert.ok(!isWithinCorridor(far, KOFU, FUJI, dd), "遠い道を通している");
});

test("長距離でも横の許容が青天井にならない", () => {
  // ⚠️ 比例項だけだと長距離ほど際限なく広がり、遠くの区間を寄せ集めて
  //    回り込む経路になる（実測: 東京→仙台で横190kmまで許してしまった）
  const tokyo = [139.7671, 35.6812], sendai = [140.8694, 38.2682];
  const dd = distance(tokyo, sendai);           // 約300km
  // 比例項なら 300km × 0.30 = 90km まで許してしまうところ
  // 横50km（上限25kmより外・比例項91kmより内）にある道
  const wayOff = seg({ name: "遠すぎ", lengthKm: 30,
                       start: [36.97, 139.67], end: [36.97, 139.77] });
  const lateral = project([139.72, 36.97], [tokyo, sendai]).lateralDistance;
  assert.ok(lateral > CORRIDOR_CAP_METERS && lateral < dd * 0.30,
    `材料が悪い（横${Math.round(lateral / 1000)}km。上限${CORRIDOR_CAP_METERS / 1000}kmと`
    + `比例項${Math.round(dd * 0.30 / 1000)}kmのあいだであること）`);
  assert.ok(!isWithinCorridor(wayOff, tokyo, sendai, dd),
    `横${Math.round(lateral / 1000)}km の道を通している（上限は${CORRIDOR_CAP_METERS / 1000}km）`);
});

// MARK: 並べる

test("進み具合の順に並ぶ（挿入順ではない）", () => {
  // ⚠️ 挿入順に並べると行ったり来たりする経路になる
  const a = seg({ name: "手前", start: [35.65, 138.60], end: [35.64, 138.61] });
  const b = seg({ name: "中ほど", start: [35.58, 138.68], end: [35.57, 138.69] });
  const c = seg({ name: "終盤", start: [35.51, 138.77], end: [35.50, 138.78] });
  const out = orderedByProgress([c, a, b], KOFU, FUJI).map((s) => s.name);
  assert.deepStrictEqual(out, ["手前", "中ほど", "終盤"], "並びが進み具合になっていない");
});

test("並べ替えで短くなるなら入れ替える", () => {
  // ⚠️ 中点だけの並びが最善とは限らない。2-opt で入れ替えて短くする
  const a = seg({ name: "A", start: [35.65, 138.60], end: [35.64, 138.61] });
  const b = seg({ name: "B", start: [35.58, 138.68], end: [35.57, 138.69] });
  const c = seg({ name: "C", start: [35.51, 138.77], end: [35.50, 138.78] });
  const bad = [c, b, a];                       // わざと逆に並べる
  const badLength = pathLength(bad, KOFU, FUJI);
  const fixed = twoOptImprove(bad, KOFU, FUJI);
  assert.ok(pathLength(fixed, KOFU, FUJI) < badLength,
    "逆順のままで短くなっていない（2-optが効いていない）");
});

test("入口・出口の並びで経由地になる", () => {
  const a = seg({ name: "A", start: [35.65, 138.60], end: [35.64, 138.61] });
  const b = seg({ name: "B", start: [35.58, 138.68], end: [35.57, 138.69] });
  const wps = waypointsFor([a, b], KOFU, FUJI);
  assert.strictEqual(wps.length, 4, "1本につき入口・出口の2点になっていない");
  // ⚠️ [経度, 緯度] で出ること。入れ替わると地図でアフリカ沖に飛ぶ
  wps.forEach(([lng, lat], i) => {
    assert.ok(lng > 122 && lng < 154, `${i}番目の経度がおかしい: ${lng}`);
    assert.ok(lat > 24 && lat < 46, `${i}番目の緯度がおかしい: ${lat}`);
  });
});

test("進む向きに通り抜ける（行って戻らない）", () => {
  // ⚠️ 入口が近くても、通り抜ける向きが逆だと「行って戻る」になる。
  //    この道は北西→南東に伸びており、旅の向きと同じ。
  //    近いのは北西端なので、そこから入るのが正しい
  const s = seg({ name: "順路の道", start: [35.62, 138.62], end: [35.56, 138.70] });
  const wps = waypointsFor([s], KOFU, FUJI);
  const axis = [KOFU, FUJI];
  const entryAt = project(wps[0], axis).along;
  const exitAt = project(wps[1], axis).along;
  assert.ok(exitAt > entryAt,
    `出口(${Math.round(exitAt)}m)が入口(${Math.round(entryAt)}m)より手前。逆向きに通っている`);
});

/**
 * ⚠️ **接近距離だけで入口を決めないこと。** 入口が近くても、通り抜ける向きが
 *    旅の進みに逆らっていると「行って戻る」になる。
 *    材料は実データの東山広域農道（フルーツライン）。接近距離だけで決めると
 *    逆向きに通り、軸の上で後退する。
 */
test("近い方から入ると逆走になる道では、遠い方から入る", () => {
  if (!yamanashi) return;
  const road = yamanashi.find((s) => s.name.includes("東山広域農道"));
  if (!road) return;

  const A = [road.start[1], road.start[0]];
  const B = [road.end[1], road.end[0]];
  // 接近距離だけで決めたときの入口
  const naive = (distance(KOFU, A) + distance(B, FUJI) <= distance(KOFU, B) + distance(A, FUJI))
    ? A : B;

  const wps = waypointsFor([road], KOFU, FUJI);
  const axis = [KOFU, FUJI];
  const forward = project(wps[1], axis).along - project(wps[0], axis).along;

  assert.ok(forward > 0,
    `軸の上で ${Math.round(forward)}m しか進んでいない（逆向きに通っている）`);
  assert.ok(wps[0][0] !== naive[0] || wps[0][1] !== naive[1],
    "接近距離だけで決めた入口と同じ。後退ペナルティが効いていない");
});

/**
 * ⚠️ **後退の見方を削らないこと。** 後退は2つに分かれる:
 *      ① いまの位置から入口まで戻る分
 *      ② 入口から出口へ、区間の中を逆向きに走る分
 *    実データ（三井相模湖線）で、①がどちらも前向きなのに②が878.7m後退している
 *    ケースがあり、②を見ていなかったため誤った入口を選んでいた。
 *
 *    材料は河口湖御坂線（御坂みち）。**①②のどちらを外しても入口が変わる。**
 */
test("入口から出口への向き自体の後退も見る", () => {
  if (!yamanashi) return;
  const road = yamanashi.find((s) => s.name.includes("御坂みち"));
  if (!road) return;

  const A = [road.start[1], road.start[0]];
  const B = [road.end[1], road.end[0]];
  const wps = waypointsFor([road], KOFU, FUJI);

  // この道は end から入るのが正しい（実データで確認済み）
  assert.deepStrictEqual(wps[0], B,
    `入口が start 側になっている（正しくは end 側）。`
    + `後退の見方（cursor→入口／入口→出口）のどちらかが抜けていないか`);
  assert.deepStrictEqual(wps[1], A, "出口が合っていない");

  const axis = [KOFU, FUJI];
  const forward = project(wps[1], axis).along - project(wps[0], axis).along;
  assert.ok(forward > 0, `軸の上で ${Math.round(forward)}m しか進んでいない`);
});

test("大きく後退する道は諦める", () => {
  // ⚠️ 「Uターンしかないなら楽しい道を通す必要はない」。
  //    点数がいちばん低いものから外して選び直す
  const good = seg({ name: "順路", score: 85, start: [35.60, 138.65], end: [35.56, 138.70] });
  const back = seg({ name: "戻る道", score: 50, start: [35.52, 138.76], end: [35.62, 138.60] });
  const excursion = worstBackwardExcursion([good, back], KOFU, FUJI);
  assert.ok(excursion > MAX_BACKWARD_EXCURSION_METERS,
    `材料が悪い（後退${Math.round(excursion)}m。${MAX_BACKWARD_EXCURSION_METERS}m を超えること）`);
  const out = selectFunRoads(KOFU, FUJI, [good, back], { count: 2 });
  assert.ok(!out.segments.some((s) => s.name === "戻る道"),
    "大きく後退する道を通している");
  // ⚠️ 名前だけでなく鍵（id）も返す。APIに日本語を混ぜないため
  assert.deepStrictEqual(out.uTurnOnly, [{ id: "戻る道", name: "戻る道" }],
    "諦めた道が {id, name} で記録されていない");
});

// MARK: 選ぶ

test("予算に収まるぶんだけ選ぶ", () => {
  if (!yamanashi) return;
  // ⚠️ 予算が小さいほど本数が減ること。増えたら予算が効いていない
  const tight = selectFunRoads(KOFU, FUJI, yamanashi, { count: 8, budgetRatio: 1.2 });
  const loose = selectFunRoads(KOFU, FUJI, yamanashi, { count: 8, budgetRatio: 3.0 });
  assert.ok(tight.segments.length < loose.segments.length,
    `予算1.2倍で${tight.segments.length}本、3.0倍で${loose.segments.length}本。予算が効いていない`);
});

test("本数の上限を守る", () => {
  if (!yamanashi) return;
  for (const n of [1, 2, 4]) {
    const out = selectFunRoads(KOFU, FUJI, yamanashi, { count: n, budgetRatio: 3.0 });
    assert.ok(out.segments.length <= n,
      `${n}本のはずが ${out.segments.length}本 選ばれている`);
  }
});

test("点数の高い道から採る（寄り道の安さで選ばない）", () => {
  if (!yamanashi) return;
  // ⚠️ 点数÷遠回り距離 で選ぶと、直線のすぐ脇の**凡庸な道が「安い」だけで勝つ**。
  //    実測（東京→みどり市）でそうなった: 平野の幹線7本（平均曲率180）が選ばれた
  const out = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4 });
  assert.ok(out.segments.length > 0, "1本も選ばれていない");
  const worst = Math.min(...out.segments.map((s) => s.score));
  assert.ok(worst >= 80,
    `選ばれた中に${worst}点の道がある。点数順に採れていない`);
  const curvy = Math.min(...out.segments.map((s) => s.curviness));
  assert.ok(curvy >= MIN_CURVINESS, `曲率${Math.round(curvy)}の道が混じっている`);
});

test("同じ道を二度選ばない", () => {
  if (!yamanashi) return;
  const out = selectFunRoads(KOFU, FUJI, yamanashi, { count: 8, budgetRatio: 3.0 });
  const ids = out.segments.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, "同じ道が二度入っている");
});

test("本数を増やすと経路が長くなる", () => {
  if (!yamanashi) return;
  const two = selectFunRoads(KOFU, FUJI, yamanashi, { count: 2, budgetRatio: 3.0 });
  const four = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4, budgetRatio: 3.0 });
  assert.ok(four.estimatedMeters > two.estimatedMeters,
    `2本${(two.estimatedMeters/1000).toFixed(1)}km より `
    + `4本${(four.estimatedMeters/1000).toFixed(1)}km が長くない`);
});

test("道が無ければ空で返す（落ちない）", () => {
  const out = selectFunRoads(KOFU, FUJI, [], { count: 4 });
  assert.deepStrictEqual(out.segments, []);
  assert.deepStrictEqual(out.waypoints, []);
  assert.strictEqual(out.detourRatio, 1);
});

test("見積もりは直線ではなく道のりで見る", () => {
  // ⚠️ 直線で見積もると予算が大幅に甘くなる（実測: 直線90.7kmに対し実際131.3km）
  const s = seg({ name: "途中の道", lengthKm: 10, start: [35.60, 138.65], end: [35.56, 138.70] });
  const estimated = pathLength([s], KOFU, FUJI);
  const straightOnly = distance(KOFU, [138.65, 35.60]) + 10_000 + distance([138.70, 35.56], FUJI);
  assert.ok(estimated > straightOnly * 1.2,
    `直線のまま足している（見積もり${Math.round(estimated)}m / 直線${Math.round(straightOnly)}m。`
    + `係数${CIRCUITY_FACTOR}が掛かっていない）`);
});

// MARK: 軸の外へはみ出す道

/**
 * ⚠️ **目的地より先の道を拾うと一筆書きにならない。**
 *    実機で報告された形（新座→愛川で、9.3km先の秦野清川線まで下りて戻っていた）。
 *
 * ⚠️ **横ズレの判定では防げない。** 射影を [0,1] に丸めているので、
 *    目的地より先の点の横ズレは「目的地までの距離」になる。
 *    9.3km のはみ出しは、そのときの許容 11.7km に収まって素通りしていた。
 */
test("目的地より先にある道は通さない", () => {
  const dd = distance(KOFU, FUJI);              // 約22km
  const limit = dd * MAX_OVERSHOOT_RATIO;
  // 目的地の先、はみ出し上限の3倍のところにある道
  const beyond = 3 * limit;
  const far = seg({ name: "行き過ぎ", lengthKm: 5,
                    start: [FUJI[1] - 0.02, FUJI[0] + beyond / 90527],
                    end: [FUJI[1] - 0.03, FUJI[0] + beyond / 90527 + 0.01] });
  // ⚠️ 横ズレの判定だけなら通ってしまうことを、まず確かめる
  const lateral = project(midpoint(far), [KOFU, FUJI]).lateralDistance;
  const allowed = Math.min(Math.min(dd * 0.30, CORRIDOR_CAP_METERS),
                           Math.max(5000, 3 * 5 * 1000));
  assert.ok(lateral <= allowed,
    `材料が悪い（横ズレ${Math.round(lateral)}m が許容${Math.round(allowed)}m を超えている。`
    + "はみ出しの判定を試せない）");

  assert.ok(!isWithinCorridor(far, KOFU, FUJI, dd),
    `目的地より ${Math.round(beyond / 1000)}km 先の道を通している`);
});

test("出発地より手前にある道も通さない", () => {
  const dd = distance(KOFU, FUJI);
  const behind = 3 * dd * MAX_OVERSHOOT_RATIO;
  const back = seg({ name: "手前すぎ", lengthKm: 5,
                     start: [KOFU[1] + 0.02, KOFU[0] - behind / 90527],
                     end: [KOFU[1] + 0.03, KOFU[0] - behind / 90527 - 0.01] });
  assert.ok(!isWithinCorridor(back, KOFU, FUJI, dd), "出発地より手前の道を通している");
});

test("少しのはみ出しは許す", () => {
  // ⚠️ 0にすると、目的地のすぐ手前にある良い道まで落ちる
  const dd = distance(KOFU, FUJI);
  const little = dd * MAX_OVERSHOOT_RATIO * 0.5;
  const just = seg({ name: "ちょっと先", lengthKm: 5,
                     start: [FUJI[1] - 0.005, FUJI[0] + little / 90527],
                     end: [FUJI[1] - 0.015, FUJI[0] + little / 90527 + 0.005] });
  assert.ok(isWithinCorridor(just, KOFU, FUJI, dd),
    `${Math.round(little)}m のはみ出しで落としている（上限は ${Math.round(dd * MAX_OVERSHOOT_RATIO)}m）`);
});

// MARK: 楽しい道の案を何通りか

test("楽しい道の案を複数出す", () => {
  if (!yamanashi) return;
  // ⚠️ 1本しか出ないと「他の道筋を見たい」に応えられない
  const vs = buildFunVariants(KOFU, FUJI, yamanashi, { count: 4 });
  assert.ok(vs.length >= 2, `${vs.length}通りしか出ていない`);
  assert.ok(vs.every((v) => v.segments.length > 0), "道が1本も入っていない案がある");
});

test("案どうしは違う道筋になる", () => {
  if (!yamanashi) return;
  const vs = buildFunVariants(KOFU, FUJI, yamanashi, { count: 4 });
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      const same = vs[i].segments.map((s) => s.id).join(",")
                 === vs[j].segments.map((s) => s.id).join(",");
      assert.ok(!same,
        `「${vs[i].label}」と「${vs[j].label}」が同じ道筋（${vs[i].segments.map((s) => s.name).join("・")}）`);
    }
  }
});

test("たっぷりが最初に来る", () => {
  if (!yamanashi) return;
  // ⚠️ **画面はいちばん最初の案を選んで見せる。** 順番が変わると、
  //    「楽しい」を選んだのにひかえめが出る
  const vs = buildFunVariants(KOFU, FUJI, yamanashi, { count: 4 });
  assert.strictEqual(vs[0].kind, "generous",
    `先頭が ${vs[0].kind}（並び: ${vs.map((v) => v.kind).join(" → ")}）`);
  // ⚠️ 先頭だけ見ても、並び全体が逆になっているのは捕まえられない。
  //    作った順（たっぷり → ひかえめ → 別ルート → もっと寄り道）で並ぶこと
  const ORDER = ["generous", "modest", "alternate", "wide"];
  const got = vs.map((v) => v.kind);
  const want = ORDER.filter((k) => got.includes(k));
  assert.deepStrictEqual(got, want,
    `並びが違う（${got.join(" → ")}。${want.join(" → ")} のはず）`);
});

test("ひかえめは、たっぷりより寄り道が少ない", () => {
  if (!yamanashi) return;
  const vs = buildFunVariants(KOFU, FUJI, yamanashi, { count: 4 });
  const generous = vs.find((v) => v.kind === "generous");
  const modest = vs.find((v) => v.kind === "modest");
  // ⚠️ **「出なければ飛ばす」にしないこと。** 予算を絞るのをやめると
  //    ひかえめが たっぷり と同じ中身になり、重なり1で捨てられて
  //    「出ないから飛ばす」で通ってしまう。山梨では必ず出る
  assert.ok(modest, "ひかえめが出ていない（予算を絞れていない）");
  assert.ok(modest.estimatedMeters < generous.estimatedMeters,
    `ひかえめ${(modest.estimatedMeters/1000).toFixed(1)}km が `
    + `たっぷり${(generous.estimatedMeters/1000).toFixed(1)}km より短くない`);
});

test("別ルートは、たっぷりの上位を外して作る", () => {
  if (!yamanashi) return;
  const vs = buildFunVariants(KOFU, FUJI, yamanashi, { count: 4 });
  const generous = vs.find((v) => v.kind === "generous");
  const alt = vs.find((v) => v.kind === "alternate");
  // ⚠️ ここも「出なければ飛ばす」にしない。上位を外さないと
  //    たっぷりと同じ中身になり、重なり1で捨てられる
  assert.ok(alt, "別ルートが出ていない（上位を外せていない）");
  const top2 = generous.segments.slice().sort((a, b) => b.score - a.score)
    .slice(0, 2).map((s) => s.id);
  for (const id of top2) {
    assert.ok(!alt.segments.some((s) => s.id === id),
      `別ルートに たっぷり の上位（${id}）が残っている`);
  }
  const overlap = overlapRatio(generous.segments, alt.segments);
  assert.ok(overlap < MAX_VARIANT_OVERLAP,
    `別ルートが たっぷり と ${(overlap * 100).toFixed(0)}% 重なっている`);
});

/**
 * ⚠️ **重なりの上限を外さないこと。** 上位2本を外しても、残りが少ない地域では
 *    別ルートが たっぷり の半分をそのまま含むことがある。
 *    その形は「別ルート」と呼べないので捨てる。
 *
 *    材料は手で作る（実データでは重なりがちょうど 0.5 になる形が作れない）。
 *    道が4本しか無い地域を想定: たっぷり={A,B,C,D} / 上位2本を外すと
 *    別ルート={C,D} になり、重なりは 2/4 = 0.5 でちょうど上限に当たる。
 */
test("重なりすぎる別ルートは出さない", () => {
  const east = (m) => m / 90527;
  const north = (m) => m / 110574;
  const at = (e, n) => [FUJI_LAT + north(n), KOFU_LNG + east(e)];   // [緯度, 経度]
  const four = [
    seg({ id:"A", name:"A", score:90, lengthKm:2, start:at(3000, 200), end:at(4000, 200) }),
    seg({ id:"B", name:"B", score:85, lengthKm:2, start:at(7000, 200), end:at(8000, 200) }),
    seg({ id:"C", name:"C", score:80, lengthKm:2, start:at(11000, 200), end:at(12000, 200) }),
    seg({ id:"D", name:"D", score:75, lengthKm:2, start:at(15000, 200), end:at(16000, 200) }),
  ];
  const from = [KOFU_LNG, FUJI_LAT];
  const to = [KOFU_LNG + east(19000), FUJI_LAT];

  const vs = buildFunVariants(from, to, four, { count: 4, budgetRatio: 3.0 });
  const generous = vs.find((v) => v.kind === "generous");
  assert.strictEqual(generous.segments.length, 4, "材料が悪い（4本とも入ること）");

  const alt = vs.find((v) => v.kind === "alternate");
  if (alt) {
    const overlap = overlapRatio(generous.segments, alt.segments);
    assert.ok(overlap < MAX_VARIANT_OVERLAP,
      `重なり${(overlap * 100).toFixed(0)}%の別ルートを出している（上限${MAX_VARIANT_OVERLAP * 100}%）`);
  }
});

test("重なり具合の計算", () => {
  const a = [{ id:"1" }, { id:"2" }];
  assert.strictEqual(overlapRatio(a, a), 1, "同じ集合が1にならない");
  assert.strictEqual(overlapRatio(a, [{ id:"3" }]), 0, "違う集合が0にならない");
  assert.strictEqual(overlapRatio(a, [{ id:"2" }, { id:"3" }]), 1 / 3);
  assert.strictEqual(overlapRatio([], []), 0, "空どうしで落ちている");
});

test("道が無ければ案も出ない（落ちない）", () => {
  assert.deepStrictEqual(buildFunVariants(KOFU, FUJI, [], { count: 4 }), []);
});

/**
 * ⚠️ **足りないときは幅を広げて拾い直す。**
 *    近くに良い道が1本しか無いと、ひかえめは たっぷり と同じになって消え、
 *    別ルートは唯一の区間を除外するので出ない。結果、案が1通りしか出ない。
 *    実データで起きるのが 所沢→相模原（Swift 側のコメントにある実例と同じ）。
 */
test("案が足りないときは幅を広げて足す", () => {
  const from = [139.4690, 35.7997], to = [139.3730, 35.5710];   // 所沢 → 相模原
  const { segments } = segmentsBetween(from, to);
  if (!segments.length) return;
  const vs = buildFunVariants(from, to, segments, { count: 4 });
  const wide = vs.find((v) => v.kind === "wide");
  assert.ok(wide, `「もっと寄り道」が出ていない（${vs.map((v) => v.kind).join(" → ")}）`);
});

/**
 * ⚠️ **「もっと寄り道」は、他の案に無い道が増えていること。**
 *    たっぷり＝{a,b} / 別ルート＝{c,d} に対して {a,c} を組み替えただけの候補が
 *    「もっと寄り道」を名乗るのを防ぐ。
 */
test("もっと寄り道は、他の案に無い道を含む", () => {
  for (const [from, to] of [[[139.4690, 35.7997], [139.3730, 35.5710]],   // 所沢→相模原
                            [[137.9720, 36.2380], [138.2490, 36.4020]]]) { // 松本→上田
    const { segments } = segmentsBetween(from, to);
    if (!segments.length) continue;
    const vs = buildFunVariants(from, to, segments, { count: 4 });
    const wide = vs.find((v) => v.kind === "wide");
    if (!wide) continue;
    const others = vs.filter((v) => v.kind !== "wide");
    const fresh = wide.segments.filter((c) =>
      !others.some((v) => v.segments.some((s) => s.id === c.id)));
    assert.ok(fresh.length > 0,
      `「もっと寄り道」に新しい道が1本も無い（${wide.segments.map((s) => s.name).join("・")}）`);
  }
});

// MARK: どちら側へ回り込むか

test("方角を測れる", () => {
  const at = [139.0, 35.0];
  assert.ok(Math.abs(bearing(at, [139.0, 35.1]) - 0) < 1, "北が0度になっていない");
  assert.ok(Math.abs(bearing(at, [139.1, 35.0]) - 90) < 1, "東が90度になっていない");
  assert.ok(Math.abs(bearing(at, [139.0, 34.9]) - 180) < 1, "南が180度になっていない");
  assert.ok(Math.abs(bearing(at, [138.9, 35.0]) - 270) < 1, "西が270度になっていない");
});

test("半平面で見る（真横まで含める）", () => {
  // ⚠️ **「北まわり」は北西も北東も含む。** 真北しか通さないと、
  //    候補が旅の向きと直角に集まる以上、ほとんど何も残らない
  assert.ok(matchesSide(SIDES.north, 0), "真北が北に入っていない");
  assert.ok(matchesSide(SIDES.north, 45), "北東が北に入っていない");
  assert.ok(matchesSide(SIDES.north, 315), "北西が北に入っていない");
  assert.ok(!matchesSide(SIDES.north, 90), "真東まで北に入れている");
  assert.ok(!matchesSide(SIDES.north, 180), "南が北に入っている");
});

test("方角が定まらないときは、どの向きにも入れない", () => {
  assert.strictEqual(matchesSide(SIDES.north, null), false);
});

test("方角の書き方をいくつか受ける", () => {
  assert.strictEqual(normalizeSide("north"), 0);
  assert.strictEqual(normalizeSide("北"), 0);
  assert.strictEqual(normalizeSide("south"), 180);
  assert.strictEqual(normalizeSide(45), 45);
  assert.strictEqual(normalizeSide(""), null);
  assert.strictEqual(normalizeSide(null), null);
  assert.strictEqual(normalizeSide("なにか"), null, "分からない値を通している");
});

test("東西南北の角度が合っている", () => {
  // ⚠️ **東と西を取り違えると、押したのと反対側へ回り込む。**
  //    方角を測る関数（bearing）と同じ決まりであること
  const at = [139.0, 35.0];
  assert.ok(Math.abs(bearing(at, [139.1, 35.0]) - SIDES.east) < 1,
    `東が ${SIDES.east}度 になっていない`);
  assert.ok(Math.abs(bearing(at, [138.9, 35.0]) - SIDES.west) < 1,
    `西が ${SIDES.west}度 になっていない`);
  assert.ok(Math.abs(bearing(at, [139.0, 35.1]) - SIDES.north) < 1);
  assert.ok(Math.abs(bearing(at, [139.0, 34.9]) - SIDES.south) < 1);
  assert.deepStrictEqual(Object.keys(SIDE_LABELS).sort(), Object.keys(SIDES).sort(),
    "SIDES と SIDE_LABELS の顔ぶれが違う");
});

test("東に置いた道は、東まわりでだけ選ばれる", () => {
  // ⚠️ 実データだと候補が旅の向きに引きずられる。手で置いて確かめる
  const north = [KOFU[0] + 0.05, KOFU[1] + 0.20];    // 出発地の真北
  const east = seg({ name:"東の道", start:[35.60, 138.95], end:[35.61, 138.96] });
  const west = seg({ name:"西の道", start:[35.60, 138.20], end:[35.61, 138.19] });
  const dest = [KOFU[0] + 0.02, KOFU[1] - 0.30];      // ほぼ真南へ向かう旅

  const eb = sideBearing(east, KOFU, dest);
  const wb = sideBearing(west, KOFU, dest);
  assert.ok(matchesSide(SIDES.east, eb), `東の道の向きが ${Math.round(eb)}度`);
  assert.ok(!matchesSide(SIDES.west, eb), "東の道が西まわりに入っている");
  assert.ok(matchesSide(SIDES.west, wb), `西の道の向きが ${Math.round(wb)}度`);
  assert.ok(!matchesSide(SIDES.east, wb), "西の道が東まわりに入っている");
});

test("直線の上にある道は、どちら側でもない", () => {
  // ⚠️ **ほぼ直線上の点は向きが定まらない。** 無理に決めると、
  //    ほんの数mのぶれで北になったり南になったりして、
  //    「北まわり」を選ぶたびに違う道が入る
  const from = [139.0, 35.0], to = [139.0, 35.5];      // 真北へ向かう旅
  // 直線のちょうど上に置く（横ズレ 0m）
  const onLine = seg({ name:"直線上", start:[35.20, 139.0], end:[35.21, 139.0] });
  const lateral = project(midpoint(onLine), [from, to]).lateralDistance;
  assert.ok(lateral < 10, `材料が悪い（横ズレ ${Math.round(lateral)}m）`);
  assert.strictEqual(sideBearing(onLine, from, to), null,
    "直線上の道に向きを付けている");
  // どの方角にも入らないこと
  for (const d of Object.values(SIDES)) {
    assert.ok(!matchesSide(d, sideBearing(onLine, from, to)),
      `直線上の道が ${d}度 の側に入っている`);
  }
});

test("指定した側の道だけを選ぶ", () => {
  if (!yamanashi) return;
  // 甲府→富士吉田は南東へ向かう。候補は北東側と南西側に分かれる（実測）
  const north = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4, side: "north" });
  const south = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4, side: "south" });
  assert.ok(north.segments.length, "北まわりで1本も選ばれていない");
  assert.ok(south.segments.length, "南まわりで1本も選ばれていない");

  // ⚠️ **選ばれた道が、本当にその側にあること。** 指定を素通りしていないか
  for (const s of north.segments) {
    assert.ok(matchesSide(SIDES.north, sideBearing(s, KOFU, FUJI)),
      `北まわりに ${s.name} が入っている（北側にない）`);
  }
  for (const s of south.segments) {
    assert.ok(matchesSide(SIDES.south, sideBearing(s, KOFU, FUJI)),
      `南まわりに ${s.name} が入っている（南側にない）`);
  }
});

test("北と南で、違う道が選ばれる", () => {
  if (!yamanashi) return;
  const north = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4, side: "north" });
  const south = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4, side: "south" });
  const a = new Set(north.segments.map((s) => s.id));
  const both = south.segments.filter((s) => a.has(s.id));
  assert.strictEqual(both.length, 0,
    `両方に入っている道がある: ${both.map((s) => s.name).join("・")}`);
});

test("指定しなければ、どちら側も選べる", () => {
  if (!yamanashi) return;
  const free = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4 });
  const north = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4, side: "north" });
  assert.ok(free.considered > north.considered,
    `指定なし${free.considered}本 が 北まわり${north.considered}本 より多くない`);
  assert.strictEqual(free.sideDropped, 0, "指定していないのに落としている");
});

test("方角で何本落としたかを返す", () => {
  if (!yamanashi) return;
  // ⚠️ 0本になったとき「道が無い」のか「方角で外れた」のか分かるように
  const north = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4, side: "north" });
  const free = selectFunRoads(KOFU, FUJI, yamanashi, { count: 4 });
  assert.strictEqual(north.sideDropped, free.considered - north.considered,
    "落とした本数が合っていない");
});

test("案を作るときも、方角を全部の案に効かせる", () => {
  if (!yamanashi) return;
  // ⚠️ 案ごとに変えると「北まわりを選んだのに南の案が出る」
  const vs = buildFunVariants(KOFU, FUJI, yamanashi, { count: 4, side: "north" });
  assert.ok(vs.length, "案が出ていない");
  for (const v of vs) {
    for (const s of v.segments) {
      assert.ok(matchesSide(SIDES.north, sideBearing(s, KOFU, FUJI)),
        `「${v.label}」に南側の ${s.name} が入っている`);
    }
  }
});

// MARK: まわり方を全部並べる

test("まわり方を全部作る", () => {
  if (!yamanashi) return;
  const { variants, empties } = buildSideVariants(KOFU, FUJI, yamanashi, { count: 4 });
  assert.ok(variants.length >= 1, "1通りも出ていない");
  // ⚠️ 4方向すべてを試したこと（出た案 ＋ 候補なしの方角 で4つ揃う）
  const tried = variants.reduce((n, v) => n + v.sides.length, 0) + empties.length;
  assert.strictEqual(tried, 4, `試した方角が ${tried} 個（4つのはず）`);
});

test("同じ道になる方角はまとめる", () => {
  if (!yamanashi) return;
  // ⚠️ **候補は旅の向きと直角の2方向に集まる。** まとめないと、
  //    4通り並べたうち半分が同じ線の重複になる
  const { variants } = buildSideVariants(KOFU, FUJI, yamanashi, { count: 4 });
  const seen = new Set();
  for (const v of variants) {
    const sig = v.segments.map((s) => s.id).sort().join("|");
    assert.ok(!seen.has(sig),
      `同じ顔ぶれの案が2つ出ている（${v.label}: ${v.segments.map((s) => s.name).join("・")}）`);
    seen.add(sig);
  }
  // 甲府→富士吉田は南東へ向かうので、まとめが起きるはず
  assert.ok(variants.some((v) => v.sides.length > 1),
    `まとまっていない（${variants.map((v) => v.label).join(" / ")}）`);
});

test("方角ごとに別の道を選ぶ（全部が1つにまとまらない）", () => {
  if (!yamanashi) return;
  // ⚠️ **各方角に side を渡し忘れると、4方向とも同じ結果になって
  //    「1通り（4方角ぶん）」に潰れる。** そうなっていないこと。
  //    甲府→富士吉田は実測で 北・東まわり / 南・西まわり の2通りに分かれる
  const { variants } = buildSideVariants(KOFU, FUJI, yamanashi, { count: 4 });
  assert.ok(variants.length >= 2,
    `${variants.length}通りしか出ていない（方角を渡し忘れていないか）`);
  for (const v of variants) {
    assert.ok(v.sides.length < 4,
      `「${v.label}」に4方角すべてがまとまっている（方角が効いていない）`);
  }
});

/**
 * ⚠️ **表示名を返さないこと。** ここで「北・西まわり」を作って返すと、
 *    APIを外に出したときに応答へ日本語が混ざる。海外へ出す前提なので、
 *    返すのは鍵（north/east/south/west）だけにして、呼ぶ側が訳す。
 */
test("案は方角の鍵だけを返す（表示名は返さない）", () => {
  if (!yamanashi) return;
  const { variants, empties } = buildSideVariants(KOFU, FUJI, yamanashi, { count: 4 });
  const KEYS = Object.keys(SIDES);
  for (const v of variants) {
    assert.ok(Array.isArray(v.sides) && v.sides.length, "sides が無い");
    for (const key of v.sides) {
      assert.ok(KEYS.includes(key), `sides に鍵でないもの: ${key}`);
    }
    assert.strictEqual(v.label, undefined,
      `表示名を返している（${v.label}）。呼ぶ側で作ること`);
  }
  for (const e of empties) {
    assert.ok(KEYS.includes(e.side), `候補なしの側が鍵でない: ${e.side}`);
    assert.strictEqual(e.label, undefined, `候補なしの側に表示名が付いている（${e.label}）`);
  }
});

test("応答に日本語が混ざっていない", () => {
  if (!yamanashi) return;
  // ⚠️ 目視ではなく、返り値そのものを走査する。項目が増えたときに気付けるように
  const { variants, empties } = buildSideVariants(KOFU, FUJI, yamanashi, { count: 4 });
  const japanese = /[぀-ヿ一-鿿]/;
  const walk = (value, path) => {
    if (typeof value === "string") {
      // ⚠️ **固有名詞は日本語で当然。** それ以外の項目に日本語が出たら困る。
      //    name       道路名（甲府山梨線）
      //    title      名前の上書き（湯河原箱根線 → 椿ライン）
      //    note       ひとこと説明
      //    regionName 地域の表示名（山梨県）。鍵は別に `region` がある
      //    どれも人が読むための固有の文字列で、鍵にはできない
      if (/\.(name|id|title|note|regionName)$/.test(path)) return;
      assert.ok(!japanese.test(value), `${path} に日本語が入っている: ${value}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    }
  };
  walk(variants, "variants");
  walk(empties, "empties");
});

test("案の道が、その方角の側にある", () => {
  if (!yamanashi) return;
  // ⚠️ まとめる処理で方角の指定が抜けていないか
  const { variants } = buildSideVariants(KOFU, FUJI, yamanashi, { count: 4 });
  for (const v of variants) {
    for (const s of v.segments) {
      const ok = v.sides.some((key) => matchesSide(SIDES[key], sideBearing(s, KOFU, FUJI)));
      assert.ok(ok, `「${v.label}」に ${s.name} が入っているが、その側にない`);
    }
  }
});

test("候補が無かった方角も返す", () => {
  if (!yamanashi) return;
  // ⚠️ 黙って消すと「出ない」のか「試していない」のかが分からない
  const { variants, empties } = buildSideVariants(KOFU, FUJI, yamanashi, { count: 4 });
  const covered = new Set(variants.flatMap((v) => v.sides));
  for (const e of empties) {
    assert.ok(!covered.has(e.side), `${e.label} が案にも「候補なし」にも入っている`);
    assert.ok(e.label, "候補なしの方角に名前が付いていない");
  }
});

test("選び直しに使う設定を持たせる", () => {
  if (!yamanashi) return;
  // ⚠️ Uターンした道を外して選び直すとき、方角を守るために要る
  const { variants } = buildSideVariants(KOFU, FUJI, yamanashi, { count: 4 });
  for (const v of variants) {
    assert.ok(v.pickOptions, `「${v.label}」に pickOptions が無い`);
    assert.strictEqual(v.pickOptions.side, v.sides[0],
      `「${v.label}」の pickOptions.side が違う`);
  }
});

test("道が無ければ案も出ない（落ちない）", () => {
  const { variants, empties } = buildSideVariants(KOFU, FUJI, [], { count: 4 });
  assert.deepStrictEqual(variants, []);
  assert.strictEqual(empties.length, 4, "4方向とも「候補なし」になっていない");
});
