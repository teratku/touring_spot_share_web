"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const R = require("../../public/roads-lib.js");

/**
 * Web のおすすめ道路の一覧（public/roads-lib.js）。アプリの発見タブの「道」と同じ決まり
 * （EnjoyableRoadsGroupingTests・RoadFilter・RoadSort・visibleForTier と同じ例）。
 * 利用者の要望（2026-10-12）:「web にもアプリと同じようにおすすめ道路のリストを表示。サブスクの内容も含む」
 */
const seg = (o) => ({ ref: "", highway: "trunk", lengthKm: 5, curviness: 100, score: 50, polyline: "_p~iF~ps|U_ulLnnqC",
                      start: [o.fromLat || 35.9, 139.0], ...o });

test("同じ路線番号の別名区間はひとつの道にまとめ、見出しは路線番号を含む名前・長さは合算", () => {
  const roads = R.grouped([
    seg({ id: "埼玉県:1", name: "あじさい街道", ref: "299", lengthKm: 4, curviness: 600, score: 60, fromLat: 35.9 }),
    seg({ id: "埼玉県:2", name: "国道299号", ref: "299", lengthKm: 10, curviness: 300, score: 40, fromLat: 36.0 }),
    seg({ id: "埼玉県:3", name: "飯能狭山バイパス", ref: "299", lengthKm: 6, curviness: 100, score: 20, fromLat: 36.1 }),
  ]);
  assert.strictEqual(roads.length, 1, "同じ路線番号の道が別々に並んでいる");
  assert.strictEqual(roads[0].name, "国道299号");
  assert.strictEqual(roads[0].lengthKm, 20);
  assert.strictEqual(roads[0].polylines.length, 3);
  // 曲がりと点数は長さで重み付け（(600*4+300*10+100*6)/20 = 300）
  assert.strictEqual(roads[0].curvinessDegPerKm, 300, "曲がり具合を長さで重み付けしていない");
  assert.strictEqual(roads[0].score, (60 * 4 + 40 * 10 + 20 * 6) / 20);
  assert.strictEqual(roads[0].id, "r:埼玉県|299|trunk", "アプリと同じまとめキーでない（人気順が当たらない）");
  // ⚠️ いちばん長い区間が番号入りの名前でなくても、番号入りの名前を見出しにする
  const longer = R.grouped([seg({ id: "埼玉県:1", name: "あじさい街道", ref: "299", lengthKm: 12 }),
                            seg({ id: "埼玉県:2", name: "国道299号", ref: "299", lengthKm: 4 })]);
  assert.strictEqual(longer[0].name, "国道299号", "見出しに路線番号を含む名前を選んでいない");
});

test("番号が同じでも道路等級・県が違えば別の道。手直しした区間と表示名は別扱い", () => {
  assert.strictEqual(R.grouped([seg({ id: "静岡県:1", name: "甲州街道", ref: "20", highway: "trunk" }),
                                seg({ id: "静岡県:2", name: "熱海箱根峠線", ref: "20", highway: "primary" })]).length, 2);
  assert.strictEqual(R.grouped([seg({ id: "埼玉県:1", name: "三沢坂本線", ref: "361", highway: "secondary" }),
                                seg({ id: "愛知県:1", name: "坂上花沢線", ref: "361", highway: "secondary" })]).length, 2,
                     "県をまたいで別の道を1本にした");
  const adjusted = R.grouped([seg({ id: "埼玉県:1", name: "彩甲斐街道", ref: "140", boost: 20 }),
                              seg({ id: "埼玉県:2", name: "国道140号", ref: "140" })]);
  assert.strictEqual(adjusted.length, 2, "手直しした区間を同じ番号の道にまとめた（点数が薄まる）");
  assert.ok(adjusted.some((r) => r.id === "s:埼玉県:1"));
  assert.strictEqual(R.grouped([seg({ id: "神奈川県:1", name: "湯河原箱根線", title: "椿ライン", ref: "75" })])[0].name, "椿ライン");
  const named = R.grouped([seg({ id: "長野県:1", name: "ビーナスライン", highway: "secondary" }),
                           seg({ id: "長野県:2", name: "ビーナスライン", highway: "secondary" })]);
  assert.strictEqual(named.length, 1, "番号の無い道を名前でまとめていない");
  assert.strictEqual(named[0].id, "n:長野県|ビーナスライン|secondary");
});

