/**
 * storage.rules の検証（エミュレータで実際に許可・拒否を確かめる）。
 *
 * ⚠️ 2026-10-03 まで本番のファイル置き場は `allow read, write: if true`（誰でも一覧・読み書き・削除）だった。
 *    ルート記録のバックアップ（走った軌跡）も含まれていた。プライバシーポリシー8に合わせて締めた
 * ⚠️ **`node --test test/` では動かない。** 動かし方は admin/README.md「ファイル置き場のルールを確かめる」
 */
import { readFileSync } from "fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";

// STORAGE_RULES は壊した版で確かめるとき用（admin/test-rules/storage.rules.mutate.mjs）
const RULES = process.env.STORAGE_RULES || new URL("../../storage.rules", import.meta.url).pathname;
const DEV = "little_busters_rin_takuya@yahoo.co.jp";
const BYTES = new Uint8Array([1, 2, 3]);
const JSON_META = { contentType: "application/json" };
const JPEG_META = { contentType: "image/jpeg" };
const MB = 1024 * 1024;

const env = await initializeTestEnvironment({
  projectId: "biketeilen",
  storage: { rules: readFileSync(RULES, "utf8"), host: "127.0.0.1", port: 9199 },
});

// 読むための材料を、ルールを通さずに置いておく
const SEEDED = [
  "route_backups/u1/route.json", "selectedLocationBackup/u1.json", "routeBackups/u1_routes_0.json",
  "images/spot.jpg", "userIcon/me.jpg", "routes/r1/cover.jpg", "routes/JSON/r1.json",
  "Json/road_names/a.json", "grids_empty/roads_grid_1.csv", "grid_boundaries.csv",
  "blog_images/b.jpg", "inquiryDetailImage/q.jpg", "anything/else.bin",
];
await env.withSecurityRulesDisabled(async (ctx) => {
  for (const path of SEEDED) await ctx.storage().ref(path).put(BYTES);
});

const u1 = env.authenticatedContext("u1", { email: "u1@example.com" }).storage();
const u2 = env.authenticatedContext("u2", { email: "u2@example.com" }).storage();
const dev = env.authenticatedContext("dev-uid", { email: DEV, email_verified: true }).storage();
const anon = env.unauthenticatedContext().storage();

const results = [];
const check = async (group, label, promise) => {
  try { await promise; results.push(["○", group, label]); }
  catch (e) { results.push(["×", group, `${label} … ${String(e.message).split("\n")[0]}`]); }
};

// 本人のバックアップ（走った軌跡）
let g = "本人のバックアップ";
await check(g, "本人は上げられる", assertSucceeds(u1.ref("route_backups/u1/new.json").put(BYTES, JSON_META)));
await check(g, "本人は読める", assertSucceeds(u1.ref("route_backups/u1/route.json").getDownloadURL()));
await check(g, "本人は一覧できる", assertSucceeds(u1.ref("route_backups/u1").listAll()));
await check(g, "本人は消せる（退会・バックアップの削除）", assertSucceeds(u1.ref("route_backups/u1/new.json").delete()));
await check(g, "他人は読めない", assertFails(u2.ref("route_backups/u1/route.json").getDownloadURL()));
await check(g, "他人は書けない", assertFails(u2.ref("route_backups/u1/x.json").put(BYTES, JSON_META)));
await check(g, "他人は消せない", assertFails(u2.ref("route_backups/u1/route.json").delete()));
await check(g, "未ログインは一覧できない", assertFails(anon.ref("route_backups/u1").listAll()));
await check(g, "未ログインは読めない", assertFails(anon.ref("route_backups/u1/route.json").getDownloadURL()));

// 選んだスポットの控え・古いルートの控え（名前の頭が uid）
g = "控えのファイル";
await check(g, "本人は {uid}.json を上げられる", assertSucceeds(u1.ref("selectedLocationBackup/u1.json").put(BYTES, JSON_META)));
await check(g, "本人は {uid}_locations.json を上げられる",
            assertSucceeds(u1.ref("selectedLocationBackup/u1_locations.json").put(BYTES, JSON_META)));
await check(g, "本人は控えを読める", assertSucceeds(u1.ref("selectedLocationBackup/u1.json").getDownloadURL()));
await check(g, "他人は控えを読めない", assertFails(u2.ref("selectedLocationBackup/u1.json").getDownloadURL()));
await check(g, "他人は控えを上書きできない", assertFails(u2.ref("selectedLocationBackup/u1.json").put(BYTES, JSON_META)));
await check(g, "uid の頭が同じだけの名前（u1x）は他人のもの",
            assertFails(u1.ref("selectedLocationBackup/u1x_locations.json").put(BYTES, JSON_META)));
await check(g, "本人は古いルートの控えを上げられる", assertSucceeds(u1.ref("routeBackups/u1_routes_1.json").put(BYTES, JSON_META)));
await check(g, "他人は古いルートの控えを読めない", assertFails(u2.ref("routeBackups/u1_routes_0.json").getDownloadURL()));

