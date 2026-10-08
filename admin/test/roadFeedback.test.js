"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const F = require("../lib/roadFeedback");

/**
 * 走った道の感想を道ごとにまとめる（lib/roadFeedback.js）。
 * ⚠️ 利用者の判断（2026-10-08）: まず調整ツールだけに出す・札は人が採用する・誰が書いたかは出さない
 */

const at = (iso) => ({ toDate: () => new Date(iso) });

test("道ごとに判定・札・注意の人数とひとことをまとめ、誰が書いたかは出さない", () => {
  const docs = [
    { uid: "a", roadID: "n:長野県|ビーナス/ライン|primary", roadName: "ビーナスライン", verdict: "good",
      tags: ["scenic", "winding"], cautions: [], note: "  景色が最高  ", updatedAt: at("2026-10-08T11:00:00Z") },
    { uid: "b", roadID: "n:長野県|ビーナス/ライン|primary", verdict: "good", tags: ["scenic", "bogus"],
      cautions: ["traffic"], note: "", updatedAt: at("2026-10-09T11:00:00Z") },
    { uid: "c", roadID: "n:長野県|ビーナス/ライン|primary", verdict: "bad", tags: [], cautions: ["traffic", "rough"],
      note: "週末は渋滞", updatedAt: at("2026-10-07T11:00:00Z") },
    { uid: "d", roadID: "r:埼玉県|299|primary", verdict: "ok" },
    { uid: "e", roadID: "r:埼玉県|299|primary", verdict: "maybe" },       // 形が崩れている
    { uid: "f", verdict: "good" },                                       // 道が無い
  ];
  const out = F.summarizeFeedback(docs);
  const venus = out["n:長野県|ビーナス_ライン|primary"];
  assert.ok(venus, "道の鍵を調整ツールの形（/ → _）にしていない");
  assert.deepStrictEqual([venus.good, venus.ok, venus.bad, venus.total], [2, 0, 1, 3]);
  assert.deepStrictEqual(venus.tags, { scenic: 2, winding: 1 }, "知らない札を数えた／数え違い");
  assert.deepStrictEqual(venus.cautions, { traffic: 2, rough: 1 });
  assert.deepStrictEqual(venus.notes.map((n) => n.text), ["景色が最高", "週末は渋滞"], "新しい順・空を除く・前後の空白を除く");
  assert.strictEqual(venus.lastAt, "2026-10-09T11:00:00.000Z");
  assert.strictEqual(out["r:埼玉県|299|primary"].total, 1, "形の崩れた判定まで数えた");
  assert.ok(!JSON.stringify(out).includes("\"a\""), "書いた人（uid）を出している");
  assert.strictEqual(F.summarizeFeedback(docs, { maxNotes: 1 })["n:長野県|ビーナス_ライン|primary"].notes.length, 1);
});

test("答えてもらえた数（回答・人・道）", () => {
  const docs = [
    { uid: "a", roadID: "r:x", verdict: "good" }, { uid: "a", roadID: "r:y", verdict: "ok" },
    { uid: "b", roadID: "r:x", verdict: "bad" }, { uid: "c", roadID: "r:z", verdict: "?" },
  ];
  assert.deepStrictEqual(F.countFeedback(docs), { answers: 3, riders: 2, roads: 2 });
  assert.deepStrictEqual(F.countFeedback(undefined), { answers: 0, riders: 0, roads: 0 });
});

test("調整ツールは声を読んで見せるだけで、札は人が付ける", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = server.indexOf('app.get("/api/roads/feedback"');
  assert.ok(start > 0, "声を返す窓口が無い");
  const body = server.slice(start, server.indexOf("\n});\n", start));
  assert.ok(body.includes('db.collection("road_feedback").get()'), "感想を読んでいない");
  assert.ok(!/\.set\(|\.update\(|\.add\(/.test(body), "窓口が本番に書いている");
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
  assert.ok(page.includes("const feedbackOf = (seg) => state.feedback[reviewKey(seg)] || null;"),
    "開発者の評価と同じ鍵で突き合わせていない");
  assert.ok(page.includes("${feedbackBlock(seg)}"), "編集パネルに声を出していない");
  assert.ok(page.includes('else if (state.filter === "voiced") list = list.filter((r) => feedbackOf(r.seg));'),
    "声のある道で絞れない");
  const block = page.slice(page.indexOf("function feedbackBlock(seg)"), page.indexOf("function adoptReview"));
  assert.ok(!block.includes("state.overrides"), "声から札を自動で付けている（人が採用する）");
});
