"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { tallyPopularity, tallyRiders, refreshPopularity } = require("../popularity");

/**
 * みんなの人気（popularity.js）。
 * ⚠️ 利用者の判断（2026-10-07）: 選んだ記録だけを数える・全期間と直近90日・3人以上から出す
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7);
/** 1人ぶんの記録。picks = [[key, name, 何日前]] */
const person = (picks, group = "roads") => ({
  [group]: Object.fromEntries(picks.map(([key, name, daysAgo], i) =>
    [`f${i}`, { key, name, count: 5, lastAt: { toMillis: () => NOW - daysAgo * DAY } }])),
});

test("同じ人が何回選んでも1人と数え、3人未満は出さない", () => {
  const docs = [
    person([["A", "三沢坂本線", 1], ["B", "正丸峠", 1]]),
    person([["A", "三沢坂本線", 2], ["B", "正丸峠", 2]]),
    person([["A", "三沢坂本線", 3]]),
  ];
  const { roads, spots } = tallyPopularity(docs, NOW);
  assert.deepStrictEqual(roads.map((r) => [r.key, r.users]), [["A", 3]],
    "回数（count:5）で数えた、または2人の道を出した");
  assert.deepStrictEqual(spots, []);
});

test("直近90日の人数を別に数え、3人未満なら0にする（少人数を推測させない）", () => {
  const docs = [
    person([["A", "a", 10], ["B", "b", 10]]),
    person([["A", "a", 20], ["B", "b", 100]]),
    person([["A", "a", 89], ["B", "b", 200]]),
    person([["A", "a", 91], ["B", "b", 5]]),
  ];
  const { roads } = tallyPopularity(docs, NOW);
  assert.deepStrictEqual(roads.map((r) => [r.key, r.users, r.recentUsers]), [["A", 4, 3], ["B", 4, 0]],
    "直近90日の境目、または3人未満を0にしていない");
});

test("人数の多い順に並べ、名前はいちばん最近選ばれたときのもの。誰が選んだかは出さない", () => {
  const docs = [
    person([["A", "古い名前", 30], ["B", "b", 1]]),
    person([["A", "新しい名前", 2], ["B", "b", 1]]),
    person([["A", "古い名前", 9], ["B", "b", 1]]),
    person([["B", "b", 1]]),
  ];
  const { roads } = tallyPopularity(docs, NOW);
  assert.deepStrictEqual(roads.map((r) => r.key), ["B", "A"], "人数の多い順になっていない");
  assert.strictEqual(roads[1].name, "新しい名前", "最近の名前を使っていない");
  assert.deepStrictEqual(Object.keys(roads[0]).sort(), ["key", "name", "recentUsers", "users"],
    "公開する項目に余計なもの（誰が選んだか・時刻）が入っている");
});

test("スポットも同じ規則で数え、上限で切る", () => {
  const docs = [1, 2, 3].map(() => person([["s1", "道の駅", 1], ["s2", "温泉", 1]], "spots"));
  const { spots } = tallyPopularity(docs, NOW, { maxItems: 1 });
  assert.deepStrictEqual(spots.map((s) => [s.key, s.users]), [["s1", 3]], "スポットを数えていない／上限で切っていない");
});

test("走った人は道の名前ごとに1人1回で数え、3人未満は出さない", () => {
  const docs = [
    { riddenRoadNames: ["ビーナスライン", "ビーナスライン", "国道299号", ""] },   // 同じ人の同じ名前は1人
    { riddenRoadNames: ["ビーナスライン", "国道299号", ""] },
    { riddenRoadNames: ["ビーナスライン", "", "国道299号"] },                     // 空の名前は3人でも出さない
    { riddenRoadNames: ["ビーナスライン"] },
    {},
  ];
  assert.deepStrictEqual(tallyRiders(docs), [{ name: "ビーナスライン", users: 4 }, { name: "国道299号", users: 3 }],
    "同じ人の同じ名前を2回数えた、または人数の多い順になっていない");
  assert.deepStrictEqual(tallyRiders(docs.slice(1)), [{ name: "ビーナスライン", users: 3 }], "2人の道を出した");
});

test("数えた結果を公開の文書3つに書き、読むのは選んだ記録と走った道の名前だけ", async () => {
  const written = {};
  const selected = {};
  const tables = {
    user_taste: [1, 2, 3].map(() => person([["A", "a", 1]])),
    road_completion: [1, 2, 3].map(() => ({ riddenRoadNames: ["ビーナスライン"], email: "x@example.com" })),
  };
  const db = {
    collection: (name) => ({
      select: (...fields) => {
        selected[name] = fields;
        return { get: async () => ({ size: tables[name].length, docs: tables[name].map((d) => ({ data: () => d })) }) };
      },
    }),
    doc: (path) => ({ set: async (data) => { written[path] = data; } }),
  };
  const result = await refreshPopularity(db, { serverTimestamp: () => "TS" }, NOW);
  assert.deepStrictEqual(selected, { user_taste: ["roads", "spots"], road_completion: ["riddenRoadNames"] });
  assert.deepStrictEqual(Object.keys(written).sort(), ["popularity/ridden", "popularity/roads", "popularity/spots"]);
  assert.deepStrictEqual(written["popularity/roads"].items.map((r) => r.users), [3]);
  assert.strictEqual(written["popularity/roads"].minUsers, 3);
  assert.deepStrictEqual(written["popularity/ridden"].items, [{ name: "ビーナスライン", users: 3 }]);
  assert.ok(!JSON.stringify(written).includes("example.com"), "走行記録のほかの項目を書いた");
  assert.deepStrictEqual(result, { people: 3, roads: 1, spots: 0, riders: 3, ridden: 1 });
});
