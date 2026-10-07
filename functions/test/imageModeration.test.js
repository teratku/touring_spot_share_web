"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { judgeSafeSearch, targetKind, moderateImage } = require("../imageModeration");

/**
 * 投稿画像のセーフサーチ（imageModeration.js）。
 * ⚠️ 利用者の判断（2026-10-07）: 引っかかった画像は開発者が判断する（画像は消さない）
 */

test("成人向け・暴力は LIKELY から、きわどい・医療は VERY_LIKELY だけ印を付ける", () => {
  assert.deepStrictEqual(judgeSafeSearch({ adult: "LIKELY", violence: "POSSIBLE", racy: "LIKELY", medical: "UNLIKELY" }).reasons,
    ["adult:LIKELY"], "きわどい LIKELY（海辺の写真など）まで印を付けた、または成人向け LIKELY を見逃した");
  assert.deepStrictEqual(judgeSafeSearch({ adult: "POSSIBLE", violence: "VERY_LIKELY", racy: "VERY_LIKELY", medical: "VERY_LIKELY" }).reasons,
    ["violence:VERY_LIKELY", "racy:VERY_LIKELY", "medical:VERY_LIKELY"]);
  assert.strictEqual(judgeSafeSearch({ adult: "POSSIBLE", violence: "POSSIBLE", racy: "LIKELY" }).flagged, false);
  assert.strictEqual(judgeSafeSearch({ adult: 4 }).flagged, true, "数で来た結果（4 = LIKELY）を読めない");
  assert.strictEqual(judgeSafeSearch(undefined).flagged, false);
});

test("見るのは投稿の写真とプロフィール画像だけ（一覧用の小さい写真・ルート・画像でないものは見ない）", () => {
  assert.strictEqual(targetKind("images/abc.jpg", "image/jpeg"), "post");
  assert.strictEqual(targetKind("userIcon/u1.png", "image/png"), "userIcon");
  assert.strictEqual(targetKind("iconImage/abc.jpg", "image/jpeg"), null, "同じ写真の小さい版まで調べた（二重に費用）");
  assert.strictEqual(targetKind("routes/r1.json", "application/json"), null);
  assert.strictEqual(targetKind("images/abc.json", "application/json"), null, "画像でないものを調べた");
});

test("引っかかった画像だけを開発者の控えに書き、画像は消さない", async () => {
  const written = {};
  const asked = [];
  const db = { collection: (c) => ({ doc: (id) => ({ set: async (data) => { written[`${c}/${id}`] = data; } }) }) };
  const deps = (annotation) => ({ annotate: async (uri) => { asked.push(uri); return annotation; }, db,
                                  FieldValue: { serverTimestamp: () => "TS" } });
  const bad = await moderateImage({ bucket: "b", name: "images/x 1.jpg", contentType: "image/jpeg" }, deps({ adult: "VERY_LIKELY" }));
  const ok = await moderateImage({ bucket: "b", name: "images/y.jpg", contentType: "image/jpeg" }, deps({ adult: "UNLIKELY" }));
  const skipped = await moderateImage({ bucket: "b", name: "iconImage/x.jpg", contentType: "image/jpeg" }, deps({ adult: "VERY_LIKELY" }));
  assert.deepStrictEqual([bad.flagged, ok.flagged, skipped.skipped], [true, false, true]);
  assert.deepStrictEqual(asked, ["gs://b/images/x 1.jpg", "gs://b/images/y.jpg"], "見ない画像まで Vision に送った");
  assert.deepStrictEqual(Object.keys(written), ["image_moderation/images%2Fx%201.jpg"], "印の無い画像まで書いた、または ID に / を使った");
  const doc = written["image_moderation/images%2Fx%201.jpg"];
  assert.deepStrictEqual([doc.path, doc.kind, doc.status, doc.reasons], ["images/x 1.jpg", "post", "pending", ["adult:VERY_LIKELY"]]);
});
