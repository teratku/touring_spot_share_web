"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 登録した規制を Firestore へ反映する窓口と画面。
 *
 * ⚠️ **本番へ書く操作。** 誤った区間を配ると「通れない」と誤案内することになる。
 *    ここで押さえるのは **下見を通さずに書けないこと** と
 *    **未確認の候補が配られないこと**。
 */
const BASE = process.env.ADMIN_URL || "http://127.0.0.1:4317";
const html = fs.readFileSync(path.join(__dirname, "..", "public", "rebuild.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const inline = () => {
  const out = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join("\n");
};

async function up() {
  try { return (await fetch(`${BASE}/api/rebuild/prefectures`, { signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
}
const skipIfDown = async (t) => (await up()) ? false : t.skip(`管理ツールが居ない（${BASE}）`);

test("`commit` を付けない限り書き込まない", async (t) => {
  // ⚠️ **既定は下見。** 呼んだだけで本番が書き換わってはいけない
  assert.ok(/if \(commit\) args\.push\("--commit"\);/.test(server),
    "commit のときだけ --commit を付ける作りになっていない");
  if (await skipIfDown(t)) return;
  const ask = (body) => fetch(`${BASE}/api/restrictions/publish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  }).then((x) => x.json());

  assert.strictEqual((await ask({})).commit, false, "旗が無いのに本番へ書こうとしている");
  // ⚠️ **`true` そのものだけを通すこと。** 真とみなせる値まで通すと、
  //    フォームの "false" や 1 で本番が書き換わる
  for (const bad of ["false", "true", 1, "yes", {}]) {
    assert.strictEqual((await ask({ commit: bad })).commit, false,
      `commit: ${JSON.stringify(bad)} で本番へ書こうとしている`);
  }
  assert.strictEqual((await ask({ commit: true, prefecture: "存在しない県" })).commit, true,
    "true を渡しても本番扱いにならない（材料が悪い）");
});

test("未確認の候補は配らない", () => {
  // ⚠️ **`importRestrictions.js` が読むのは `data/road-restrictions` だけ。**
  //    候補ファイルを読ませたら、確認していない区間が端末へ届く
  const script = fs.readFileSync(path.join(__dirname, "..", "importRestrictions.js"), "utf8");
  assert.ok(/road-restrictions/.test(script), "登録済みを読んでいない");
  assert.ok(!/restriction-jartic/.test(script), "未確認の候補ファイルを読んでいる");
  assert.ok(!/restriction-jartic/.test(
    server.slice(server.indexOf('app.post("/api/restrictions/publish"'),
                 server.indexOf('app.post("/api/rebuild/:romaji/promote"'))),
    "反映の窓口が候補ファイルに触っている");
});

test("下見が通るまで、本番のボタンを押せない", () => {
  // ⚠️ **押し間違いで配信されないように。** 下見が落ちたなら直してから
  assert.ok(/id="pubGo" class="danger" disabled/.test(html),
    "本番のボタンが最初から押せる");
  const code = inline();
  assert.ok(/go\.disabled = !r\.ok;/.test(code), "下見の結果でボタンを開けていない");
  assert.ok(/confirm\(/.test(code), "本番へ書く前に確かめていない");
});

test("何が配られないかを画面に書いている", () => {
  // ⚠️ アプリのルート生成には効かない。誤解したまま反映されると
  //    「反映したのにルートが変わらない」と悩むことになる
  assert.ok(/未確認の JARTIC 候補は配られない/.test(html), "配らないものの説明が無い");
  assert.ok(/ルート生成に規制を使っていない/.test(html),
    "アプリのルート生成には効かないことを書いていない");
});

test("画面の県数が、反映の出力と食い違わない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **空のファイルを県として数えない。** 食い違うと「反映されていない県がある」
  //    と疑うことになる（実際に 26県 対 25県 でずれた）
  const r = await fetch(`${BASE}/api/restrictions/publish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}), signal: AbortSignal.timeout(120_000),
  }).then((x) => x.json());
  const m = /検証（書き込みません）:\s*(\d+)県/.exec(r.stdout || "");
  assert.ok(m, `出力から県数を読み取れない: ${String(r.stdout).slice(0, 120)}`);
  assert.strictEqual(r.files, Number(m[1]),
    `画面 ${r.files}県 と出力 ${m[1]}県 が食い違う`);
});
