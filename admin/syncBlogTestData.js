#!/usr/bin/env node
/**
 * syncBlogTestData.js
 *
 * ローカルFirestoreエミュレータに、ブログ記事（本番の全 blog_posts）と、
 * その記事本文が参照する {{spot:xxx}} / {{route:xxx}} の実データだけを
 * 本番Firestoreからコピーする運用スクリプト。
 *
 * 【背景】blog-detail.html は blog_posts の他に imagedownload（スポット）/
 * shared_routes（ルート）を読んで記事内の埋め込みカードを描画する。
 * エミュレータは空データで起動するため、ローカル確認時にブログ本文の
 * {{spot:xxx}} 等が未展開のまま・記事が「見つかりません」になる。
 *
 * 【エミュレータのデータが消える件について】
 * Firestoreエミュレータは既定でメモリ上のみにデータを保持し、
 * `firebase emulators:start` を再起動すると消える。
 * 消えるたびにこのスクリプトを再実行してもよいが、
 * `--import`/`--export-on-exit` で永続化する方が手間がない。
 * 詳しくは admin/README.md の「ローカルでブログを確認する」を参照。
 *
 * 使い方:
 *   cd admin && npm install            # 初回のみ
 *   # 認証（どちらか）
 *   #  a) gcloud auth application-default login
 *   #  b) admin/serviceAccount.json を置く（.gitignore 済み）
 *   firebase emulators:start --import=./emulator-data --export-on-exit &   # エミュレータ起動（別ターミナル）
 *   node syncBlogTestData.js           # 本番 → ローカルエミュレータへ同期
 *
 * ⚠️ 読み取りは本番Firestoreから、書込みは常にローカルエミュレータのみ。
 *    本番データを変更することは一切ない。
 */
"use strict";

const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

function initProdApp() {
  const path = require("path");
  const fs = require("fs");
  const saPath = path.join(__dirname, "serviceAccount.json");
  if (fs.existsSync(saPath)) {
    return admin.initializeApp(
      { credential: admin.credential.cert(require(saPath)), projectId: PROJECT_ID },
      "prod"
    );
  }
  return admin.initializeApp(
    { credential: admin.credential.applicationDefault(), projectId: PROJECT_ID },
    "prod"
  );
}

function initLocalApp() {
  const app = admin.initializeApp({ projectId: PROJECT_ID }, "local");
  app.firestore().settings({ host: EMULATOR_HOST, ssl: false });
  return app;
}

async function main() {
  // エミュレータが起動しているか先に確認（起動していないと分かりにくいエラーになるため）
  try {
    await require("http").get(`http://${EMULATOR_HOST}/`).on("error", () => {
      throw new Error("unreachable");
    });
  } catch (_) {
    // ここでは軽く投げるだけ。実際のFirestore呼び出し側で失敗すれば分かる。
  }

  const prodDb = initProdApp().firestore();
  const localDb = initLocalApp().firestore();

  console.log(`📡 ローカルエミュレータ: ${EMULATOR_HOST}`);
  console.log("🔄 blog_posts を本番からコピー中...");

  const blogSnap = await prodDb.collection("blog_posts").get();
  if (blogSnap.empty) {
    console.log("⚠️ 本番に blog_posts が1件もありません。中断します。");
    process.exit(1);
  }

  const batchBlog = localDb.batch();
  const spotIds = new Set();
  const routeIds = new Set();
  blogSnap.forEach((doc) => {
    batchBlog.set(localDb.collection("blog_posts").doc(doc.id), doc.data());
    const content = doc.data().content || "";
    [...content.matchAll(/\{\{spot:([a-zA-Z0-9_-]+)\}\}/g)].forEach((m) => spotIds.add(m[1]));
    [...content.matchAll(/\{\{route:([a-zA-Z0-9_-]+)\}\}/g)].forEach((m) => routeIds.add(m[1]));
  });
  await batchBlog.commit();
  console.log(`✅ blog_posts ${blogSnap.size} 件コピー完了`);

  console.log(`🔄 参照スポット ${spotIds.size} 件・参照ルート ${routeIds.size} 件をコピー中...`);
  let spotOk = 0, spotMiss = 0, routeOk = 0, routeMiss = 0;

  for (const id of spotIds) {
    const doc = await prodDb.collection("imagedownload").doc(id).get();
    if (doc.exists) {
      await localDb.collection("imagedownload").doc(id).set(doc.data());
      spotOk++;
    } else {
      console.log(`  ⚠️ spot 本番に無し（記事内の未入力プレースホルダー等の可能性）: ${id}`);
      spotMiss++;
    }
  }

  for (const id of routeIds) {
    const doc = await prodDb.collection("shared_routes").doc(id).get();
    if (doc.exists) {
      await localDb.collection("shared_routes").doc(id).set(doc.data());
      routeOk++;
    } else {
      console.log(`  ⚠️ route 本番に無し（記事内の未入力プレースホルダー等の可能性）: ${id}`);
      routeMiss++;
    }
  }

  console.log("");
  console.log("===== 同期完了 =====");
  console.log(`blog_posts: ${blogSnap.size} 件`);
  console.log(`imagedownload: ${spotOk} 件成功 / ${spotMiss} 件見つからず`);
  console.log(`shared_routes: ${routeOk} 件成功 / ${routeMiss} 件見つからず`);
  console.log("");
  console.log("💡 `firebase emulators:start --export-on-exit` で終了すると、");
  console.log("   次回 `--import=./emulator-data` で再起動時にこのデータが復元され、");
  console.log("   このスクリプトを毎回実行する必要が無くなります。");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌ 失敗:", e.message);
    console.error("   ローカルエミュレータ（firestore）が起動しているか確認してください。");
    process.exit(1);
  });