test("札と有料をまとめた道に引き継ぐ（全部有料なら有料、一部なら一部有料）", () => {
  const [r] = R.grouped([seg({ id: "神奈川県:47", name: "国道135号", ref: "135", tags: ["winding"], toll: "partial", tollKm: 0.96 }),
                         seg({ id: "神奈川県:48", name: "真鶴道路", ref: "135", tags: ["快走"] })]);
  assert.deepStrictEqual(r.tags.sort(), ["winding", "快走"].sort());
  assert.strictEqual(r.toll, "partial");
  assert.strictEqual(r.tollKm, 0.96);
  const mixed = R.grouped([seg({ id: "静岡県:1", name: "伊豆スカイライン", ref: "", toll: "full", lengthKm: 30 }),
                           seg({ id: "静岡県:2", name: "伊豆スカイライン", ref: "" })]);
  assert.strictEqual(mixed[0].toll, "partial", "一部の区間だけ有料の道を「有料」にした");
  assert.strictEqual(mixed[0].tollKm, 30, "長さの無い有料を区間の長さで数えていない");
  assert.strictEqual(R.grouped([seg({ id: "神奈川県:53", name: "熱海ビーチライン", ref: "", tags: ["toll"], lengthKm: 3.7 })])[0].toll,
                     "full", "古い札「有料道路」を有料にしていない");
  assert.strictEqual(R.tagLabel("快走"), "快走");
  assert.strictEqual(R.tagKey("快走"), "flowing", "古い日本語の札を鍵にしていない");
});

test("無料の人は上位3本、Plus は全部。地図も同じ本数（無料）／範囲の全部（Plus）", () => {
  const roads = Array.from({ length: 8 }, (_, i) => ({ id: "r" + i, score: 100 - i, tags: [], highway: "trunk" }));
  assert.deepStrictEqual(R.visibleForTier(roads, false).map((r) => r.id), ["r0", "r1", "r2"]);
  assert.strictEqual(R.visibleForTier(roads, true).length, 8);
  assert.strictEqual(R.FREE_VISIBLE_COUNT, 3);
  assert.deepStrictEqual(R.mapRoads(roads, roads.slice(0, 3), { tags: [], kinds: [] }, false).length, 3,
                         "無料の人の地図に一覧より多く描いた");
  assert.strictEqual(R.mapRoads(roads, roads.slice(0, 3), { tags: [], kinds: [] }, true).length, 8);
});

test("絞り込みは範囲の道全部から絞ってから上位を取る（同じ種類はどれか・種類どうしはかつ）", () => {
  const all = [
    { id: "a", score: 90, tags: [], highway: "trunk" },
    { id: "b", score: 80, tags: ["winding"], highway: "secondary" },
    { id: "c", score: 70, tags: ["絶景"], highway: "trunk" },
    { id: "d", score: 60, tags: ["winding"], highway: "trunk" },
  ];
  const top = R.limited(all, 1);
  const f = { tags: ["winding", "scenic"], kinds: [] };
  assert.deepStrictEqual(R.listRoads(top, all, f, 10).map((r) => r.id), ["b", "c", "d"], "上位に切ってから絞った");
  assert.deepStrictEqual(R.applyFilter(all, { tags: ["winding"], kinds: ["national"] }).map((r) => r.id), ["d"]);
  assert.deepStrictEqual(R.listRoads(top, all, { tags: [], kinds: [] }, 10), top, "絞らないのに一覧を変えた");
  assert.deepStrictEqual(R.limited([{ id: "x", score: 9 }, { id: "y", score: 1, isAdjusted: true }], 1).map((r) => r.id), ["x", "y"],
                         "手を入れた道を順位で切り落とした");
});

