"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * コンテナの起動スクリプトと Dockerfile。
 *
 * ⚠️ **ここは Cloud Run で2回落ちた場所。** どちらも手元のテストでは分からず、
 *    デプロイして初めて出た。二度と同じ落ち方をしないよう文字で押さえる。
 */
const ROOT = path.join(__dirname, "..");
const start = fs.readFileSync(path.join(ROOT, "start.sh"), "utf8");
/** ⚠️ コメントを外して見ること。注意書きに書いた語まで拾ってしまう */
const startCode = start.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");

test("bash 専用の書き方をするなら、shebang も bash にする", () => {
  // ⚠️ **実際に落ちた。** `#!/bin/sh` は Debian では dash で、
  //    `wait -n` は `wait: Illegal option -n` になる。
  //    Valhalla は起動済み・/status も 200 だったのに、この1行でコンテナごと終了した
  const shebang = start.split("\n")[0];
  const usesBashOnly = /\bwait\s+-n\b/.test(startCode);
  if (usesBashOnly) {
    assert.ok(/bash/.test(shebang),
      `bash 専用の書き方（wait -n）があるのに shebang が ${shebang}`);
  }
});

test("どちらかが落ちたら、コンテナごと終わらせる", () => {
  // ⚠️ 片方だけ生きていると「繋がるのに経路が出ない」状態になり、
  //    Cloud Run が異常に気づけない
  assert.ok(/wait\s+-n/.test(startCode), "両方を見張っていない");
  assert.ok(/VALHALLA_PID/.test(startCode) && /API_PID/.test(startCode),
    "Valhalla と API の両方を控えていない");
  // ⚠️ ポーリングで代用しないこと。ゾンビは `kill -0` が成功し続ける
  assert.ok(!/kill -0/.test(startCode), "kill -0 のポーリングでは落ちたことを検知できない");
});

test("土台の ENTRYPOINT を打ち消している", () => {
  // ⚠️ **実際に落ちた。** 土台は ENTRYPOINT ["/valhalla/scripts/run.sh"] なので、
  //    こちらの CMD はその引数になるだけで start.sh に届かない。
  //    「If you run with custom UID or GID …/custom_files」→ exit(1)
  assert.ok(/^ENTRYPOINT \[\]$/m.test(dockerfile),
    "土台の ENTRYPOINT を打ち消していない（CMD が引数として渡されるだけになる）");
  const e = dockerfile.lastIndexOf("ENTRYPOINT []");
  const c = dockerfile.lastIndexOf('CMD ["/app/start.sh"]');
  assert.ok(e >= 0 && c > e, "ENTRYPOINT [] は CMD より前に置くこと");
});

test("ビルドの仕方を書き残している", () => {
  // ⚠️ BuildKit は土台を Docker Hub に取りに行き pull access denied で落ちる
  // ⚠️ **コマンドの行そのものを見ること。** 注意書きにも同じ語が出るので、
  //    ファイル全体を検索すると「手順から消えた」ことに気づけない
  const cmdLine = dockerfile.split("\n")
    .find((l) => /docker build .*-f service\/Dockerfile/.test(l));
  assert.ok(cmdLine, "ビルドのコマンドが書かれていない");
  assert.ok(/DOCKER_BUILDKIT=0/.test(cmdLine),
    `手順に旧ビルダーの指定が無い: ${cmdLine.trim()}`);
  assert.ok(/ \.$/.test(cmdLine.trim()), "根からビルドする形になっていない");
});

test("読み込むファイルが、ぜんぶイメージに入っている", () => {
  // ⚠️ **実際に落ちた。** `service/lib` のコピーを忘れて
  //    `Cannot find module './lib/buildRoute'` になった。
  //    ⚠️ 手元では動くので、**デプロイするまで分からない**。ここで押さえる
  const copied = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+(\S+)/gm)].map((m) => m[1]);
  const roots = path.join(ROOT, "..");

  /**
   * ファイルが辿る相対 require を集める。
   * ⚠️ **コメントを外してから見ること。** 説明文の中の
   *    `require("../admin/lib/…")` のような例示まで拾ってしまう
   */
  const requiresOf = (file) => {
    const code = fs.readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")     // ブロックコメント
      .replace(/^\s*\/\/.*$/gm, "");        // 行コメント
    return [...code.matchAll(/require\("(\.[^"]+)"\)/g)].map((m) => m[1]);
  };

  const files = [path.join(ROOT, "server.js")];
  for (const f of fs.readdirSync(path.join(ROOT, "lib")).filter((x) => x.endsWith(".js"))) {
    files.push(path.join(ROOT, "lib", f));
  }

  for (const file of files) {
    for (const rel of requiresOf(file)) {
      const abs = path.resolve(path.dirname(file), rel) + ".js";
      const fromRoot = path.relative(roots, abs);          // 例 admin/lib/polyline.js
      assert.ok(fs.existsSync(abs), `参照先が無い: ${fromRoot}`);
      // COPY した所（ディレクトリでもよい）に含まれているか
      const ok = copied.some((c) => fromRoot === c || fromRoot.startsWith(c.replace(/\/$/, "") + "/"));
      assert.ok(ok, `イメージに入っていない: ${fromRoot}（${path.basename(file)} が読む）`);
    }
  }
});
