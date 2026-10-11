"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildTollIndex, measureToll, tollKind, applyToll } = require("../lib/roadToll");
const { applyOverrides, normalizeOverride, isEmptyOverride, normalizeAdded, overrideKey } = require("../lib/roadOverrides");
const { tollWayOf } = require("../buildTollWays");
const { encode, decode } = require("../lib/polyline");

/**
 * おすすめ道路の「有料」「一部有料」（利用者の要望 2026-10-11: 道ごとに有料かどうかを記載し、アプリにも出す）。
 * ⚠️ 実データでの確かめ: 配信中 6,522本で 有料21・一部有料4（芦ノ湖スカイラインも入る・首都高の下の道は入らない）
 */

/** 東西にまっすぐな線（経度 lng0 から km ぶん東へ・緯度 lat） */
const eastward = (lng0, lat, km, n = 20) => {
  const kmPerDegree = (6371 * Math.PI / 180) * Math.cos((lat * Math.PI) / 180);
  return Array.from({ length: n + 1 }, (_, i) => [lng0 + (km / kmPerDegree) * (i / n), lat]);
};
const way = (points, { n = "", r = "", h = "tertiary" } = {}) => ({ n, r, h, p: encode(points) });

test("有料の道に重なる長さだけを数え、交差する道は数えない", () => {
  const road = eastward(139.0, 35.0, 10);
  // 前半4km が有料（同じ線）
  const index = buildTollIndex([
    way(eastward(139.0, 35.0, 4), { n: "テストスカイライン" }),
    // 南北に交差する有料の道（向きが90度違う）。⚠️ 道の1区間の中点（6.25km）を通るように置く
    //    （中点から離れた所で交差させると、向きを見なくても数えないので確かめにならない）
    way([[road[12][0] + (road[13][0] - road[12][0]) / 2, 34.99],
         [road[12][0] + (road[13][0] - road[12][0]) / 2, 35.01]], { n: "交差する有料道路" }),
  ]);
  const m = measureToll(road, index, { name: "県道1号" });
  assert.ok(Math.abs(m.totalMeters - 10000) < 50, `全長 ${m.totalMeters}`);
  assert.ok(Math.abs(m.tollMeters - 4000) < 600, `有料 ${m.tollMeters}m（交差する道を数えていないか）`);
  assert.deepStrictEqual(m.names, ["テストスカイライン"]);
  // 反対向きに描かれた有料の線（上下線）も数える
  const reversed = buildTollIndex([way(eastward(139.0, 35.0, 10).reverse())]);
  assert.ok(measureToll(road, reversed, {}).tollMeters > 9000, "反対向きに描かれた有料の線を数えていない");
  // 30m 離れて並ぶ有料の道は別の道
  const apart = buildTollIndex([way(eastward(139.0, 35.0003, 10))]);
  assert.strictEqual(measureToll(road, apart, {}).tollMeters, 0, "並んで走る別の道を数えた");
});

test("高速の有料は名前か路線番号が同じときだけ数える（一般道の真上の首都高を数えない）", () => {
  const road = eastward(139.7, 35.6, 5);
  const above = buildTollIndex([way(eastward(139.7, 35.6, 5), { n: "首都高速都心環状線", r: "C1", h: "motorway" })]);
  assert.strictEqual(measureToll(road, above, { name: "高輪麻布線", ref: "" }).tollMeters, 0, "真上の首都高を数えた");
  // 芦ノ湖スカイラインは OSM で一部が motorway。名前が同じなら数える
  const same = buildTollIndex([way(eastward(139.7, 35.6, 5), { n: "芦ノ湖スカイライン", h: "motorway" })]);
  assert.ok(measureToll(road, same, { name: "芦ノ湖スカイライン" }).tollMeters > 4500, "名前が同じ高速の有料を数えていない");
  const sameRef = buildTollIndex([way(eastward(139.7, 35.6, 5), { n: "", r: "135;E1", h: "motorway_link" })]);
  assert.ok(measureToll(road, sameRef, { name: "国道135号", ref: "135" }).tollMeters > 4500, "番号が同じ高速の有料を数えていない");
  // 一般道の種類の有料は名前が違っても数える（真鶴道路は「国道135号」の一部）
  const general = buildTollIndex([way(eastward(139.7, 35.6, 5), { n: "真鶴道路", h: "trunk" })]);
  assert.ok(measureToll(road, general, { name: "国道135号" }).tollMeters > 4500);
});