test("並べ替えはアプリと同じ（同点は点数 → id、近い順は場所が無ければおすすめ順）", () => {
  const roads = [
    { id: "b", name: "い", score: 50, curvinessDegPerKm: 300, lengthKm: 10, representative: { lat: 36, lng: 139 } },
    { id: "a", name: "あ", score: 50, curvinessDegPerKm: 100, lengthKm: 30, representative: { lat: 35, lng: 139 } },
    { id: "c", name: "う", score: 90, curvinessDegPerKm: 100, lengthKm: 5, representative: { lat: 37, lng: 139 } },
  ];
  const ids = (sort, origin, pop) => R.sortRoads(roads, sort, origin, pop).map((r) => r.id);
  assert.deepStrictEqual(ids("score"), ["c", "a", "b"], "同点の並びが決まっていない");
  assert.deepStrictEqual(ids("curviness"), ["b", "c", "a"]);
  assert.deepStrictEqual(ids("length"), ["a", "b", "c"]);
  assert.deepStrictEqual(ids("distance", { lat: 35.1, lng: 139 }), ["a", "b", "c"]);
  assert.deepStrictEqual(ids("distance", null), ["c", "a", "b"], "場所が無いのに近い順にした");
  assert.deepStrictEqual(ids("name"), ["a", "b", "c"]);
  assert.deepStrictEqual(ids("popular", null, { a: 5, b: 9 }), ["b", "a", "c"]);
  assert.deepStrictEqual(R.popularRoadUsers({ items: [{ key: "r:x", users: 3 }, { key: "r:y", users: 2 }] }), { "r:x": 3 },
                         "3人未満を人気に載せた");
});

test("範囲・本数・曲がりの星はアプリと同じ", () => {
  assert.strictEqual(R.fetchLimit(50, 30), 30);
  assert.strictEqual(R.fetchLimit(R.NATIONWIDE_KM, 30), 120, "全国で本数を増やしていない");
  assert.deepStrictEqual([30, 89, 159, 259, 400].map(R.windingStars), [1, 2, 3, 4, 5]);
  const segs = [seg({ id: "x:1", name: "近い", start: [35.0, 139.0] }), seg({ id: "x:2", name: "遠い", start: [36.0, 139.0] })];
  assert.deepStrictEqual(R.withinRadius(segs, { lat: 35.05, lng: 139.0 }, 30).map((s) => s.name), ["近い"]);
  assert.deepStrictEqual(R.prefecturesWithin({ lat: 35.68, lng: 139.77 }, 10,
    [{ name: "東京都", bounds: { latMin: 35.5, latMax: 35.9, lngMin: 138.9, lngMax: 139.9 } },
     { name: "大阪府", bounds: { latMin: 34.2, latMax: 35.1, lngMin: 135.1, lngMax: 135.7 } }]), ["東京都"]);
});

