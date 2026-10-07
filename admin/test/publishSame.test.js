"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../lib/publishSame");

/**
 * 配信のとき本番と同じ中身かを確かめる（lib/publishSame.js）。
 * ⚠️ 利用者の要望（2026-10-07）: 現在アップしている内容と同じ場合は配信するか聞く
 */

test("中身の指紋が同じなら同じ、違えば違う、どちらかに無ければ分からない", () => {
  assert.strictEqual(P.sameAsDeployed({ contentHash: "abc" }, { contentHash: "abc" }), true);
  assert.strictEqual(P.sameAsDeployed({ contentHash: "abc" }, { contentHash: "xyz" }), false);
  assert.strictEqual(P.sameAsDeployed({ contentHash: "abc" }, { generation: 3 }), null, "指紋の無い古い配信を「違う」とした");
  assert.strictEqual(P.sameAsDeployed({}, { contentHash: "abc" }), null);
  assert.strictEqual(P.sameAsDeployed(null, null), null);
});

test("同じ中身を配信するときだけ止め、「それでも配信する」なら通す。下見は止めない", () => {
  assert.strictEqual(P.needsConfirm({ commit: true, same: true }), true);
  assert.strictEqual(P.needsConfirm({ commit: true, same: true, confirmSame: true }), false, "確かめたあとも止めた");
  assert.strictEqual(P.needsConfirm({ commit: false, same: true }), false, "下見を止めた");
  assert.strictEqual(P.needsConfirm({ commit: true, same: false }), false, "中身が違うのに止めた");
  assert.strictEqual(P.needsConfirm({ commit: true, same: null }), false, "分からないのに止めた（古い配信で配れなくなる）");
});

test("手元の作り直したデータと本番の記録を読んで比べる（本番は読むだけ）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publishSame-"));
  fs.writeFileSync(path.join(dir, "saitama.json"), JSON.stringify({ romaji: "saitama", contentHash: "h1" }));
  const asked = [];
  const db = {
    collection: (c) => ({ doc: (id) => ({
      get: async () => { asked.push(`${c}/${id}`); return { exists: true, data: () => ({ contentHash: "h1", generation: 9 }) }; },
      set: async () => { throw new Error("本番に書いた"); },
    }) }),
  };
  const r = await P.compareWithDeployed({ db, dataDir: dir, romaji: "saitama" });
  assert.deepStrictEqual(r, { same: true, localHash: "h1", deployedHash: "h1", deployedGeneration: 9 });
  assert.deepStrictEqual(asked, ["road_recommend/saitama"], "別の文書を読んだ");
  const none = await P.compareWithDeployed({ db, dataDir: dir, romaji: "nagano" });
  assert.strictEqual(none.same, null, "手元にデータが無いのに同じとした");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("配信の窓口は書き込む前に止め、画面は同じ中身なら聞いてから「それでも配信する」を送る", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = server.indexOf('app.post("/api/roads/publish/:romaji"');
  const body = server.slice(start, server.indexOf("// ========== 通行規制", start));
  const stop = body.indexOf("if (needsConfirm({ commit, same: comparison.same, confirmSame })) {");
  const write = body.indexOf('run("importRoadRecommend.js"');
  assert.ok(stop > 0, "配信の窓口で止めていない");
  assert.ok(stop < write, "書き込みのあとで止めている（もう配信してしまう）");
  assert.ok(body.includes("const confirmSame = req.body && req.body.confirmSame === true;"), "確かめたことを受け取っていない");
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
  assert.ok(page.includes("if (publishSame === true) {\n      if (confirmSamePublish()) runPublish(true, true);"),
    "画面で、本番と同じ中身のときに聞いていない");
  assert.ok(page.includes("if (j.needsConfirm) {"), "窓口が止めたときに聞き直していない");
  assert.ok(page.includes("body: JSON.stringify({ commit, confirmSame }),"), "確かめたことを送っていない");
});
