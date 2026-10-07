/**
 * image_moderation（セーフサーチで印が付いた画像）のルール検証。
 * ⚠️ 開発者だけが読めて「問題なし」を付けられる。一般の人は読めず、誰も作れない（関数だけが作る）（2026-10-07）
 * 動かし方: firebase emulators:exec --only firestore --project biketeilen "node admin/test-rules/imageModeration.rules.test.mjs"
 */
import { readFileSync } from "fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, updateDoc } from "firebase/firestore";

const RULES = new URL("../../firestore.rules", import.meta.url).pathname;
const DEV = "little_busters_rin_takuya@yahoo.co.jp";
const env = await initializeTestEnvironment({
  projectId: "biketeilen",
  firestore: { rules: readFileSync(RULES, "utf8"), host: "127.0.0.1", port: 8080 },
});
const results = [];
const check = async (label, promise) => {
  try { await promise; results.push(["○", label]); }
  catch (e) { results.push(["×", label + " … " + e.message.split("\n")[0]]); }
};
const ID = "images%2Fx.jpg";
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), "image_moderation", ID), { path: "images/x.jpg", status: "pending" });
});
const dev = env.authenticatedContext("dev", { email: DEV }).firestore();
const user = env.authenticatedContext("u1", { email: "someone@example.com" }).firestore();
const anon = env.unauthenticatedContext().firestore();
await check("開発者は読める", assertSucceeds(getDoc(doc(dev, "image_moderation", ID))));
await check("開発者は「問題なし」を付けられる", assertSucceeds(updateDoc(doc(dev, "image_moderation", ID), { status: "ok" })));
await check("開発者でも作れない（関数だけが作る）", assertFails(setDoc(doc(dev, "image_moderation", "new"), { status: "pending" })));
await check("一般の人は読めない", assertFails(getDoc(doc(user, "image_moderation", ID))));
await check("一般の人は書けない", assertFails(updateDoc(doc(user, "image_moderation", ID), { status: "ok" })));
await check("未ログインは読めない", assertFails(getDoc(doc(anon, "image_moderation", ID))));
await env.cleanup();
for (const [m, l] of results) console.log(` ${m} ${l}`);
process.exit(results.some(([m]) => m === "×") ? 1 : 0);
