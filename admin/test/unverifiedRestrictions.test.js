"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { hitsOnRoute, applicable } = require("../lib/restrictionAvoid");

/**
 * JARTIC の未確認候補を、ルート生成に混ぜられるようにした件。
 *
 * ⚠️ **既定では混ぜない。** 候補は区間の切れ目が交通規制の単位で決まっていて、
 *    アプリで見せたい「道」の単位とは限らない。避けすぎると走れる道を回り込む。
 * ⚠️ ただし登録があるのは25県だけで、候補はあるのに登録0件の県が14ある。
 *    混ぜられなければ、そこでは規制を避けずに経路が引かれる。
 */

/** 東へ伸びる直線 */
const line = (lng, lat, n, step = 0.0005) =>
  Array.from({ length: n }, (_, i) => [lng + i * step, lat]);

test("避けた規制が、確認済みか未確認かを持って返る", () => {
  // ⚠️ **ここが落ちると、未確認を確認済みと同じ重みで見せることになる**
  const route = line(139.0, 35.0, 40);
  const known   = { id: "osm-1",    kind: "noMotorcycle", name: "登録済みの道", points: line(139.0, 35.0, 40), verified: true };
  const unknown = { id: "jartic-1", kind: "noMotorcycle", name: "未確認の道",   points: line(139.0, 35.0, 40), verified: false };
  const hits = hitsOnRoute(route, applicable([known, unknown]));
  assert.strictEqual(hits.length, 2, "両方が掛かっていない（材料が悪い）");
  const byId = Object.fromEntries(hits.map((h) => [h.id, h.verified]));
  assert.strictEqual(byId["osm-1"], true, "登録済みを未確認としている");
  assert.strictEqual(byId["jartic-1"], false, "未確認を登録済みとしている");
});

test("印が無いものは確認済みとみなす", () => {
  // ⚠️ 既存の規制は `verified` を持っていない。落として未確認扱いにしないこと
  const route = line(139.0, 35.0, 40);
  const old = { id: "osm-2", kind: "noMotorcycle", name: "印の無い道", points: line(139.0, 35.0, 40) };
  const hits = hitsOnRoute(route, applicable([old]));
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].verified, true, "印の無いものを未確認扱いにしている");
});

test("既定では未確認を混ぜない", () => {
  // ⚠️ **明示しない限り混ぜない。** 混ぜるかどうかは呼ぶ側が決める
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/if \(!opts\.includeUnverified\) continue;/.test(server),
    "旗が無くても候補を読んでいる");
  // 3つの窓口すべてが旗を通す
  const wired = (server.match(/restrictionsForPrefectures\(pts, \{ includeUnverified \}\)/g) || []).length;
  assert.strictEqual(wired, 3, `旗を通している窓口が ${wired} 個（3個のはず）`);
  // 受け取っていない窓口があると、実行時に落ちる
  const got = (server.match(/includeUnverified \} = req\.body/g) || []).length;
  assert.strictEqual(got, 3, `旗を受け取っている窓口が ${got} 個（3個のはず）`);
});

test("すでに登録済みの候補を、二重に数えない", () => {
  // ⚠️ 作り直しで昇格した候補は `road-restrictions` 側に同じ id で入っている。
  //    両方から読むと同じ規制を2度避けることになる
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/const known = new Set\(out\.map\(\(r\) => r\.id\)\);/.test(server),
    "すでに読んだ id を控えていない");
  assert.ok(/if \(!c \|\| known\.has\(c\.id\)\) continue;/.test(server),
    "登録済みと同じ id の候補を弾いていない");
});

test("販売APIには、未確認を混ぜる道が無い", () => {
  // ⚠️ **売り物に未確認を入れてはいけない。** service は Firestore の
  //    `road_restrictions` だけを読む（候補はそこに無い）
  const svc = fs.readFileSync(
    path.join(__dirname, "..", "..", "service", "server.js"), "utf8");
  assert.ok(!/includeUnverified/.test(svc), "販売APIに未確認の口ができている");
  assert.ok(!/restriction-jartic/.test(svc), "販売APIが候補ファイルを読んでいる");
});

test("画面が、確認済みと未確認を分けて出す", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "valhalla.html"), "utf8");
  assert.ok(/id="includeUnverified"/.test(html), "混ぜるかどうかの切り替えが無い");
  assert.ok(/h\.verified !== false/.test(html) && /h\.verified === false/.test(html),
    "確認済みと未確認を分けていない");
  assert.ok(/未確認の規制の上を通る/.test(html), "未確認の見出しが無い");
  // ⚠️ 作っただけでは出ない。表示に繋がっているか
  const at = html.indexOf("right = `<span class=\"num\">${(r.lengthMeters");
  const built = html.slice(at, html.indexOf("el.innerHTML", at));
  assert.ok(built.includes("hitText"), "hitText を表示に足していない");
});

test("画面は既定でオン、窓口は既定でオフ", () => {
  // ⚠️ **道具と窓口で既定を分ける。** 画面は開発者が全部見るためのものなので混ぜる。
  //    窓口を既定オンにすると、アプリと販売APIの挙動が黙って変わる
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "valhalla.html"), "utf8");
  assert.ok(/id="includeUnverified" checked/.test(html), "画面の既定がオフになっている");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(!/includeUnverified = true/.test(server), "窓口の既定がオンになっている");
  assert.ok(/if \(!opts\.includeUnverified\) continue;/.test(server),
    "旗が無いときに候補を読まない作りになっていない");
});
