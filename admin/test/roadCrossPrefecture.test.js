"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { encode } = require("../lib/polyline");
const { overrideKey } = require("../lib/roadOverrides");
const cp = require("../lib/roadCrossPrefecture");

/**
 * ほかの県に登録済みの道（`lib/roadCrossPrefecture.js`）。
 *
 * 2026-10-21 利用者の報告: 調整ツールで、ほかの県で登録している道が見えず、同じ道を別の県に足してしまう
 *   （福島県に蔵王エコーライン（宮城・山形の道）、埼玉県に上野原丹波山線（山梨・東京の道）など）。
 * ⚠️ 点は [経度, 緯度]（`lib/polyline.js` と同じ）
 */

/** 北へまっすぐ伸びる線（約110mおき） */
function northLine(lng, lat, count) {
  return [...Array(count)].map((_, i) => [lng, lat + i * 0.001]);
}

/** 経度で県を分ける仮の県境（140.0 より西は山形県、東は宮城県） */
const locate = (lng) => (lng < 140.0 ? "山形県" : "宮城県");

/** 仮の data フォルダ */
function makeData({ recommend = {}, overrides = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspref-"));
  fs.mkdirSync(path.join(dir, "road-recommend"));
  fs.mkdirSync(path.join(dir, "road-overrides"));
  for (const [romaji, segments] of Object.entries(recommend)) {
    fs.writeFileSync(path.join(dir, "road-recommend", `${romaji}.json`), JSON.stringify({ segments }));
  }
  for (const [romaji, body] of Object.entries(overrides)) {
    fs.writeFileSync(path.join(dir, "road-overrides", `${romaji}.json`), JSON.stringify(body));
  }
  return dir;
}

function seg(name, points, extra = {}) {
  const lat = (p) => p[1], lng = (p) => p[0];
  return { name, polyline: encode(points), start: [lat(points[0]), lng(points[0])],
           end: [lat(points.at(-1)), lng(points.at(-1))], score: 50, ...extra };
}

const addedOf = (name, points, extra = {}) => ({ name, highway: "secondary", shape: encode(points), tags: [], boost: 0, ...extra });

test("同じ道は重なる・少し離れた並行の道は重ならない", () => {
  const road = northLine(140.1, 38.0, 60);
  const same = northLine(140.1003, 38.0, 60);           // 約26m東
  const parallel = northLine(140.103, 38.0, 60);        // 約260m東
  assert.ok(cp.coverage(road, same).fraction > 0.95);
  assert.strictEqual(cp.coverage(road, parallel).fraction, 0);
});

test("間引いた線（頂点がまばら）でも、線分との距離で重なりを測る", () => {
  const road = northLine(140.1, 38.0, 60);
  // ⚠️ 生成の線は直線部分の点が少ない。点との距離で測ると、直線の真ん中が「離れている」ことになる
  const sparse = [road[0], road[59]];
  assert.ok(cp.coverage(road, sparse).fraction > 0.95);
});

test("どの県を何割通るか（長さで割る）", () => {
  const line = northLine(139.99, 38.0, 30).concat(northLine(140.01, 38.03, 10));
  const shares = cp.prefectureShares(line, locate);
  assert.strictEqual(shares[0].name, "山形県");
  assert.strictEqual(shares[0].romaji, "yamagata");
  assert.ok(Math.abs(shares.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
});

test("開いている県をほとんど通らない道だけ、別の県を勧める（県境で半々なら勧めない）", () => {
  const inMiyagi = cp.prefectureShares(northLine(140.1, 38.0, 30), locate);
  assert.deepStrictEqual(cp.suggestedPrefecture(inMiyagi, "fukushima").romaji, "miyagi");
  assert.strictEqual(cp.suggestedPrefecture(inMiyagi, "miyagi"), null);
  const half = [{ name: "山形県", romaji: "yamagata", share: 0.5 }, { name: "宮城県", romaji: "miyagi", share: 0.5 }];
  assert.strictEqual(cp.suggestedPrefecture(half, "yamagata"), null);
});

test("全県の登録済みの道: 生成した道と、まだ生成していない足した道。生成済みの足した道は二重に数えない", () => {
  const echo = northLine(140.1, 38.0, 40);
  const high = northLine(140.2, 38.0, 20);
  const dir = makeData({
    recommend: { miyagi: [seg("蔵王エコーライン", echo)] },
    overrides: { miyagi: { overrides: {}, added: {
      [overrideKey(seg("蔵王エコーライン", echo))]: addedOf("蔵王エコーライン", echo),   // 生成済み（同じ鍵）
      [overrideKey(seg("蔵王ハイライン", high))]: addedOf("蔵王ハイライン", high),       // まだ生成していない
    } } },
  });
  const roads = cp.buildCatalog(dir);
  assert.deepStrictEqual(roads.map((r) => `${r.name}:${r.source}`).sort(),
    ["蔵王エコーライン:generated", "蔵王ハイライン:added"]);
  assert.strictEqual(roads[0].prefecture, "宮城県");
});

test("足す道と重なる登録済みの道を見つける。交差点で触れただけの道は拾わない", () => {
  const echo = northLine(140.1, 38.0, 40);
  const crossing = [[140.09, 38.02], [140.11, 38.02]];  // 横切るだけ
  const dir = makeData({ recommend: { miyagi: [seg("蔵王エコーライン", echo), seg("横切る道", crossing)] } });
  const found = cp.findOverlaps(northLine(140.1002, 38.0, 40), cp.buildCatalog(dir));
  assert.deepStrictEqual(found.map((o) => o.name), ["蔵王エコーライン"]);
  assert.strictEqual(found[0].prefecture, "宮城県");
  assert.ok(found[0].fraction > 0.9);
});

test("短い道を長い道に足すときも重なりとみなす（登録済みの側が覆われる割合も見る）", () => {
  const long = northLine(140.1, 38.0, 100);
  const short = northLine(140.1, 38.03, 15);
  const dir = makeData({ recommend: { miyagi: [seg("短い道", short)] } });
  const found = cp.findOverlaps(long, cp.buildCatalog(dir));
  assert.strictEqual(found.length, 1);
  assert.ok(found[0].existingCovered > 0.9 && found[0].newCovered < 0.3);
});

test("地図の範囲の道。開いている県は除く・線だけ返す", () => {
  const dir = makeData({ recommend: {
    miyagi: [seg("宮城の道", northLine(140.1, 38.0, 10))],
    yamagata: [seg("山形の道", northLine(139.9, 38.0, 10))],
  } });
  const r = cp.roadsInBounds(cp.buildCatalog(dir), [139.5, 37.5, 140.5, 38.5], { exclude: "yamagata" });
  assert.deepStrictEqual(r.roads.map((x) => x.name), ["宮城の道"]);
  assert.ok(r.roads[0].polyline && !r.roads[0].points && !r.roads[0].bounds);
});

test("別の県へ足す: その県の調整とほかの足した道に触れない・同じ鍵は上書きしない", () => {
  const dir = makeData({ overrides: { miyagi: { overrides: { "x@1,1": { hidden: true } }, added: { "y@1,1": addedOf("y", northLine(140.3, 38, 5)) } } } });
  const ovDir = path.join(dir, "road-overrides");
  const a = addedOf("蔵王ハイライン", northLine(140.2, 38.0, 20));
  assert.deepStrictEqual(cp.appendAdded(ovDir, "miyagi", "k", a), { ok: true });
  const raw = JSON.parse(fs.readFileSync(path.join(ovDir, "miyagi.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(raw.added).sort(), ["k", "y@1,1"]);
  assert.strictEqual(raw.overrides["x@1,1"].hidden, true);
  assert.strictEqual(cp.appendAdded(ovDir, "miyagi", "k", a).ok, false);
  // 県が無いファイルにも作れる・名前の無い道は足さない
  assert.strictEqual(cp.appendAdded(ovDir, "yamagata", "k", a).ok, true);
  assert.strictEqual(cp.appendAdded(ovDir, "akita", "z", { ...a, name: "" }).ok, false);
  assert.strictEqual(cp.appendAdded(ovDir, "nowhere", "z", a).ok, false);
});

test("別の県に入った足した道を移す。移す先に同じ道（足した道・生成データ）があれば外すだけ", () => {
  const high = northLine(140.2, 38.0, 20);        // 宮城県の道なのに福島県に入っている
  const echo = northLine(140.1, 38.0, 40);        // 宮城県の生成データに同じ鍵がある
  const own = northLine(139.5, 38.0, 20);          // 山形県の道が山形県にある（動かさない）
  const keyHigh = overrideKey(seg("蔵王ハイライン", high));
  const keyEcho = overrideKey(seg("蔵王エコーライン", echo));
  const dir = makeData({
    recommend: { miyagi: [seg("蔵王エコーライン", echo)] },
    overrides: {
      fukushima: { overrides: { keep: { boost: 5 } }, added: {
        [keyHigh]: addedOf("蔵王ハイライン", high, { tags: ["winding"] }),
        [keyEcho]: addedOf("蔵王エコーライン", echo),
      } },
      yamagata: { overrides: {}, added: { mine: addedOf("山形の道", own) } },
    },
  });
  const plan = cp.planMisplaced(dir, locate);
  assert.deepStrictEqual(plan.map((p) => `${p.from}>${p.to}:${p.name}:${p.action}`).sort(),
    ["fukushima>miyagi:蔵王エコーライン:drop", "fukushima>miyagi:蔵王ハイライン:move"]);
  const done = cp.applyMisplaced(dir, plan);
  assert.ok(done.every((d) => d.ok));
  const fk = JSON.parse(fs.readFileSync(path.join(dir, "road-overrides", "fukushima.json"), "utf8"));
  const mg = JSON.parse(fs.readFileSync(path.join(dir, "road-overrides", "miyagi.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(fk.added), []);
  assert.deepStrictEqual(fk.overrides, { keep: { boost: 5 } });
  assert.deepStrictEqual(Object.keys(mg.added), [keyHigh]);
  // ⚠️ 札など足した道の中身はそのまま移す
  assert.deepStrictEqual(mg.added[keyHigh].tags, ["winding"]);
  // 移したあとは何も残らない
  assert.deepStrictEqual(cp.planMisplaced(dir, locate), []);
});

// ---------- 画面（road-builder.html）の配線 ----------
// ⚠️ 地図そのものは node では確かめられない。ここで押さえるのは配線が生きていることと、足す前に必ず照合すること

const vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const scripts = (() => {
  const out = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
})();
function fnSrc(name) {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} が無い`);
  return m[0];
}

test("画面のコードが構文として通る", () => {
  for (const [i, c] of scripts.entries()) assert.doesNotThrow(() => new vm.Script(c), `${i} 番目の script`);
});

test("地図ができたら点線を用意し、県を開くたびに描き直す", () => {
  assert.match(fnSrc("initMap"), /setupRegisteredLayer\(\)/);
  assert.match(fnSrc("loadPrefecture"), /drawRegistered\(\)/);
  // 開いている県は自分で描くので外す
  assert.match(fnSrc("drawRegistered"), /exclude=\$\{encodeURIComponent\(state\.romaji\)\}/);
  // 古い返事で描かない
  assert.match(fnSrc("drawRegistered"), /if \(seq !== reg\.seq\) return;/);
});

test("足す前に全県と照合し、勧める県・重なる道があれば止める（「それでも足す」で照合を飛ばす）", () => {
  const commit = fnSrc("commitAddRoad");
  assert.match(commit, /\/api\/roads\/check-add/);
  assert.match(commit, /if \(!force\)/);
  assert.match(commit, /check\.suggested \|\| \(check\.overlaps \|\| \[\]\)\.length/);
  // 照合で止めたときは state.added に入れない（return が先）
  assert.ok(commit.indexOf("d.check = check") < commit.indexOf("state.added[key] ="));
  assert.match(html, /\$\("addForce"\)\.onclick = \(\) => \{ keep\(\); commitAddRoad\(\{ force: true \}\); \};/);
});

test("線を引き直したら照合の結果を捨てる（前の線の結果で「それでも足す」させない）", () => {
  assert.match(fnSrc("connectAddRoad"), /d\.check = null;/);
  assert.match(fnSrc("useCsvRoad"), /d\.check = null;/);
});

test("勧めた県へ足すときは、いまの名前で鍵を作り、その県のファイルへ書く", () => {
  const f = fnSrc("addToSuggestedPrefecture");
  assert.match(f, /addedKeyOf\(name, d\.shape\)/);
  assert.match(f, /\/api\/roads\/added\/\$\{target\.romaji\}/);
  // 開いている県には入れない
  assert.doesNotMatch(f, /state\.added\[/);
});

test("足した道の鍵は、サーバの overrideKey と同じ", () => {
  const ctx = {};
  vm.runInNewContext(`${fnSrc("decodePolyline")}\n${fnSrc("addedKeyOf")}\nout = addedKeyOf("蔵王ハイライン", shape);`,
    Object.assign(ctx, { shape: encode([[140.4512, 38.1249], [140.46, 38.13]]) }));
  assert.strictEqual(ctx.out, overrideKey({ name: "蔵王ハイライン", start: [38.1249, 140.4512] }));
});

test("サーバに3つの口がある", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /app\.get\("\/api\/roads\/registered"/);
  assert.match(server, /app\.post\("\/api\/roads\/check-add"/);
  assert.match(server, /app\.post\("\/api\/roads\/added\/:romaji"/);
});