test("有料（8割以上）・一部有料（500m以上）・無料の分け方", () => {
  assert.strictEqual(tollKind({ tollMeters: 8000, totalMeters: 10000 }), "full");
  assert.strictEqual(tollKind({ tollMeters: 7990, totalMeters: 10000 }), "partial");
  assert.strictEqual(tollKind({ tollMeters: 500, totalMeters: 45000 }), "partial", "月山道路（1.05km/45.9km）のような一部");
  assert.strictEqual(tollKind({ tollMeters: 499, totalMeters: 20000 }), null, "入口に触れるだけの道を一部有料にした");
  assert.strictEqual(tollKind({ tollMeters: 0, totalMeters: 0 }), null);
});

test("自動の判定に人の決めた値を上書きし、決めたときは自動の判定も残す", () => {
  const line = eastward(139.0, 35.0, 5);
  const index = buildTollIndex([way(line, { n: "テストスカイライン" })]);
  const base = { name: "テストスカイライン", ref: "", lengthKm: 5, polyline: encode(line) };
  const [auto] = applyToll([base], index);
  assert.strictEqual(auto.toll, "full");
  assert.ok(Math.abs(auto.tollKm - 5) < 0.2);
  assert.deepStrictEqual(auto.tollNames, ["テストスカイライン"]);
  assert.strictEqual(auto.tollAuto, undefined, "人が決めていないのに自動の判定を別に載せた");

  const [none] = applyToll([{ ...base, tollSetting: "none" }], index);
  assert.strictEqual(none.toll, undefined, "人が無料と決めたのに有料のまま");
  assert.strictEqual(none.tollAuto, "full");
  assert.ok(!("tollSetting" in none), "人の値（tollSetting）を配信データに残した");

  const free = { name: "県道", ref: "", lengthKm: 3, polyline: encode(eastward(140, 36, 3)) };
  const [partial] = applyToll([{ ...free, tollSetting: "partial" }], index);
  assert.strictEqual(partial.toll, "partial");
  assert.strictEqual(partial.tollAuto, "none");
  const [full] = applyToll([{ ...free, tollSetting: "full" }], null);
  assert.strictEqual(full.toll, "full", "データが無くても人の値は付ける");
  assert.strictEqual(full.tollKm, 3, "測れないときは道の長さを有料の長さにする");
  const [plain] = applyToll([free], index);
  assert.ok(!("toll" in plain) && !("tollKm" in plain), "無料の道に項目を付けた");
});

test("調整ツールの有料の値は3つだけ通し、生成の最後まで運ぶ（手で足した道も）", () => {
  assert.strictEqual(normalizeOverride({ toll: "full" }).toll, "full");
  assert.strictEqual(normalizeOverride({ toll: "partial" }).toll, "partial");
  assert.strictEqual(normalizeOverride({ toll: "none" }).toll, "none");
  assert.strictEqual(normalizeOverride({ toll: "yes" }).toll, null, "知らない値を通した");
  assert.strictEqual(isEmptyOverride({ toll: "none" }), false, "有料だけ決めた調整を空として消す");
  assert.strictEqual(isEmptyOverride({ toll: null }), true);

  const line = eastward(139.0, 35.0, 5);
  const seg = { name: "道", ref: "", highway: "secondary", score: 50, lengthKm: 5, polyline: encode(line),
                start: [35.0, 139.0], end: [35.0, 139.0553] };
  const out = applyOverrides([seg], { [overrideKey(seg)]: { toll: "none" } }).segments[0];
  assert.strictEqual(out.tollSetting, "none", "人の値を生成の最後まで運んでいない");
  const plain = applyOverrides([seg], {}).segments[0];
  assert.ok(!("tollSetting" in plain));

  assert.strictEqual(normalizeAdded({ name: "足した道", shape: encode(line), toll: "full" }).toll, "full");
  const added = applyOverrides([], {}, { "足した道@35.00,139.00": { name: "足した道", shape: encode(line), toll: "full" } }).segments[0];
  assert.strictEqual(added.tollSetting, "full", "手で足した道に人の値が付かない");
});

