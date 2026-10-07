"use strict";
const test = require("node:test");
const assert = require("node:assert");
const R = require("../lib/riderInsights");

/**
 * 利用者の好みと行き先（開発者だけが見る画面 /riders・`lib/riderInsights.js`）。
 * ⚠️ 利用者の要望（2026-10-07）: 全員の確認は開発者だけの web の画面で、どんな場所によく行くかを地図で見たい
 * ⚠️ 好みの決め方はアプリ（RiderSignals.swift）と同じ。下の数字はアプリのテストと同じ例
 */

const post = (id, userID, extra = {}) => ({ id, userID, lat: "35.95", lng: "139.05", tag: [], points: [], ...extra });

test("特徴はアプリと同じ形（札は鍵に直し、曲がり具合は3段）", () => {
  assert.deepStrictEqual(R.roadFeatures(["絶景", "winding"], "secondary", 650),
    ["curvy:high", "hw:secondary", "tag:scenic", "tag:winding"]);
  assert.deepStrictEqual(R.roadFeatures([], "", 299), ["curvy:low"]);
  assert.deepStrictEqual(R.spotFeatures(["onsen"], ["温泉", ""]), ["genre:温泉", "pt:onsen"]);
});

test("好みは材料の重みつきの割合で、同じスポットは重みのいちばん大きい材料だけ数える", () => {
  const t = R.tasteFromEvidence([
    { kind: "spot", key: "a", features: ["pt:onsen"], weight: 1, source: "post" },
    { kind: "spot", key: "a", features: ["pt:onsen"], weight: 0.6, source: "like" },   // 同じスポット（後から来ても重い方だけ）
    { kind: "spot", key: "c", features: ["pt:onsen"], weight: 0.6, source: "like" },   // 別のいいね
    { kind: "spot", key: "b", features: ["pt:view"], weight: 0.6, source: "like" },
  ]);
  assert.strictEqual(t.spots["pt:onsen"], 1.6 / 2.2, "同じスポットを2回数えた、または重みを使っていない");
  assert.strictEqual(t.spots["pt:view"], 0.6 / 2.2);
  assert.strictEqual(t.spotSources["pt:onsen"], "post", "いちばん効いた材料（投稿1.0 > いいね0.6）を理由にしていない");
  assert.strictEqual(t.spotSources["pt:view"], "like");
  assert.deepStrictEqual(t.roads, {});
});

test("口コミは★4以上だけ好みに使い、いいねと投稿とプランと選んだ記録を数える", () => {
  const out = R.buildInsights({
    posts: [post("s1", "U", { points: ["onsen"] }), post("s2", "U", { points: ["view"] }), post("s3", "V", { points: ["cafe"] })],
    likes: [{ userID: "V", spotID: "s1" }, { userID: "V", spotID: "missing" }],
    reviews: [{ userID: "V", spotID: "s2", rating: 2 }, { userID: "W", spotID: "s2", rating: 5 }],
    plans: [{ userID: "W", spots: [{ spotId: "s3", lat: 36, lng: 139 }, { isRoad: true, roadID: "r:x", lat: 36.1, lng: 139.1 }] }],
    tastes: [{ userID: "W", spots: { k: { key: "s1", count: 3, features: ["pt:onsen"] } } }],
  });
  const byCounts = out.users.map((u) => u.counts);
  assert.deepStrictEqual(out.users.map((u) => u.no), [1, 2, 3]);
  // W: 口コミ1・プラン1・選んだ1 = 3、U: 投稿2 = 2、V: 投稿1・いいね1・口コミ1 = 3 → W と V が同じ（uid 順で V が先）
  assert.deepStrictEqual(byCounts[0], { post: 1, like: 1, review: 1, plan: 0, choice: 0 }, "活動の多い順になっていない");
  const v = out.users[0], w = out.users[1];
  assert.deepStrictEqual(v.spotTaste.map((x) => x[0]).sort(), ["pt:cafe", "pt:onsen"],
    "★2の口コミを好みに使った、または無いスポットのいいねを数えた");
  // W の材料: 選んだ s1（回数3→重み3）・★5の口コミ s2（0.8）・プラン s3（1.0）→ 温泉は 3 / 4.8 = 0.625
  assert.deepStrictEqual(w.spotTaste[0], ["pt:onsen", 0.63, "choice"], "選んだ記録の回数を重みにしていない");
  assert.strictEqual(out.totals.likes, 1, "無いスポットのいいねを数えた");
});

