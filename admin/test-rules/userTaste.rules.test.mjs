/**
 * user_taste（選んだおすすめ道路・スポットの記録）のルール検証。
 * ⚠️ 本人だけが読み書きできること。何を選んだかは他人に見せない（2026-10-06）
 * 動かし方: firebase emulators:exec --only firestore --project biketeilen "node admin/test-rules/userTaste.rules.test.mjs"
 */
import { readFileSync } from "fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc } from "firebase/firestore";

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
await env.cleanup();
for (const [m, l] of results) console.log(` ${m} ${l}`);
process.exit(results.some(([m]) => m === "×") ? 1 : 0);
