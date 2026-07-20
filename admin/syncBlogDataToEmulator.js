#!/usr/bin/env node
/**
 * syncBlogDataToEmulator.js
 *
 * ローカルのFirestoreエミュレータで blog_posts を本番と同じ見た目で確認できるよう、
 * 本番Firestoreの blog_posts 全件と、その本文中の {{spot:ID}} / {{route:ID}} が
 * 参照している imagedownload / shared_routes ドキュメントだけをローカルエミュレータへコピーする。
 *
 * 使い方:
 *   1. 別ターミナルで `firebase emulators:start`（Firestoreエミュレータが起動している状態）
 *   2. cd admin && npm install            # 初回のみ
 *   # 認証（どちらか）
 *   #  a) gcloud auth application-default login
 *   #  b) admin/serviceAccount.json を置く（.gitignore 済み）
 *   3. node syncBlogDataToEmulator.js [--emulator-host 127.0.0.1:8080]
 *
 * ⚠️ 読み取るのは本番Firestore（読み取り専用）、書き込むのはローカルエミュレータのみ。
 *    本番データは一切変更しない。
 */
"use strict";

const admin = require("firebase-admin");

const PROJECT_ID = "biketeilen";

// ---- 引数 ----
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const EMULATOR_HOST = argVal("--emulator-host", "127.0.0.1:8080");

// ---- 認証（本番読み取り用） ----
function initProdApp() {
  const path = require("path");
  const fs = require("fs");
  const saPath = path.join(__dirname, "serviceAccount.json");
  if (fs.existsSync(saPath)) {
    console.log("🔑 認証: serviceAccount.json");
    return admin.initializeApp(
      { credential: admin.credential.cert(require(saPath)), projectId: PROJECT_ID },
      "prod"
    );
  }
  console.log("🔑 認証: applicationDefault（gcloud ADC）");
  return admin.initializeApp(
    { credential: admin.credential.applicationDefault(), projectId: PROJECT_ID },
    "prod"
  );
}

async function main() {
  const prodApp = initProdApp();
  const localApp = admin.initializeApp({ projectId: PROJECT_ID }, "local");
  const localDb = localApp.firestore();
  localDb.settings({ host: EMULATOR_HOST, ssl: false });
  const prodDb = prodApp.firestore();

  console.log(`🌐 ローカルエミュレータ接続先: ${EMULATOR_HOST}`);

  // 1. blog_posts を全件コピー
  const blogSnap = await prodDb.collection("blog_posts").get();
  console.log(`📝 blog_posts: 本番 ${blogSnap.size} 件`);

  const spotIds = new Set();
  const routeIds = new Set();
  const batch1 = localDb.batch();
  blogSnap.forEach((doc) => {
    batch1.set(localDb.collection("blog_posts").doc(doc.id), doc.data());
    const content = doc.data().content || "";
    [...content.matchAll(/\{\{spot:([a-zA-Z0-9_-]+)\}\}/g)].forEach((m) => spotIds.add(m[1]));
    [...content.matchAll(/\{\{route:([a-zA-Z0-9_-]+)\}\}/g)].forEach((m) => routeIds.add(m[1]));
  });
  await batch1.commit();
  console.log(`  ✅ ローカルへコピー完了`);

  // 2. 本文が参照している spot / route のみをコピー（コレクション全体は取得しない）
  console.log(`📍 参照スポット: ${spotIds.size} 件 / 参照ルート: ${routeIds.size} 件`);

  let spotOk = 0, spotMiss = 0;
  for (const id of spotIds) {
    const doc = await prodDb.collection("imagedownload").doc(id).get();
    if (doc.exists) {
      await localDb.collection("imagedownload").doc(id).set(doc.data());
      spotOk++;
    } else {
      console.warn(`  ⚠️ imagedownload/${id} が本番に見つかりません（記事内の誤ったIDの可能性）`);
      spotMiss++;
    }
  }

  let routeOk = 0, routeMiss = 0;
  for (const id of routeIds) {
    const doc = await prodDb.collection("shared_routes").doc(id).get();
    if (doc.exists) {
      await localDb.collection("shared_routes").doc(id).set(doc.data());
      routeOk++;
    } else {
      console.warn(`  ⚠️ shared_routes/${id} が本番に見つかりません（記事内の誤ったIDの可能性）`);
      routeMiss++;
    }
  }

  console.log("");
  console.log("===== 完了 =====");
  console.log(`blog_posts: ${blogSnap.size} 件`);
  console.log(`imagedownload: 成功 ${spotOk} / 見つからず ${spotMiss}`);
  console.log(`shared_routes: 成功 ${routeOk} / 見つからず ${routeMiss}`);
  console.log("");
  console.log("※ エミュレータはインメモリのため、再起動すると消えます。");
  console.log("　 再実行するか、`firebase emulators:export ./local-data` で保存して");
  console.log("　 次回 `firebase emulators:start --import=./local-data` で読み込んでください。");
}

main().catch((e) => {
  console.error("❌ FAIL", e);
  process.exit(1);
});