// 公開の投稿（スポットの写真・プロフィール画像・共有ルート）
g = "公開の投稿";
await check(g, "未ログインでもスポットの写真を読める", assertSucceeds(anon.ref("images/spot.jpg").getDownloadURL()));
await check(g, "未ログインでも共有ルートを読める", assertSucceeds(anon.ref("routes/JSON/r1.json").getDownloadURL()));
await check(g, "未ログインでもプロフィール画像を読める", assertSucceeds(anon.ref("userIcon/me.jpg").getDownloadURL()));
await check(g, "ログインした人は写真を上げられる", assertSucceeds(u1.ref("images/new.jpg").put(BYTES, JPEG_META)));
await check(g, "ログインした人は共有ルートの表紙を種類なしで上げられる（EditSharedRouteView）",
            assertSucceeds(u1.ref("routes/r1/cover.jpg").put(BYTES)));
await check(g, "ログインした人は共有ルートの線を上げられる", assertSucceeds(u1.ref("routes/JSON/r2.json").put(BYTES, JSON_META)));
await check(g, "ログインした人はプロフィール画像を上げられる", assertSucceeds(u1.ref("userIcon/new.jpg").put(BYTES, JPEG_META)));
await check(g, "ログインした人は写真を消せる（投稿の削除・退会）", assertSucceeds(u1.ref("images/new.jpg").delete()));
await check(g, "未ログインは写真を上げられない", assertFails(anon.ref("images/x.jpg").put(BYTES, JPEG_META)));
await check(g, "未ログインは共有ルートを上げられない", assertFails(anon.ref("routes/JSON/x.json").put(BYTES, JSON_META)));
await check(g, "未ログインは写真を消せない", assertFails(anon.ref("images/spot.jpg").delete()));

// 大きさの上限
g = "大きさの上限";
const big = new Uint8Array(20 * MB + 1);
await check(g, "20MB を超える写真は上げられない", assertFails(u1.ref("images/big.jpg").put(big, JPEG_META)));
await check(g, "20MB を超えるプロフィール画像は上げられない", assertFails(u1.ref("userIcon/big.jpg").put(big, JPEG_META)));
await check(g, "バックアップは 20MB を超えても上げられる（線は最大 50MB）",
            assertSucceeds(u1.ref("route_backups/u1/big.json").put(big, JSON_META)));

// マスタ
g = "マスタ";
await check(g, "未ログインでも配信データを読める", assertSucceeds(anon.ref("Json/road_names/a.json").getDownloadURL()));
await check(g, "未ログインでも地図のグリッドを読める", assertSucceeds(anon.ref("grids_empty/roads_grid_1.csv").getDownloadURL()));
await check(g, "ログインした人も配信データを書けない", assertFails(u1.ref("Json/road_names/a.json").put(BYTES, JSON_META)));
await check(g, "開発者でもアプリからは配信データを書けない", assertFails(dev.ref("Json/x.json").put(BYTES, JSON_META)));
await check(g, "ログインした人も地図のグリッドを書けない", assertFails(u1.ref("grids_empty/roads_grid_1.csv").put(BYTES)));
await check(g, "ログインした人もグリッドの境界を書けない", assertFails(u1.ref("grid_boundaries.csv").put(BYTES)));

// ブログの画像
g = "ブログの画像";
await check(g, "開発者はブログの画像を上げられる", assertSucceeds(dev.ref("blog_images/new.jpg").put(BYTES, JPEG_META)));
await check(g, "開発者はブログのサムネイルを上げられる", assertSucceeds(dev.ref("blog_thumbnails/new.jpg").put(BYTES, JPEG_META)));
await check(g, "未ログインでもブログの画像を読める", assertSucceeds(anon.ref("blog_images/b.jpg").getDownloadURL()));
await check(g, "ほかのログインユーザーはブログの画像を上げられない", assertFails(u1.ref("blog_images/x.jpg").put(BYTES, JPEG_META)));

// それ以外
g = "それ以外は拒否";
await check(g, "問い合わせの画像はログインした人が上げられる", assertSucceeds(u1.ref("inquiryDetailImage/new.jpg").put(BYTES, JPEG_META)));
await check(g, "未ログインは問い合わせの画像を読めない", assertFails(anon.ref("inquiryDetailImage/q.jpg").getDownloadURL()));
await check(g, "未ログインは問い合わせの画像を上げられない", assertFails(anon.ref("inquiryDetailImage/x.jpg").put(BYTES, JPEG_META)));
await check(g, "ルールに無い場所は読めない", assertFails(u1.ref("anything/else.bin").getDownloadURL()));
await check(g, "ルールに無い場所には書けない", assertFails(u1.ref("anything/new.bin").put(BYTES)));
await check(g, "未ログインは置き場の一番上を一覧できない", assertFails(anon.ref("").listAll()));

await env.cleanup();
for (const [mark, group, label] of results) console.log(` ${mark} [${group}] ${label}`);
const failed = results.filter(([m]) => m === "×");
console.log(failed.length ? `\n${failed.length} 件が違う` : `\nすべて期待どおり（${results.length} 件）`);
process.exit(failed.length ? 1 : 0);
