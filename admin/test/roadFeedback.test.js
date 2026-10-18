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
  assert.ok(page.includes("const feedbackOf = (seg) => state.feedback[feedbackKeyOf(seg)] || null;"),
    "開発者の評価と同じ鍵で突き合わせていない");
  // ⚠️ 手直しした区間はアプリが `s:<区間ID>` で送る（2026-10-18 に気づいた。以前は1件も当たらなかった）
  assert.ok(page.includes('const feedbackKeyOf = (seg) => (state.feedback["s:" + seg.id] ? "s:" + seg.id : reviewKey(seg));'),
    "手直しした区間の声を探していない");
  assert.ok(page.includes("${feedbackBlock(seg)}"), "編集パネルに声を出していない");
  assert.ok(page.includes('else if (state.filter === "voiced") list = list.filter((r) => feedbackOf(r.seg));'),
    "声のある道で絞れない");
  const block = page.slice(page.indexOf("function feedbackBlock(seg)"), page.indexOf("function adoptReview"));
  assert.ok(!block.includes("state.overrides"), "声から札を自動で付けている（人が採用する）");
});

test("感想を1件ずつ新しい順に・県と調整画面の鍵を付け・uid は短い指紋だけ", () => {
  const docs = [
    { uid: "user-a", roadID: "r:埼玉県|299|trunk", roadName: "国道299号", verdict: "good", tags: ["scenic", "bogus"],
      cautions: ["narrow", "x"], note: "  峠が楽しい  ", rideKm: 12.3, rodeAt: at("2026-10-15T03:00:00Z"), updatedAt: at("2026-10-15T11:00:00Z") },
    { uid: "user-b", roadID: "s:長野県:12", roadName: "ビーナスライン", verdict: "bad", tags: [], cautions: [],
      note: "", rideKm: "x", rodeAt: at("2026-10-17T03:00:00Z"), updatedAt: at("2026-10-17T11:00:00Z") },
    { uid: "user-a", roadID: "n:群馬県|名前/あり|secondary", verdict: "ok", updatedAt: at("2026-10-16T11:00:00Z") },
    { uid: "user-c", roadID: "r:埼玉県|1|trunk", verdict: "great" },   // 形の崩れた答え
    { uid: "user-c", verdict: "good" },                                  // 道の鍵が無い
  ];
  const list = F.listFeedback(docs, { romajiOf: { 埼玉県: "saitama", 長野県: "nagano" } });
  assert.deepStrictEqual(list.map((i) => i.key), ["s:長野県:12", "n:群馬県|名前_あり|secondary", "r:埼玉県|299|trunk"],
    "新しい順でない／崩れた答えを入れた／鍵の / を直していない");
  const first = list[2];
  assert.strictEqual(first.prefecture, "埼玉県");
  assert.strictEqual(first.romaji, "saitama", "調整画面の県の鍵が無い");
  assert.deepStrictEqual(first.tags, ["scenic"], "知らない札を出している");
  assert.deepStrictEqual(first.cautions, ["narrow"]);
  assert.strictEqual(first.note, "峠が楽しい");
  assert.strictEqual(first.rideKm, 12.3);
  assert.strictEqual(first.rodeAt, "2026-10-15T03:00:00.000Z");
  assert.strictEqual(list[0].prefecture, "長野県", "手直しした区間（s:県:番号）の県が取れない");
  assert.strictEqual(list[0].rideKm, null);
  assert.strictEqual(list[1].romaji, "", "知らない県に鍵を付けた");
  // 答えた人は短い指紋だけ・同じ人は同じ記号
  assert.strictEqual(first.rider.length, 6);
  assert.strictEqual(first.rider, list[1].rider, "同じ人の答えが見分けられない");
  assert.notStrictEqual(first.rider, list[0].rider);
  assert.ok(!JSON.stringify(list).includes("user-a"), "uid をそのまま出している");
  assert.strictEqual(F.riderTag(""), "");
  assert.strictEqual(F.prefectureOf("r:東京都|20|primary"), "東京都");
  assert.deepStrictEqual(F.listFeedback(undefined), []);
});

test("感想の一覧の窓口は読むだけで、画面は uid を使わず調整画面へ飛べる", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(server.includes('app.get("/feedback", (_req, res) => sendHtml(res, "feedback.html"));'), "一覧の画面が無い");
  const start = server.indexOf('app.get("/api/feedback/list"');
  assert.ok(start > 0, "一覧の窓口が無い");
  const body = server.slice(start, server.indexOf("\n});\n", start));
  assert.ok(body.includes('db.collection("road_feedback").get()'));
  assert.ok(body.includes("listFeedback(docs, { romajiOf: ROMAJI })"));
  assert.ok(!/\.set\(|\.update\(|\.add\(|\.delete\(/.test(body), "窓口が本番に書いている");
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "feedback.html"), "utf8");
  assert.ok(page.includes('fetch("/api/feedback/list"'), "画面が窓口を読んでいない");
  assert.ok(page.includes("/roads?pref=${encodeURIComponent(i.romaji)}&road=${encodeURIComponent(i.key)}"), "調整画面へ飛べない");
  assert.ok(!page.includes(".uid"), "画面で uid を使っている");
  const builder = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
  assert.ok(builder.includes('const wanted = r.prefectures.find((p) => p.romaji === params.get("pref") && p.built);'),
    "調整画面が ?pref= で県を開かない");
  assert.ok(builder.includes('if (wanted && params.get("road")) openRoadFromLink(params.get("road"));'), "調整画面がその道を選ばない");
});
