"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const publishLog = require("../lib/publishLog");

/**
 * 配信の記録（`lib/publishLog.js`）と、おすすめ道路 調整ツールの配信まわり。
 *
 * ⚠️ 利用者の要望（2026-09-26）:
 *    - 配信したログを残したい（直近どれを配信したか確認したい）
 *    - 本番配信が終わると栃木に戻ってしまう
 */
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "publog-")), "publish-log.jsonl");
const root = path.join(__dirname, "..");
const source = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("書き足した記録を新しい順に読む（壊れた行は飛ばす）", () => {
  const file = tmpFile();
  publishLog.append({ at: "2026-09-25T10:00:00.000Z", kind: "roads", romaji: "tochigi", prefecture: "栃木県" }, file);
  publishLog.append({ at: "2026-09-26T09:00:00.000Z", kind: "restrictions", romaji: "ibaraki", prefecture: "茨城県" }, file);
  fs.appendFileSync(file, "{壊れた行\n");
  publishLog.append({ at: "2026-09-26T08:00:00.000Z", kind: "roads", romaji: "gunma", prefecture: "群馬県" }, file);
  const rows = publishLog.read({}, file);
  assert.deepStrictEqual(rows.map((r) => r.romaji), ["ibaraki", "gunma", "tochigi"]);
  assert.deepStrictEqual(publishLog.read({ limit: 2 }, file).map((r) => r.romaji), ["ibaraki", "gunma"]);
  // 無いファイルは空
  assert.deepStrictEqual(publishLog.read({}, path.join(os.tmpdir(), "無い-publish-log.jsonl")), []);
});

test("日時とどこから配信したかを付ける（画面からは tool・手では cli）", () => {
  const file = tmpFile();
  const before = process.env.PUBLISH_VIA;
  try {
    delete process.env.PUBLISH_VIA;
    publishLog.append({ kind: "roads", romaji: "tochigi" }, file);
    process.env.PUBLISH_VIA = "tool";
    publishLog.append({ kind: "roads", romaji: "gunma" }, file);
  } finally {
    if (before === undefined) delete process.env.PUBLISH_VIA; else process.env.PUBLISH_VIA = before;
  }
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepStrictEqual(rows.map((r) => r.via), ["cli", "tool"]);
  for (const r of rows) assert.ok(!isNaN(new Date(r.at)), `日時が無い: ${r.at}`);
});

test("記録が書けなくても配信を止めない", () => {
  // ⚠️ 本番へは送り終わっている。ここで例外を投げると、配信したのに失敗と出る
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publog-ro-"));
  const blocked = path.join(dir, "file");
  fs.writeFileSync(blocked, "");
  assert.strictEqual(publishLog.append({ kind: "roads" }, path.join(blocked, "publish-log.jsonl")), false);
});

test("県ごとの最新を種類ごとに引く", () => {
  const rows = [
    { at: "2026-09-26T09:00:00Z", kind: "roads", romaji: "tochigi", generation: 9 },
    { at: "2026-09-26T08:00:00Z", kind: "restrictions", romaji: "tochigi" },
    { at: "2026-09-25T08:00:00Z", kind: "roads", romaji: "tochigi", generation: 8 },
    { at: "2026-09-24T08:00:00Z", kind: "roads", romaji: "gunma", generation: 3 },
  ];
  const latest = publishLog.latestByPrefecture(rows);
  assert.strictEqual(latest.roads.tochigi.generation, 9, "古いほうを最新にしている");
  assert.strictEqual(latest.roads.gunma.generation, 3);
  assert.strictEqual(latest.restrictions.tochigi.at, "2026-09-26T08:00:00Z");
  assert.strictEqual(latest.restrictions.gunma, undefined);
});

// MARK: 記録を書く場所

/** `from` より後で最初に `needle` が出る位置（無ければ -1） */
const after = (code, from, needle) => { const i = code.indexOf(from); return i < 0 ? -1 : code.indexOf(needle, i); };

test("おすすめ道路は、本番へ書き終えてから記録する（下見では書かない）", () => {
  const code = source("importRoadRecommend.js");
  const at = code.indexOf("publishLog.append({\n      kind: \"roads\"");
  assert.ok(at > 0, "記録を書いていない");
  // ⚠️ 下見（--commit なし）の return より後、索引を書き終えた後
  assert.ok(code.indexOf("if (!COMMIT) {") < at, "下見でも記録している");
  assert.ok(after(code, "doc(\"_index\").set(", "publishLog.append(") === at, "索引を書く前に記録している");
  // 世代が上がったか（全ユーザーが落とし直すか）を残す
  assert.ok(code.slice(at, at + 600).includes("bumped: bumped.includes(t)"));
});

test("通行規制も、本番へ書き終えてから記録する（下見では書かない）", () => {
  const code = source("importRestrictions.js");
  const at = code.indexOf("publishLog.append({\n      kind: \"restrictions\"");
  assert.ok(at > 0, "記録を書いていない");
  assert.ok(code.indexOf("if (!COMMIT) {") < at, "下見でも記録している");
  assert.ok(after(code, "db.collection(COLLECTION).doc(t.data.romaji).set(", "publishLog.append(") === at,
            "本番へ書く前に記録している");
  // 県と件数を残す（どれを配信したか分かるように）
  const body = code.slice(at, at + 300);
  assert.ok(body.includes("romaji: t.data.romaji") && body.includes("count: t.data.restrictions.length"));
});

