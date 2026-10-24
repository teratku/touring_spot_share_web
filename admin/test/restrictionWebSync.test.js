"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { mergeWebEdits } = require("../lib/restrictionWebSync");

/**
 * 開発用 Web（/dev/winter-closures.html）で本番に足した・直した・消した冬季閉鎖を、配信の前に手元へ取り込む。
 * ⚠️ 利用者の判断（2026-10-25）: 公開サイトの /dev で本番に直接書く。配信は県を丸ごと上書きするので、取り込まないと消える
 */

const r = (id, extra = {}) => Object.assign({ id, kind: "winterClosure", name: id, polyline: "_p~iF~ps|U" }, extra);

test("/dev で足したものを手元に足す", () => {
  const out = mergeWebEdits([r("a")], { restrictions: [r("a"), r("web1", { editedOnWeb: "2026-10-25T10:00:00Z" })] });
  assert.deepStrictEqual(out.restrictions.map((x) => x.id), ["a", "web1"]);
  assert.deepStrictEqual(out.added, ["web1"]);
});

test("/dev で直した日付が手元より新しければ採る・古ければ手元のまま", () => {
  const prod = { restrictions: [r("a", { activePeriod: { from: "11-20", to: "04-10" }, editedOnWeb: "2026-10-25T10:00:00Z" })] };
  const older = mergeWebEdits([r("a", { activePeriod: { from: "11-11", to: "04-20" } })], prod);
  assert.deepStrictEqual(older.restrictions[0].activePeriod, { from: "11-20", to: "04-10" });
  assert.deepStrictEqual(older.updated, ["a"]);
  const same = mergeWebEdits([r("a", { activePeriod: { from: "11-01", to: "04-01" }, editedOnWeb: "2026-10-25T10:00:00Z" })], prod);
  assert.deepStrictEqual(same.restrictions[0].activePeriod, { from: "11-01", to: "04-01" }, "手元で取り込み済みのものを本番で上書きした");
});

test("/dev で消したものは手元からも消す（生き返らせない）", () => {
  const out = mergeWebEdits([r("a"), r("b")], { restrictions: [r("a")], deletedOnWeb: ["b"] });
  assert.deepStrictEqual(out.restrictions.map((x) => x.id), ["a"]);
  assert.deepStrictEqual(out.removed, ["b"]);
});

test("/dev の印が無い本番の違いは取り込まない（手元が正）", () => {
  const out = mergeWebEdits([r("a", { name: "手元" })], { restrictions: [r("a", { name: "本番" }), r("old")] });
  assert.deepStrictEqual(out.restrictions.map((x) => x.name), ["手元"]);
  assert.strictEqual(out.added.length + out.updated.length + out.removed.length, 0);
});

test("配信の前に取り込み、取り込んだら消した印を空に戻す", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "importRestrictions.js"), "utf8");
  const main = src.slice(src.indexOf("async function main()"));
  assert.ok(main.indexOf("pullWebEdits(") >= 0 && main.indexOf("pullWebEdits(") < main.indexOf(".set({"), "配信の前に取り込んでいない");
  assert.ok(src.includes("deletedOnWeb: admin.firestore.FieldValue.delete()"), "消した印を戻していない");
});
