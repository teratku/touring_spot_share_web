"use strict";
const test = require("node:test");
const assert = require("node:assert");
const M = require("../lib/moderationReview");

/**
 * セーフサーチで印が付いた画像を開発者が見る（lib/moderationReview.js・管理ツール /moderation）。
 * ⚠️ 利用者の判断（2026-10-07）: 引っかかった画像は開発者が判断する
 */

test("まだ判断していない印だけを新しい順に出し、写真を使っている投稿を探す", async () => {
  const queries = [];
  const rows = {
    image_moderation: [
      { id: "images%2Fa.jpg", data: { path: "images/a.jpg", bucket: "b", kind: "post", reasons: ["adult:LIKELY"], status: "pending",
                                      flaggedAt: { toDate: () => new Date("2026-10-07T01:00:00Z") } } },
      { id: "userIcon%2Fu.png", data: { path: "userIcon/u.png", bucket: "b", kind: "userIcon", reasons: ["racy:VERY_LIKELY"], status: "pending",
                                        flaggedAt: { toDate: () => new Date("2026-10-07T02:00:00Z") } } },
    ],
  };
  const spot = { id: "s1", data: () => ({ location_name: "霧ヶ峰", administrative: "長野県", locality: "諏訪市" }) };
  const db = {
    collection: (name) => ({
      where: (field, op, value) => {
        queries.push([name, field, op, value]);
        const out = { limit: () => out, get: async () => {
          if (name === "image_moderation") return { docs: rows.image_moderation.map((r) => ({ id: r.id, data: () => r.data })) };
          return { docs: field === "locationImageNames" && value === "a.jpg" ? [spot] : [] };
        } };
        return out;
      },
    }),
  };
  const items = await M.loadPendingFlags(db);
  assert.deepStrictEqual(queries[0], ["image_moderation", "status", "==", "pending"], "判断済みまで出している");
  assert.deepStrictEqual(items.map((i) => i.id), ["userIcon%2Fu.png", "images%2Fa.jpg"], "新しい順でない");
  assert.deepStrictEqual(items[1].spot, { id: "s1", name: "霧ヶ峰", place: "長野県諏訪市" }, "写真を使っている投稿を探していない");
  assert.strictEqual(items[0].spot, null, "プロフィール画像で投稿を探した");
  assert.ok(queries.some((q) => q[1] === "imageName" && q[3] === "a.jpg"), "代表の写真（imageName）で探していない");
  assert.strictEqual(items[1].url, "https://firebasestorage.googleapis.com/v0/b/b/o/images%2Fa.jpg?alt=media");
});

test("置き場のパスからファイル名を取り出す", () => {
  assert.strictEqual(M.fileNameOf("images/abc.jpg"), "abc.jpg");
  assert.strictEqual(M.fileNameOf(undefined), "");
});
