"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * storage.rules の書き方の守り。
 *
 * ⚠️ 2026-10-09 に報告: Web のバックアップルートが、本人なのに「User does not have permission」で読めなかった。
 *    読み込みにも大きさの上限（within()＝request.resource.size）を掛けていて、本番の評価器では読み込み・削除のとき
 *    request.resource が無いため「Property resource is undefined」のエラーで拒否されていた。
 *    **手元のエミュレーターはこれを通してしまう**（admin/test-rules はすべて通っていた）ので、ここで書き方を確かめる。
 *    本番の評価器で確かめるには Rules API の `projects/biketeilen:test`（規則の中身を渡すだけ・データに触れない）
 */
const rules = fs.readFileSync(path.join(__dirname, "..", "..", "storage.rules"), "utf8");

test("大きさの上限（within）は、作る・上書きする（create, update）ときだけに掛ける", () => {
  const statements = [...rules.matchAll(/allow\s+([a-z,\s]+):\s*if([^;]*);/g)];
  assert.ok(statements.length >= 10, "材料: allow 文を読めていない");
  const bad = statements
    .filter((m) => m[2].includes("within("))
    .map((m) => m[1].replace(/\s+/g, " ").trim())
    .filter((methods) => methods !== "create, update");
  assert.deepStrictEqual(bad, [], `読み込み・削除にも上限を掛けている（本番では拒否される）: ${bad.join(" / ")}`);
});

test("本人のバックアップは、本人なら読めて消せる（上限を掛けない）", () => {
  const block = rules.slice(rules.indexOf("match /route_backups/{uid}/{allPaths=**}"));
  // ⚠️ 置き場所の {uid} の閉じかっこで止めない（ブロックの終わりは行頭の「    }」）
  const body = block.slice(0, block.indexOf("\n    }") + 6);
  assert.ok(body.includes("allow read, delete: if isOwner(uid);"), "本人の読み込み・削除の書き方が違う");
  assert.ok(body.includes("allow create, update: if isOwner(uid) && within(60);"), "上げるときの上限が無い");
});
