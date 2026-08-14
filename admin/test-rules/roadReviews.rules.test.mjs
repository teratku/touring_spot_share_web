/**
 * road_reviews のルール検証（エミュレータで実際に許可・拒否を確かめる）。
 *
 * ⚠️ **`node --test test/` では動かない。** エミュレータと追加の依存が要るので
 *    別ディレクトリに置いてある。動かし方は admin/README.md の
 *    「評価のルールを確かめる」を参照。
 *
 * ⚠️ これが無いと、ルールの抜けは**アプリ側で黙って失敗する**形でしか現れない。
 *    実際に road_reviews のルールが1行も無く、開発者が付けた評価が
 *    1件も保存されていなかった（PERMISSION_DENIED: No matching allow statements）。
 */
import { readFileSync } from "fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, getDocs, collection } from "firebase/firestore";

const RULES = new URL("../../firestore.rules", import.meta.url).pathname;
const DEV = "little_busters_rin_takuya@yahoo.co.jp";
const DOC = "r:埼玉県|361|secondary";      // アプリが実際に使うキーの形
const PAYLOAD = { verdict: "keep", title: "椿ライン", note: "", tags: [], roadName: "三沢坂本線" };

const env = await initializeTestEnvironment({
  projectId: "biketeilen",
  firestore: { rules: readFileSync(RULES, "utf8"), host: "127.0.0.1", port: 8080 },
});

const results = [];
const check = async (label, promise) => {
  try { await promise; results.push(["○", label]); }
  catch (e) { results.push(["×", label + " … " + e.message.split("\n")[0]]); }
};

// 開発者は読み書きできる
const dev = env.authenticatedContext("dev-uid", { email: DEV, email_verified: true }).firestore();
await check("開発者が保存できる", assertSucceeds(setDoc(doc(dev, "road_reviews", DOC), PAYLOAD)));
await check("開発者が読める", assertSucceeds(getDoc(doc(dev, "road_reviews", DOC))));
await check("開発者が一覧を取れる（調整ツールと同じ操作）",
            assertSucceeds(getDocs(collection(dev, "road_reviews"))));

// それ以外は拒否
const other = env.authenticatedContext("other-uid", { email: "someone@example.com" }).firestore();
await check("別のログインユーザーは保存できない", assertFails(setDoc(doc(other, "road_reviews", DOC), PAYLOAD)));
await check("別のログインユーザーは読めない", assertFails(getDoc(doc(other, "road_reviews", DOC))));

const anon = env.unauthenticatedContext().firestore();
await check("未ログインは保存できない", assertFails(setDoc(doc(anon, "road_reviews", DOC), PAYLOAD)));
await check("未ログインは読めない", assertFails(getDoc(doc(anon, "road_reviews", DOC))));

// 配信データは誰も書けないまま（巻き添えで緩んでいないか）
await check("配信データは開発者でも書けないまま",
            assertFails(setDoc(doc(dev, "road_recommend", "_index"), { x: 1 })));

await env.cleanup();
for (const [mark, label] of results) console.log(` ${mark} ${label}`);
process.exit(results.some(([m]) => m === "×") ? 1 : 0);