test("誰かは返さず、県と地図の升目と札の合計を出す", () => {
  const out = R.buildInsights({
    posts: [post("s1", "secret-uid", { tag: ["温泉"], points: ["onsen"], road: { name: "国道299号", highway: "primary" } }),
            post("s2", "secret-uid", { lat: "35.96", lng: "139.06" }), post("s3", "other", { lat: "43.0", lng: "141.3" })],
  }, (lng) => (lng < 140 ? "埼玉県" : "北海道"));
  assert.ok(!JSON.stringify(out).includes("secret-uid"), "uid を返している");
  assert.deepStrictEqual(out.users[0].areas, [["埼玉県", 2]]);
  assert.deepStrictEqual(out.users[0].roadTaste.map((x) => x[0]), ["hw:primary"], "近くの道を道の好みに使っていない");
  assert.deepStrictEqual(out.tags, [["温泉", 1]]);
  assert.deepStrictEqual([out.totals.withTag, out.totals.withPoints, out.totals.withRoad], [1, 1, 1]);
  assert.deepStrictEqual(out.grid.map((c) => [c.total, c.people]), [[2, 1], [1, 1]], "升目にまとめていない");
  assert.deepStrictEqual(out.prefectures, [["埼玉県", 2], ["北海道", 1]]);
});

test("本番から読むのは必要な項目だけで、いいねはスポット配下だけ・プランは持ち主を親から取る", async () => {
  const selected = {};
  const ref = (path) => {
    const parts = path.split("/");
    const make = (i) => (i < 0 ? null : { id: parts[i], parent: i > 0 ? { id: parts[i - 1], parent: make(i - 2) } : null });
    const doc = make(parts.length - 1);
    return { id: doc.id, parent: { id: parts[parts.length - 2], parent: make(parts.length - 3) } };
  };
  const snap = (rows) => ({ docs: rows.map(([path, data]) => ({ id: path.split("/").pop(), ref: ref(path), data: () => data })) });
  const tables = {
    imagedownload: snap([["imagedownload/s1", { userID: "U", lat: "35", lng: "139", tag: ["温泉"], email: "x@example.com" }]]),
    yaehCount: snap([["imagedownload/s1/yaehCount/l1", { userID: "V" }], ["yaehCount/l2", { userID: "V" }],
                     ["userInfo/V/yaehCount/l3", { userID: "V" }]]),
    wordOfMouth: snap([["wordOfMouth/w1", { postUserID: "V", locationDocID: "s1", womAssessment: 5 }]]),
    touringPlans: snap([["users/W/touringPlans/p1", { spots: [{ spotId: "s1", lat: 35, lng: 139, roadId: "r:x" }] }]]),
    user_taste: snap([["user_taste/W", { spots: {} }]]),
  };
  const query = (name) => ({ select: (...f) => { selected[name] = f; return { get: async () => tables[name] }; } });
  const db = { collection: query, collectionGroup: query };
  const data = await R.loadRiderData(db);
  assert.deepStrictEqual(selected.imagedownload, ["userID", "lat", "lng", "tag", "points", "road"], "要らない項目まで読んでいる");
  assert.ok(!JSON.stringify(data).includes("example.com"), "メールを持ち出している");
  assert.deepStrictEqual(data.likes, [{ userID: "V", spotID: "s1" }], "スポット配下でないいいねを数えた");
  assert.deepStrictEqual(data.reviews, [{ userID: "V", spotID: "s1", rating: 5 }]);
  assert.deepStrictEqual(data.plans, [{ userID: "W", spots: [{ spotId: "s1", lat: 35, lng: 139, isRoad: false, roadID: "r:x" }] }],
    "プランの持ち主を親から取っていない");
  assert.deepStrictEqual(data.tastes.map((t) => t.userID), ["W"]);
});
