/**
 * user_taste（選んだおすすめ道路・スポットの記録）のルール検証。
 * ⚠️ 本人だけが読み書きできること。何を選んだかは他人に見せない（2026-10-06）
 * ⚠️ みんなの人気（popularity）は誰でも読めて、アプリからは書けないこと（2026-10-07）
 * ⚠️ 自分のいいねはまとめて読めるが、他人のいいねはまとめて読めないこと（2026-10-07）
 * 動かし方: firebase emulators:exec --only firestore --project biketeilen "node admin/test-rules/userTaste.rules.test.mjs"
 */
import { readFileSync } from "fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, getDocs, collectionGroup, query, where } from "firebase/firestore";

const RULES = new URL("../../firestore.rules", import.meta.url).pathname;
const env = await initializeTestEnvironment({
  projectId: "biketeilen",
  firestore: { rules: readFileSync(RULES, "utf8"), host: "127.0.0.1", port: 8080 },
});
const DATA = { roads: { "r%3A1": { key: "r:埼玉県|361|secondary", name: "三沢坂本線", count: 1 } } };
const results = [];
const check = async (label, promise) => {
  try { await promise; results.push(["○", label]); }
  catch (e) { results.push(["×", label + " … " + e.message.split("\n")[0]]); }
};
const me = env.authenticatedContext("u1").firestore();
const other = env.authenticatedContext("u2").firestore();
const anon = env.unauthenticatedContext().firestore();
await check("本人は書ける", assertSucceeds(setDoc(doc(me, "user_taste", "u1"), DATA, { merge: true })));
await check("本人は読める", assertSucceeds(getDoc(doc(me, "user_taste", "u1"))));
await check("他人は読めない", assertFails(getDoc(doc(other, "user_taste", "u1"))));
await check("他人は書けない", assertFails(setDoc(doc(other, "user_taste", "u1"), DATA)));
await check("未ログインは読めない", assertFails(getDoc(doc(anon, "user_taste", "u1"))));
// みんなの人気（2026-10-07）: 誰でも読めて、アプリからは書けない（関数だけが書く）
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), "popularity", "roads"), { items: [{ key: "r:埼玉県|361|secondary", users: 3 }] });
});
await check("人気は未ログインでも読める", assertSucceeds(getDoc(doc(anon, "popularity", "roads"))));
await check("人気はログインしていても書けない", assertFails(setDoc(doc(me, "popularity", "roads"), { items: [] })));
await check("人気は未ログインでは書けない", assertFails(setDoc(doc(anon, "popularity", "spots"), { items: [] })));
// 自分のいいねをまとめて読む（2026-10-07）: 本人の分だけ
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "imagedownload", "s1", "yaehCount", "l1"), { userID: "u1", imageAutoID: "s1" });
  await setDoc(doc(db, "imagedownload", "s2", "yaehCount", "l2"), { userID: "u2", imageAutoID: "s2" });
});
await check("自分のいいねはまとめて読める", assertSucceeds(getDocs(query(collectionGroup(me, "yaehCount"), where("userID", "==", "u1")))));
await check("他人のいいねはまとめて読めない", assertFails(getDocs(query(collectionGroup(me, "yaehCount"), where("userID", "==", "u2")))));
await check("絞らずに全員のいいねは読めない", assertFails(getDocs(collectionGroup(me, "yaehCount"))));
await check("未ログインはまとめて読めない", assertFails(getDocs(query(collectionGroup(anon, "yaehCount"), where("userID", "==", "u1")))));
await check("スポットごとのいいねは今までどおり誰でも読める", assertSucceeds(getDoc(doc(anon, "imagedownload", "s2", "yaehCount", "l2"))));
await env.cleanup();
for (const [m, l] of results) console.log(` ${m} ${l}`);
process.exit(results.some(([m]) => m === "×") ? 1 : 0);
