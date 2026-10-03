"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { privateDocPaths, privateStoragePrefixes, cleanupDeletedUser } = require("../deletedUserCleanup");

/**
 * アカウントが消えたときに、その人だけのデータを消す（deletedUserCleanup.js）。
 * ⚠️ 利用者の判断（2026-10-03）: 規約とポリシーを今のアプリに合わせるにあたり、退会処理も直す
 */

/** 偽物の Firestore と Storage。消した場所を残す */
function fakes({ failDocs = [], failPrefixes = [] } = {}) {
  const deleted = [];
  const db = {
    doc: (path) => ({ path }),
    recursiveDelete: async (ref) => {
      if (failDocs.includes(ref.path)) throw new Error("消せない");
      deleted.push(ref.path);
    },
  };
  const bucket = {
    deleteFiles: async ({ prefix }) => {
      if (failPrefixes.includes(prefix)) throw new Error("消せない");
      deleted.push(`storage:${prefix}`);
    },
  };
  return { db, bucket, deleted };
}

test("アプリから消せない課金の状態と紹介の記録、本人だけのデータとバックアップのファイルを消す", async () => {
  const { db, bucket, deleted } = fakes();
  assert.deepStrictEqual(await cleanupDeletedUser("u1", { db, bucket }), []);
  for (const path of ["subscriptions/u1", "referralRewards/u1", "referralRewardEvents/u1",
                      "users/u1", "route_backups/u1", "user_stats/u1", "road_completion/u1", "userInfo/u1"]) {
    assert.ok(deleted.includes(path), `消していない: ${path}`);
  }
  assert.ok(deleted.includes("storage:route_backups/u1/"), "ルート記録のバックアップのファイルを消していない");
  assert.ok(deleted.includes("storage:selectedLocationBackup/u1.json"), "選んだスポットの控えのファイルを消していない");
  assert.ok(deleted.every((p) => p.includes("u1")), `他人のものを消した: ${deleted}`);
});

test("1か所で失敗しても止めず、失敗した場所を返す", async () => {
  const { db, bucket, deleted } = fakes({ failDocs: ["subscriptions/u1"], failPrefixes: ["route_backups/u1/"] });
  const failures = await cleanupDeletedUser("u1", { db, bucket });
  assert.deepStrictEqual(failures, ["subscriptions/u1", "route_backups/u1/"]);
  assert.ok(deleted.includes("userInfo/u1"), "失敗したところで止まった");
});

test("uid が空・パスを含むときは消さない（全体を消す事故を防ぐ）", async () => {
  for (const bad of ["", "a/b", undefined]) {
    assert.throws(() => privateDocPaths(bad), /uid が悪い/);
    assert.throws(() => privateStoragePrefixes(bad), /uid が悪い/);
    const { db, bucket, deleted } = fakes();
    await assert.rejects(cleanupDeletedUser(bad, { db, bucket }), /uid が悪い/);
    assert.deepStrictEqual(deleted, [], `消した: ${deleted}`);
  }
});
