/**
 * road_restrictions のルール検証（エミュレータで実際に許可・拒否を確かめる）。
 * 動かし方: firebase emulators:exec --only firestore --project biketeilen 'node roadRestrictions.rules.test.mjs'
 *
 * ⚠️ 利用者の判断（2026-10-25）: 公開サイトの /dev/winter-closures.html から、開発者が本番の冬季閉鎖を直接足す・直す・消す。
 *    書けるのは開発者だけ。誰でも読める（アプリ・Web の一覧）のは変えない
 */
import { readFileSync } from "fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc } from "firebase/firestore";

const RULES = new URL("../../firestore.rules", import.meta.url).pathname;
const DEV = "little_busters_rin_takuya@yahoo.co.jp";
const PAYLOAD = { prefecture: "長野県", romaji: "nagano", count: 1,
  restrictions: [{ id: "winter-nagano-webtest", kind: "winterClosure", name: "テスト", activePeriod: { from: "11-15", to: "04-24" } }] };

const env = await initializeTestEnvironment({
  projectId: "biketeilen",
  firestore: { rules: readFileSync(RULES, "utf8"), host: "127.0.0.1", port: 8080 },
});

const results = [];
const check = async (label, promise) => {
  try { await promise; results.push(["○", label]); }
  catch (e) { results.push(["×", label + " … " + e.message.split("\n")[0]]); }
};

const dev = env.authenticatedContext("dev-uid", { email: DEV, email_verified: true }).firestore();
await check("開発者が冬季閉鎖を書ける", assertSucceeds(setDoc(doc(dev, "road_restrictions", "nagano"), PAYLOAD, { merge: true })));

const other = env.authenticatedContext("other-uid", { email: "someone@example.com" }).firestore();
await check("別のログインユーザーは書けない", assertFails(setDoc(doc(other, "road_restrictions", "nagano"), PAYLOAD)));
await check("ログインユーザーは読める", assertSucceeds(getDoc(doc(other, "road_restrictions", "nagano"))));

const anon = env.unauthenticatedContext().firestore();
await check("未ログインは書けない", assertFails(setDoc(doc(anon, "road_restrictions", "nagano"), PAYLOAD)));
await check("未ログインでも読める（アプリ・Web の一覧）", assertSucceeds(getDoc(doc(anon, "road_restrictions", "nagano"))));

// 配信データは誰も書けないまま（巻き添えで緩んでいないか）
await check("おすすめ道路の配信データは開発者でも書けないまま",
            assertFails(setDoc(doc(dev, "road_recommend", "_index"), { x: 1 })));

await env.cleanup();
for (const [mark, label] of results) console.log(` ${mark} ${label}`);
process.exit(results.some(([m]) => m === "×") ? 1 : 0);
