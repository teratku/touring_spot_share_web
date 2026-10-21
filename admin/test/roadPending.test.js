"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { overridesSignature, pendingStatus, diffDelivered } = require("../lib/roadPending");

/**
 * 配信待ちの県（`lib/roadPending.js`）。
 *
 * 利用者の要望（2026-10-21）「修正/追加した都道府県がわかるようにしたい。配信する目安にしたい」。
 * 福島県を配信したら、前回の配信のあとで非表示にした道までまとめて出て 150本 → 121本になった。
 */

const ov = (overrides = {}, added = {}) => ({ romaji: "x", updatedAt: "2026-10-21T00:00:00Z", overrides, added });

test("調整の指紋: 保存し直しただけ（updatedAt だけ違う）では変わらない・鍵の順でも変わらない", () => {
  const a = ov({ "道@1,1": { hidden: true, updatedAt: "2026-10-01T00:00:00Z" } });
  const b = ov({ "道@1,1": { updatedAt: "2026-10-21T09:00:00Z", hidden: true } });
  assert.strictEqual(overridesSignature(a), overridesSignature(b));
});

test("調整の指紋: 非表示・札・足した道が変われば変わる", () => {
  const base = overridesSignature(ov({ "道@1,1": { hidden: false, tags: [] } }));
  assert.notStrictEqual(overridesSignature(ov({ "道@1,1": { hidden: true, tags: [] } })), base);
  assert.notStrictEqual(overridesSignature(ov({ "道@1,1": { hidden: false, tags: ["scenic"] } })), base);
  assert.notStrictEqual(overridesSignature(ov({ "道@1,1": { hidden: false, tags: [] } }, { "新@2,2": { name: "新" } })), base);
  // 調整ファイルが無いのと空なのは同じ
  assert.strictEqual(overridesSignature(null), overridesSignature(ov()));
});

test("状態: 調整を保存して作り直していない → 再生成が要る（配信より先に言う）", () => {
  const saved = ov({ "道@1,1": { hidden: true } });
  const local = { contentHash: "aaa", overridesHash: overridesSignature(ov()), builtAt: "2026-10-20T00:00:00Z" };
  const s = pendingStatus({ local, overrides: saved, deployed: { contentHash: "aaa" } });
  assert.deepStrictEqual(s, { state: "rebuild", rebuildNeeded: true, publishNeeded: false });
  // ⚠️ 本番とも違うときも「再生成が要る」を先に言う（作り直さないと配信の中身が決まらない）
  assert.strictEqual(pendingStatus({ local, overrides: saved, deployed: { contentHash: "zzz" } }).state, "rebuild");
});

test("状態: 作り直した中身が本番と違う → 配信待ち／同じ → 同じ／本番に無い → 配信待ち", () => {
  const saved = ov({ "道@1,1": { hidden: true } });
  const local = { contentHash: "bbb", overridesHash: overridesSignature(saved) };
  assert.strictEqual(pendingStatus({ local, overrides: saved, deployed: { contentHash: "aaa" } }).state, "publish");
  assert.strictEqual(pendingStatus({ local, overrides: saved, deployed: { contentHash: "bbb" } }).state, "same");
  assert.strictEqual(pendingStatus({ local, overrides: saved, deployed: null }).state, "publish");
  assert.strictEqual(pendingStatus({ local: null, overrides: saved, deployed: null }).state, "unbuilt");
});

test("状態: 指紋の無い古い生成物は、調整ファイルの更新時刻と生成した時刻で比べる", () => {
  const local = { contentHash: "aaa", builtAt: "2026-10-20T00:00:00Z" };
  const deployed = { contentHash: "aaa" };
  assert.strictEqual(pendingStatus({ local, overrides: ov(), overridesMtimeMs: Date.parse("2026-10-21T00:00:00Z"), deployed }).state, "rebuild");
  assert.strictEqual(pendingStatus({ local, overrides: ov(), overridesMtimeMs: Date.parse("2026-10-19T00:00:00Z"), deployed }).state, "same");
  assert.strictEqual(pendingStatus({ local, overrides: null, overridesMtimeMs: null, deployed }).state, "same");
});