test("画面は無料の人に上位3本と「Plusで残り○件」、Plus の人に全部を出し、メニューから開ける", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "roads.html"), "utf8");
  assert.match(html, /function visible\(\) \{ return R\.visibleForTier\(listed\(\), state\.unlimited\); \}/, "無料の人の本数を絞っていない");
  assert.match(html, /function onMap\(\) \{ return R\.mapRoads\(state\.all, visible\(\), state\.filter, state\.unlimited\); \}/);
  assert.match(html, /TSSSubscription\.onReady\(function \(s\) \{\n      state\.unlimited = !!s\.isSubscribed;/, "サブスクの状態を見ていない");
  assert.match(html, /if \(state\.unlimited \|\| n <= 0\) \{ box\.innerHTML = ""; return; \}/, "Plus の人に案内を出している");
  assert.match(html, /Plusで残り' \+ n \+ "件を見る/);
  const menu = fs.readFileSync(path.join(__dirname, "..", "..", "public", "menu.js"), "utf8");
  assert.match(menu, /label: 'おすすめ道路', href: '\/roads\.html'/, "メニューから開けない");
  for (const f of fs.readdirSync(path.join(__dirname, "..", "..", "public")).filter((f) => f.endsWith(".html"))) {
    const page = fs.readFileSync(path.join(__dirname, "..", "..", "public", f), "utf8");
    assert.doesNotMatch(page, /menu\.js\?v=6/, `${f} が古い menu.js を読む（1年キャッシュされるので新しい項目が出ない）`);
  }
});

// ---- プランに追加（アプリの RoadEndpoints・TouringSpot と同じ。利用者の要望 2026-10-12） ----
const line = (pts) => pts.map(([lat, lng]) => ({ lat, lng }));

test("ばらばらの区間を道なりにつなぎ、環状なら半分で切る（RoadEndpoints.traversal と同じ）", () => {
  // 南北に並ぶ3つの断片を、順番と向きをばらばらに渡す
  const a = line([[35.00, 139.0], [35.01, 139.0]]), b = line([[35.03, 139.0], [35.02, 139.0]]), c = line([[35.03, 139.0], [35.05, 139.0]]);
  const t = R.traversal([a, b, c]);
  assert.strictEqual(t.isLoop, false);
  const lats = t.path.map((p) => p.lat);
  assert.ok(lats.every((v, i) => i === 0 || v >= lats[i - 1]) || lats.every((v, i) => i === 0 || v <= lats[i - 1]),
            "道筋が行ったり来たりしている: " + lats.join(","));
  assert.ok(Math.abs(t.lengthMeters - 5560) < 200, `全長 ${t.lengthMeters}`);
  const loop = R.traversal([line([[35.0, 139.0], [35.01, 139.0], [35.01, 139.01], [35.0, 139.01], [35.0, 139.0005]])]);
  assert.strictEqual(loop.isLoop, true, "両端が近い道を環状とみなしていない");
  assert.ok(loop.path.length < 5);
  assert.strictEqual(R.traversal([]), null);
});

test("経由地は2kmおき・途中8点まで（RoadEndpoints.waypoints）、端の呼び名は道の真ん中から見た方角", () => {
  const path = line(Array.from({ length: 101 }, (_, i) => [35 + i * 0.001, 139]));   // 約11.1km 北向き
  const w = R.waypointsAlong(path);
  assert.strictEqual(w.length, 2 + 5, "途中の点の数がアプリと違う（ceil(11.1/2)-1=5）");
  assert.deepStrictEqual(w[0], path[0]);
  assert.deepStrictEqual(w[w.length - 1], path[path.length - 1]);
  const long = line(Array.from({ length: 1001 }, (_, i) => [35 + i * 0.001, 139]));   // 約111km
  assert.strictEqual(R.waypointsAlong(long).length, 10, "途中8点の上限を超えた");
  assert.strictEqual(R.waypointsAlong(line([[35, 139], [35.005, 139]])).length, 2, "短い道に途中の点を挟んだ");
  assert.strictEqual(R.endLabel(path[path.length - 1], path), "北の端");
  assert.strictEqual(R.endLabel(path[0], path), "南の端");
});

test("プランに入れる形はアプリと同じ（道全体・選んだ向き・lat/lng はゴール・道のIDを残す）。二重と上限も同じ", () => {
  const { encode } = require("../../admin/lib/polyline");
  const road = { id: "n:神奈川県|芦ノ湖スカイライン|tertiary", name: "芦ノ湖スカイライン",
                 polylines: [encode(Array.from({ length: 51 }, (_, i) => [139.0, 35 + i * 0.001]))] };
  const forward = R.planRoadSpot(road, true, 2);
  assert.deepStrictEqual({ isRoad: forward.isRoad, isCustomPin: forward.isCustomPin, order: forward.order, roadId: forward.roadId },
                         { isRoad: true, isCustomPin: true, order: 2, roadId: road.id });
  assert.ok(forward.path[0].lat < forward.path[forward.path.length - 1].lat, "選んだ向きで通り道を並べていない");
  assert.deepStrictEqual({ lat: forward.lat, lng: forward.lng }, forward.path[forward.path.length - 1], "lat/lng がゴールでない");
  const backward = R.planRoadSpot(road, false, 0);
  assert.ok(backward.path[0].lat > backward.path[backward.path.length - 1].lat, "逆向きを選んでも向きが変わらない");
  assert.ok(forward.path.every((p) => Object.keys(p).join() === "lat,lng"), "通り道を {lat, lng} で保存していない（入れ子の配列は書けない）");
  const ends = [forward.path[0], forward.path[forward.path.length - 1]];
  assert.ok(R.isSameRoadInPlan({ isRoad: true, roadId: road.id, name: "x", path: [] }, road, ends), "同じIDの道を別の道とした");
  assert.ok(R.isSameRoadInPlan({ isRoad: true, name: road.name, path: backward.path }, road, ends), "逆向きに入れた同じ道を見逃した");
  assert.ok(!R.isSameRoadInPlan({ isRoad: true, name: "別の道", path: forward.path }, road, ends));
  assert.ok(!R.isSameRoadInPlan({ name: road.name, lat: 35, lng: 139 }, road, ends), "スポットを道とした");
  assert.ok(!R.isSameRoadInPlan({ name: road.name, path: forward.path }, road, ends), "道の印の無いものを道とした");
  assert.deepStrictEqual([R.spotsPerPlan(false), R.spotsPerPlan(true)], [3, 10]);
});

test("画面: 選んだ道を先頭に出し、場所からの距離と分かるように書き、寄っても道を消さず、プランに追加する", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "roads.html"), "utf8");
  assert.match(html, /if \(sel\.length\) items = sel\.concat\(items\.filter\(function \(r\) \{ return r\.id !== state\.selectedId; \}\)\);/,
               "選んだ道を一覧の先頭に出していない");
  assert.match(html, /if \(!sel\.length && state\.selectedId\) sel = onMap\(\)\.filter\(function \(r\) \{ return r\.id === state\.selectedId; \}\);/,
               "一覧の上位に無い道を地図で選ぶと先頭に出ない");
  assert.match(html, /\(i == null \? "–" : i \+ 1\)/, "一覧に無い道に順位を付けた");
  assert.match(html, /"ここから" \+ \(R\.distance\(state\.center, r\.representative\) \/ 1000\)/, "距離が道の長さと紛らわしい");
  assert.match(html, /if \(b\) roads = roads\.filter\(function \(r\) \{ return b\.intersects\(boxOf\(r\)\); \}\);/,
               "始点が画面の外に出ると道が消える");
  assert.match(html, /var spot = R\.planRoadSpot\(road, state\.add\.goalAtEnd, plan\.spots\.length\);/);
  assert.match(html, /if \(plan\.spots\.length >= limit\) \{/, "プランの上限を見ていない");
  assert.match(html, /R\.isSameRoadInPlan\(sp, road, \[t\.path\[0\], t\.path\[t\.path\.length - 1\]\]\)/, "同じ道を二重に入れる");
  assert.match(html, /\.update\(\{ spots: spots, updatedAt: firebase\.firestore\.FieldValue\.serverTimestamp\(\) \}\);/);
  assert.match(html, /loadPlans\(\)\.then\(render\);/, "ログインしたときにプランを読んでいない");
  assert.match(html, /\/roads-lib\.js\?v=2/, "部品を変えたのに読み込みの版を上げていない");
});
