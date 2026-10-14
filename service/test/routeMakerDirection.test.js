"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const RM = require("../../public/route-maker-lib.js");

/**
 * Web のルート作成で、おすすめ道路の入口と出口を入れ替える（利用者の要望 2026-10-14）。
 * 4つの候補がどれも輪になっていた: ぶどうまつたけラインを「北の入口→南の出口」で入れていて、次の行き先（北東の蔵王町）へ
 * 戻る往復になっていた。アプリの NavRoadDirection と同じ決め方で知らせ、押すと入れ替えて作り直す
 */
const p = (lat, lng) => ({ lat, lng });
const road = (name, entry, goal, extra = {}) =>
  Object.assign({ name, kind: "road", lat: goal.lat, lng: goal.lng, approach: [entry, p((entry.lat + goal.lat) / 2, (entry.lng + goal.lng) / 2)] }, extra);
const place = (name, at) => ({ name, kind: "place", lat: at.lat, lng: at.lng, approach: [] });

// 報告のプラン（おおよその位置）: 出発 福島市 → 猪苗代町 → ぶどうまつたけライン（北の南陽→南の米沢） → 蔵王町
const origin = p(37.76, 140.47);
const inawashiro = place("耶麻郡猪苗代町", p(37.56, 140.10));
const budou = road("ぶどうまつたけライン", p(38.07, 140.18), p(37.92, 140.13));
const zao = place("刈田郡蔵王町", p(38.10, 140.66));

test("報告のプランでは、ぶどうまつたけラインを逆向きのほうがよいと出す", () => {
  const hints = RM.reversedRoadIndices([inawashiro, budou, zao], origin);
  assert.deepStrictEqual(hints.map((h) => h.index), [1], "往復になる道を知らせていない");
  assert.ok(hints[0].savedMeters >= RM.MIN_BACKTRACK_METERS);
});

test("入れ替えた道（利用者の意思）・わずかな差・道でないものは知らせない", () => {
  assert.deepStrictEqual(RM.reversedRoadIndices([inawashiro, Object.assign({}, budou, { keepsDirection: true }), zao], origin), [],
    "利用者が決めた向きを逆と言った（入れ替えた意思を覆す）");
  const flippedAlready = road("ぶどうまつたけライン", p(37.92, 140.13), p(38.07, 140.18));
  assert.deepStrictEqual(RM.reversedRoadIndices([inawashiro, flippedAlready, zao], origin), [], "向きが合っている道を知らせた");
  const tiny = road("短い道", p(37.9000, 140.1300), p(37.9001, 140.1301));
  assert.deepStrictEqual(RM.reversedRoadIndices([inawashiro, tiny, zao], origin), [], "わずかな差で知らせた");
});

test("次が道なら、その入口を見て決める", () => {
  // 次の道の入口が北にあるので、北で終わる今の向きのままがよい。次の道のゴール（南西・猪苗代の近く）を見ると逆に判断する
  // （前の行き先は東。次の道の入口は北＝この道の出口のすぐ先、ゴールはずっと南）
  const east = place("東の行き先", p(38.05, 140.40));
  const nextRoad = road("次の道", p(38.20, 140.20), p(37.40, 140.05));
  const asIs = road("この道", p(37.95, 140.15), p(38.15, 140.18));
  assert.deepStrictEqual(RM.reversedRoadIndices([east, asIs, nextRoad], origin).map((h) => h.index), [],
    "次の道のゴールを見て、向きが合っている道を逆と言った（走った道を引き返す経路になる）");
});

test("入れ替えは通り道ごと裏返し、区間の呼び名も入れ替え、入れ替えた印を付ける", () => {
  // ⚠️ 途中の点を3つ以上にする（2つだと、途中を裏返し忘れても結果が同じになる）
  const withSection = Object.assign({}, budou, {
    approach: [p(38.07, 140.18), p(38.03, 140.17), p(37.99, 140.16), p(37.95, 140.14)],
    section: { entry: "北の端", goal: "南の端", meters: 27900 } });
  const f = RM.reversedRoad(withSection);
  assert.deepStrictEqual({ lat: f.lat, lng: f.lng }, withSection.approach[0], "出口が元の入口になっていない");
  assert.deepStrictEqual(f.approach[0], { lat: withSection.lat, lng: withSection.lng }, "入口が元の出口になっていない");
  assert.deepStrictEqual(f.approach.slice(1), withSection.approach.slice(1).reverse(), "途中の点を裏返していない（行ったり来たりする）");
  assert.strictEqual(f.section.entry, "南の端");
  assert.strictEqual(f.section.goal, "北の端");
  assert.strictEqual(f.keepsDirection, true);
  assert.strictEqual(RM.reversedRoad(zao), zao, "スポットを変えた");
  const back = RM.reversedRoad(f);
  assert.deepStrictEqual({ lat: back.lat, lng: back.lng, approach: back.approach },
                         { lat: withSection.lat, lng: withSection.lng, approach: withSection.approach }, "2回入れ替えても元に戻らない");
});

test("プランの「入れ替えた」印を読み、逆向きの知らせで戻さない", () => {
  const spot = { name: "ぶどうまつたけライン", isRoad: true, order: 1, directionByUser: true,
                 path: [{ lat: 37.92, lng: 140.13 }, { lat: 38.0, lng: 140.15 }, { lat: 38.07, lng: 140.18 }] };
  const [d] = RM.toDestinations([spot]);
  assert.strictEqual(d.keepsDirection, true, "プランで入れ替えた印を読んでいない（知らせが元の向きへ戻そうとする）");
  assert.strictEqual(d.spot, spot, "元のスポットを持っていない（プランに保存できない）");
});

test("画面: 一覧に入れ替えのボタン・作ったあとに知らせ・押すとプランに保存して作り直す", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "route-maker.html"), "utf8");
  assert.ok(/class="rm-flip" data-i="/.test(html), "一覧に入れ替えのボタンが無い");
  assert.ok(/try \{ await flipPlanRoads\(\[Number\(b\.dataset\.i\)\]\); showStops\(\); \}/.test(html), "一覧のボタンがプランに保存しない");
  assert.ok(/return targets\.indexOf\(s\) >= 0 \? window\.TSSPlanRoads\.reversedPlanSpot\(s\) : s;/.test(html),
    "アプリ・プラン画面と同じ形で裏返していない");
  assert.ok(/\.collection\("touringPlans"\)\.doc\(plan\.id\)\.update\(\{\n\s+spots: spots,/.test(html), "プランに保存していない");
  assert.ok(/updateDirectionHints\(\);\n\s+renderCandidates\(\);/.test(html), "作ったあとに逆向きを調べていない");
  assert.ok(/await flipPlanRoads\(directionHints\.map\(function \(h\) \{ return h\.index; \}\)\);\n\s+renderStops\(\);\n\s+makeRoute\(\);/.test(html),
    "知らせを押してもプランに保存して作り直さない");
  assert.ok(/\.map\(function \(h\) \{ return \{ index: h\.index \+ offset,/.test(html), "出発地を分けたときに番号がずれる");
  assert.ok(/<script src="\/plan-road-lib\.js\?v=2"><\/script>\n<script src="\/route-maker-lib\.js\?v=7"><\/script>/.test(html),
    "裏返しの部品を読んでいない／古い版が残る");
});