test("本番との差: 増える・消える・変わる（札・表示名・形）。点数だけの違いは数えない", () => {
  const seg = (name, lat, extra = {}) => ({ name, start: [lat, 140], polyline: "abc", tags: [], score: 50, ...extra });
  const deployed = [seg("残る道", 38), seg("消える道", 37), seg("札が変わる道", 36), seg("点数だけ", 35)];
  const local = [seg("残る道", 38), seg("増える道", 34, { title: "見出し" }),
                 seg("札が変わる道", 36, { tags: ["scenic"] }), seg("点数だけ", 35, { score: 80 })];
  const d = diffDelivered(deployed, local);
  assert.deepStrictEqual(d.added.map((x) => x.name), ["見出し"]);
  assert.deepStrictEqual(d.removed.map((x) => x.name), ["消える道"]);
  assert.deepStrictEqual(d.changed.map((x) => [x.name, x.what]), [["札が変わる道", ["札"]]]);
});

test("本番との差: 調整の鍵（overrideKey）が付いただけの道は、同じ道として比べる", () => {
  const seg = { name: "富士山スカイライン", start: [35.32966, 138.80198], polyline: "abc", tags: ["scenic"] };
  const d = diffDelivered([seg], [{ ...seg, overrideKey: "富士山スカイライン@35.34,138.80" }]);
  assert.deepStrictEqual([d.added.length, d.removed.length, d.changed.length], [0, 0, 0]);
});

test("生成物に、どの調整で作ったかの指紋を残す", () => {
  const build = fs.readFileSync(path.join(__dirname, "..", "buildRoadRecommend.js"), "utf8");
  assert.match(build, /overridesHash: require\("\.\/lib\/roadPending"\)\.overridesSignatureOfFile\(/);
});

// ---------- 画面の配線 ----------
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
function fnSrc(name) {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} が無い`);
  return m[0];
}

test("画面のコードが構文として通る", () => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(html))) assert.doesNotThrow(() => new vm.Script(m[1]));
});

test("県の一覧と保存・配信のたびに、配信待ちを付け直す", () => {
  assert.match(fnSrc("loadPrefectures"), /refreshPending\(\)/);
  assert.match(fnSrc("save"), /refreshPending\(\)/);
  assert.match(fnSrc("runPublish"), /refreshPending\(\{ refresh: true \}\)/);
  // 下見で作り直したら差を出し直す
  assert.match(fnSrc("runPublish"), /showPublishDiff\(state\.romaji\)/);
  assert.match(fnSrc("openPublish"), /showPublishDiff\(state\.romaji\)/);
});

test("県の一覧の印は付け直すたびに二重にならない", () => {
  const src = fnSrc("refreshPending");
  const opt = { textContent: "福島県 ・調整180", value: "fukushima" };
  const sel = { options: [opt] };
  const els = { pref: sel, tunePref: { options: [] }, pendingBadge: { style: {}, textContent: "" } };
  const ctx = {
    $: (id) => els[id],
    PENDING_LABEL: { rebuild: "再生成が要る", publish: "配信待ち", unbuilt: "未生成" },
    pending: { list: [], diffs: {} },
    fetch: async () => ({ json: async () => ({ prefectures: [{ romaji: "fukushima", state: "publish" }] }) }),
  };
  vm.runInNewContext(`${src}\nrun = async () => { await refreshPending(); await refreshPending(); };`, ctx);
  return ctx.run().then(() => {
    assert.strictEqual(opt.textContent, "● 福島県 ・調整180");
    assert.strictEqual(els.pendingBadge.textContent, "1");
  });
});

test("再生成が要る県は、差を見る前に手元だけ作り直す（本番には書かない口）", () => {
  const src = fnSrc("showPendingDiff");
  assert.match(src, /p\.state === "rebuild"/);
  assert.match(src, /\/api\/roads\/rebuild\/\$\{romaji\}/);
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const rebuild = server.match(/app\.post\("\/api\/roads\/rebuild\/:romaji"[\s\S]*?\n\}\);/)[0];
  assert.match(rebuild, /buildRoadRecommend\.js/);
  assert.doesNotMatch(rebuild, /importRoadRecommend/);
});