test("配信の指紋は有料の道だけ変わる（有料の無い県は配信し直さなくてよい）", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "buildRoadRecommend.js"), "utf8");
  const m = src.match(/function contentHash\(segments\) \{[\s\S]*?\n\}/);
  assert.ok(m, "buildRoadRecommend.js から contentHash を取り出せない");
  const contentHash = new Function("crypto", `${m[0]}; return contentHash;`)(crypto);
  const free = { name: "県道", tags: ["winding"], score: 90, polyline: "abc" };
  const before = contentHash([free]);
  assert.strictEqual(contentHash([{ ...free }]), before);
  assert.strictEqual(before, crypto.createHash("sha1").update(["県道", "", "", "winding", 90, "abc"].join("\u0001")).digest("hex").slice(0, 12),
                     "有料の無い道の指紋が前と変わった（全県を配信し直すことになる）");
  assert.notStrictEqual(contentHash([{ ...free, toll: "full", tollKm: 5 }]), before, "有料を付けても指紋が変わらない（アプリが落とし直さない）");
  assert.notStrictEqual(contentHash([{ ...free, toll: "full", tollKm: 5 }]), contentHash([{ ...free, toll: "partial", tollKm: 5 }]));
});

test("OSM の有料の道は toll=yes だけを入れ、歩道などは入れない", () => {
  const line = { type: "LineString", coordinates: [[139.0, 35.0], [139.01, 35.0]] };
  const yes = tollWayOf({ geometry: line, properties: { toll: "yes", highway: "tertiary", name: "道", ref: "1" } });
  assert.deepStrictEqual({ n: yes.n, r: yes.r, h: yes.h }, { n: "道", r: "1", h: "tertiary" });
  assert.deepStrictEqual(decode(yes.p), [[139.0, 35.0], [139.01, 35.0]], "線の並び（経度・緯度）が変わった");
  assert.strictEqual(tollWayOf({ geometry: line, properties: { toll: "no", highway: "primary" } }), null);
  assert.strictEqual(tollWayOf({ geometry: line, properties: { toll: "bicycle;moped", highway: "primary" } }), null,
                     "自転車・原付だけ有料の道を入れた");
  assert.strictEqual(tollWayOf({ geometry: line, properties: { toll: "yes", highway: "footway" } }), null);
  assert.strictEqual(tollWayOf({ geometry: { type: "Point", coordinates: [139, 35] }, properties: { toll: "yes" } }), null);
});

// ---- 調整ツールの画面（road-builder.html） ----
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const grab = (name) => {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `road-builder.html から ${name} を取り出せない`);
  return m[0];
};

test("画面は人の値をすぐ効かせ、生成で残した自動の判定を見せる", () => {
  const tollOf = new Function(`${grab("tollAutoOf")}; ${grab("tollOf")}; return tollOf;`)();
  const tollAutoOf = new Function(`${grab("tollAutoOf")}; return tollAutoOf;`)();
  assert.strictEqual(tollOf({ toll: "full" }, {}), "full", "自動の判定をそのまま出していない");
  assert.strictEqual(tollOf({ toll: "full" }, { toll: "none" }), null, "人が無料と決めたのに有料と出す");
  assert.strictEqual(tollOf({}, { toll: "partial" }), "partial");
  // 人の値で生成したあと、人の値を消した（自動に戻した）ら、残しておいた自動の判定に戻る
  assert.strictEqual(tollOf({ tollAuto: "full" }, {}), "full", "自動に戻したのに残した判定を使わない");
  assert.strictEqual(tollOf({ toll: "partial", tollAuto: "none" }, {}), null);
  assert.deepStrictEqual(tollAutoOf({ toll: "partial", tollKm: 1, tollAuto: "full", tollAutoKm: 9 }), { kind: "full", km: 9 });
  assert.match(html, /<button class="chip" data-filter="toll"/, "一覧の絞り込みに有料が無い");
  assert.match(grab("apply"), /toll: \(document\.querySelector\("#e-toll \.chip\.on"\) \|\| \{\}\)\.dataset\?\.toll \|\| null,/,
               "編集欄で選んだ有料を調整に入れていない");
});