test("画面から配信したことが分かり、記録を返す窓口がある", () => {
  const code = source("server.js");
  const run = code.slice(code.indexOf("function run(script, args)"), code.indexOf("app.post(\"/api/roads/publish/:romaji\""));
  assert.ok(run.includes("PUBLISH_VIA: \"tool\""), "画面から配信したことを渡していない");
  assert.ok(code.includes("app.get(\"/api/publish-log\""), "記録を返す窓口が無い");
  assert.ok(code.includes("latest: publishLog.latestByPrefecture(entries)"), "県ごとの最新を返していない");
});

// MARK: 調整ツールの画面

const html = source("public/road-builder.html");
const pageCode = (() => {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join("\n");
})();

/** 画面のコードから関数を1つ切り出す（括弧の対応で終わりを探す） */
function extract(name) {
  const start = pageCode.indexOf(name);
  assert.ok(start >= 0, `${name} が無い`);
  let depth = 0, i = pageCode.indexOf("{", pageCode.indexOf(")", start));
  for (; i < pageCode.length; i++) {
    if (pageCode[i] === "{") depth++;
    else if (pageCode[i] === "}" && --depth === 0) break;
  }
  return pageCode.slice(start, i + 1);
}

test("画面のコードが構文として通る", () => {
  assert.doesNotThrow(() => new vm.Script(pageCode));
});

/** `loadPrefectures` を、選択欄と通信を模して動かす */
async function runLoadPrefectures(stateRomaji, opts) {
  // ⚠️ ブラウザと同じく、選択肢を作り直すと値は空になり、最初の選択肢が選ばれる
  const sel = (initial) => {
    let value = initial;
    const o = { options: [], appendChild(opt) { this.options.push(opt); if (this.options.length === 1) value = opt.value; } };
    Object.defineProperty(o, "innerHTML", { get: () => "", set: () => { o.options = []; value = ""; } });
    Object.defineProperty(o, "value", { get: () => value, set: (v) => { value = v; } });
    return o;
  };
  const els = { pref: sel(stateRomaji || ""), tunePref: sel("tochigi") };
  const loaded = [];
  const ctx = {
    $: (id) => els[id],
    state: { romaji: stateRomaji },
    document: { createElement: () => ({}) },
    fetch: async () => ({ json: async () => ({ prefectures: [
      { name: "茨城県", romaji: "ibaraki", built: true, overrides: 3 },
      { name: "栃木県", romaji: "tochigi", built: true, overrides: 0 },
      { name: "群馬県", romaji: "gunma", built: true, overrides: 0 },
    ] }) }),
    loadPrefecture: async (r) => { loaded.push(r); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${extract("async function loadPrefectures(")}; this.loadPrefectures = loadPrefectures;`, ctx);
  await ctx.loadPrefectures(opts);
  return { els, loaded };
}

test("配信のあとに一覧を読み直しても、見ている県のまま（栃木へ戻らない）", async () => {
  // 見ているのは群馬（一覧の先頭ではない）・重みの試算は栃木
  const { els, loaded } = await runLoadPrefectures("gunma", { keep: true });
  assert.strictEqual(els.pref.value, "gunma", "見ていた県から変わっている");
  assert.strictEqual(els.tunePref.value, "tochigi", "重みの試算の県を変えている");
  assert.deepStrictEqual(loaded, [], "読み直しで別の県を読み込んでいる");
  // 「調整N」は読み直している
  assert.ok(els.pref.options.some((o) => /調整3/.test(o.textContent)));
});

test("開いたときは今までどおり栃木から", async () => {
  const { els, loaded } = await runLoadPrefectures(undefined, undefined);
  assert.strictEqual(els.pref.value, "tochigi");
  assert.deepStrictEqual(loaded, ["tochigi"]);
});

test("配信が終わったら、見ている県を地図の位置のまま読み直す", () => {
  const run = extract("async function runPublish(");
  assert.ok(run.includes("await loadPrefectures({ keep: true });"), "見ている県を保っていない");
  assert.ok(run.includes("await loadPrefecture(state.romaji, { keepView: true });"), "作り直した中身を読み直していない");
  assert.ok(!/loadPrefectures\(\s*\)/.test(run), "県を選び直す読み方が残っている");
  const load = extract("async function loadPrefecture(");
  assert.ok(load.includes("if (!keepView) fitPrefecture();"), "地図の位置を県全体へ戻している");
});

test("配信の記録を開ける・配信の確認に前回の配信を出す", () => {
  assert.ok(html.includes("id=\"publishLogBtn\""), "記録を開くボタンが無い");
  assert.ok(pageCode.includes("$(\"publishLogBtn\").onclick = openPublishLog;"), "ボタンが記録を開かない");
  assert.ok(extract("function openPublish(").includes("showLastPublish(\"roads\", state.romaji, state.prefName);"),
            "おすすめ道路の配信で前回を出していない");
  assert.ok(extract("function rOpenPublish(").includes("showLastPublish(\"restrictions\", R.romaji, R.prefName);"),
            "通行規制の配信で前回を出していない");
  assert.ok(extract("async function openPublishLog(").includes("fetchPublishLog()"));
});

test("日時は分まで・ゼロ埋めで出す", () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${extract("function formatPublishedAt(")}; this.f = formatPublishedAt;`, ctx);
  const local = new Date(2026, 8, 6, 7, 5);   // 端末の時刻で 2026/09/06 07:05
  assert.strictEqual(ctx.f(local.toISOString()), "2026/09/06 07:05");
  assert.strictEqual(ctx.f("でたらめ"), "でたらめ");
});
