"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const PA = require("../../public/plan-add-lib.js");
const SP = require("../../public/spot-points.js");
const R = require("../../public/roads-lib.js");

/**
 * Web のプラン画面の「＋ 追加」（利用者の要望 2026-10-16: アプリと同じようにスポット/おすすめ道路を足す・
 * Web だけ Google マップのように検索/地図のクリックで足す）。アプリの Location.spotDisplayName・SpotSearch・TouringSpot.toDict と同じ決めごと
 */
const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "touring-plan.html"), "utf8");

test("スポットの見出しはアプリと同じ順（名前 → 本文の1行目 → 住所 → 札 → 名前のないスポット）", () => {
  assert.strictEqual(PA.displayName({ location_name: " 大観山 ", comment: "x" }), "大観山");
  assert.strictEqual(PA.displayName({ location_name: "", comment: "\n" }), "名前のないスポット");
  assert.strictEqual(PA.displayName({ comment: "朝の富士山がきれい\n2行目" }), "朝の富士山がきれい");
  assert.strictEqual(PA.displayName({ comment: "あ".repeat(50) }).length, 40, "本文を40字で切っていない");
  assert.strictEqual(PA.displayName({ administrative: "神奈川県", locality: "箱根町" }), "神奈川県 箱根町");
  assert.strictEqual(PA.displayName({ tag: ["", "絶景", "峠", "富士山"] }), "絶景・峠");
});

test("imagedownload の1件を一覧の1件にし、プランにはスポットとして入れる（spotId を持つ・カスタムピンでない）", () => {
  const s = PA.spotFromDoc("doc1", { location_name: "大観山", lat: "35.2", lng: 139.07, administrative: "神奈川県",
                                    locationImageURLs: ["", "https://x/a.jpg"], points: ["scenic"], tag: ["峠"] });
  assert.strictEqual(s.spotId, "doc1"); assert.strictEqual(s.lat, 35.2); assert.strictEqual(s.imageUrl, "https://x/a.jpg");
  assert.strictEqual(PA.spotFromDoc("bad", { lat: "x", lng: 1 }), null, "座標の読めない投稿を出した");
  assert.strictEqual(PA.spotFromDoc("zero", { lat: 0, lng: 0 }), null);
  assert.deepStrictEqual(PA.planSpotOf(s, 2), { spotId: "doc1", name: "大観山", lat: 35.2, lng: 139.07, isCustomPin: false, order: 2,
                                                address: "神奈川県", imageUrl: "https://x/a.jpg" });
  assert.strictEqual(PA.isSpotInPlan([{ spotId: "doc1" }], "doc1"), true);
  assert.strictEqual(PA.isSpotInPlan([{ name: "pin" }], "doc1"), false);
});

test("検索とおすすめポイントで絞り、基準の場所から近い順（spot-points.js と同じ探し方）", () => {
  const spots = [
    PA.spotFromDoc("far", { location_name: "遠い峠", lat: 36.0, lng: 139.0, points: ["winding"] }),
    PA.spotFromDoc("near", { location_name: "近いカフェ", lat: 35.01, lng: 139.0, points: ["cafe"], comment: "峠の手前" }),
    PA.spotFromDoc("mid", { location_name: "中くらいの峠", lat: 35.3, lng: 139.0, points: ["winding", "scenic"] }),
  ];
  const c = { lat: 35.0, lng: 139.0 };
  assert.deepStrictEqual(PA.filteredSpots(spots, "", [], c, SP).map((s) => s.spotId), ["near", "mid", "far"], "近い順でない");
  assert.deepStrictEqual(PA.filteredSpots(spots, "峠", [], c, SP).map((s) => s.spotId), ["near", "mid", "far"], "本文の言葉で探していない");
  assert.deepStrictEqual(PA.filteredSpots(spots, "", ["winding"], c, SP).map((s) => s.spotId), ["mid", "far"]);
  assert.deepStrictEqual(PA.filteredSpots(spots, "", ["cafe", "scenic"], c, SP).map((s) => s.spotId), ["near", "mid"], "複数選んだら「どれか」");
  assert.deepStrictEqual(PA.filteredSpots(spots, "", [], null, SP).map((s) => s.spotId), ["far", "near", "mid"], "基準が無いのに並べ替えた");
});

test("地図には見えている範囲のスポットだけを真ん中から近い順に上限まで", () => {
  const spots = [0, 1, 2, 3].map((i) => ({ spotId: "s" + i, lat: 35.0 + i * 0.1, lng: 139.0 }));
  const b = { south: 34.95, north: 35.25, west: 138.9, east: 139.1 };
  assert.deepStrictEqual(PA.spotsInBounds(spots, b).map((s) => s.spotId).sort(), ["s0", "s1", "s2"], "範囲の外を描いた");
  assert.deepStrictEqual(PA.spotsInBounds(spots, b, 1).map((s) => s.spotId), ["s1"], "上限で真ん中から近い順に残していない");
  assert.deepStrictEqual(PA.spotsInBounds(spots, null), []);
});

test("探す基準はプランの最後の場所、無ければ渡された場所。足すときは最後に足して order を振り直す", () => {
  const plan = [{ name: "B", lat: 35.5, lng: 139.5, order: 1 }, { name: "A", lat: 35.1, lng: 139.1, order: 0 }];
  assert.deepStrictEqual(PA.centerOf(plan, null), { lat: 35.5, lng: 139.5 }, "最後の場所でない");
  assert.deepStrictEqual(PA.centerOf([], { lat: 1, lng: 2 }), { lat: 1, lng: 2 });
  assert.deepStrictEqual(PA.appended(plan, { name: "C" }).map((s) => s.name + s.order), ["A0", "B1", "C2"]);
  assert.strictEqual(PA.canAdd([1, 2], 3), true);
  assert.strictEqual(PA.canAdd([1, 2, 3], 3), false, "上限を超えて入れた");
  assert.strictEqual(PA.distanceLabel({ lat: 35, lng: 139 }, { lat: 35.001, lng: 139 }), "111m");
  assert.strictEqual(PA.distanceLabel({ lat: 35, lng: 139 }, { lat: 35.5, lng: 139 }), "56km");
});

test("道タブはおすすめ道路のページと同じ（範囲の道・点数順・無料は上位3本・地図も同じ）", () => {
  const { encode } = require("../../admin/lib/polyline");
  const seg = (id, lat, score) => ({ id: "神奈川県:" + id, name: "道" + id, ref: "", highway: "secondary", lengthKm: 5, curviness: 300, flow: 30,
    turnCount: 10, score, polyline: encode([[139.0, lat], [139.02, lat]]), start: [lat, 139.0], end: [lat, 139.02] });
  const segments = [1, 2, 3, 4, 5].map((i) => seg(i, 35.0 + i * 0.01, 50 + i));
  const free = PA.roadChoices(segments, { lat: 35.0, lng: 139.0 }, 50, false, R);
  assert.deepStrictEqual(free.visible.map((r) => r.name), ["道5", "道4", "道3"], "無料の上位3本・点数順でない");
  assert.strictEqual(free.locked, 2);
  assert.deepStrictEqual(free.onMap.map((r) => r.name), ["道5", "道4", "道3"], "無料の地図に上位より多く描いた");
  const plus = PA.roadChoices(segments, { lat: 35.0, lng: 139.0 }, 50, true, R);
  assert.strictEqual(plus.visible.length, 5); assert.strictEqual(plus.locked, 0);
  assert.strictEqual(PA.roadChoices(segments, { lat: 40.0, lng: 140.0 }, 30, true, R).visible.length, 0, "範囲の外の道を出した");
});

test("プラン画面は「＋ 追加」から3つのタブで足し、サブスクの上限で止め、地図・検索で場所をカスタムピンにする", () => {
  for (const src of ["/roads-lib.js?v=", "/spot-points.js?v=", "/plan-add-lib.js?v=", "/place-search-lib.js?v=", "/conquest/prefecture-data.js"]) {
    assert.ok(html.includes('<script src="' + src), "部品を読み込んでいない: " + src);
  }
  assert.match(html, /@click\.stop="openAdd\(plan\)">＋ 追加<\/button>/, "プランに「＋ 追加」が無い");
  assert.match(html, /key: 'spots'.*key: 'map'.*key: 'roads'/, "スポット・地図と検索・道のタブが無い");
  assert.match(html, /if \(!PA\.canAdd\(plan\.spots, spotLimit\.value\)\)/, "上限を見ずに足している");
  assert.match(html, /return addItem\(PA\.planSpotOf\(sp\), sp\.name\);/, "スポットを spotId つきで入れていない");
  assert.match(html, /addItem\(PS\.placeSpot\(sp\), sp\.name\);/, "検索・地図で選んだ場所をカスタムピンで入れていない");
  assert.match(html, /if \(ev\.placeId\) \{ ev\.stop\(\); pickPoi\(ev\.placeId, ev\.latLng\); \}\n\s+else pickPoint\(ev\.latLng\);/,
    "地図のクリック（お店・施設／何もない所）で場所を選べない");
  assert.match(html, /const c = PS\.parseCoordinate\(text\);\n\s+if \(c\) return \[PS\.coordinateCandidate\(c\)\];/, "座標を通信せずに読んでいない");
  assert.match(html, /getPlacePredictions\(req\)/, "場所の候補を探していない");
  assert.match(html, /const spot = RL\.planRoadSpot\(r, roadGoalAtEnd\.value, addPlan\.value\.spots\.length\);/, "道を選んだ向きで入れていない");
  assert.match(html, /if \(roadInPlan\(r\)\) return setAddMsg/, "同じ道を二重に入れる");
  assert.match(html, /roadChoices\.value = PA\.roadChoices\(segments, c, roadRadius\.value, isSubscribed\.value, RL\);/, "無料の上限を見ていない");
  assert.match(html, /if \(allSpots\.value\.length \|\| spotsLoading\.value\) return;/, "開くたびにスポットを全件読む");
});

test("地図・検索のスポットの印はまとめて出す（動作が重たい。利用者の要望 2026-10-16）", () => {
  assert.match(html, /<script defer src="https:\/\/unpkg\.com\/@googlemaps\/markerclusterer@\d+\.\d+\.\d+\/dist\/index\.min\.js"><\/script>/,
    "まとめる部品を版を決めて読んでいない（@latest は中身が勝手に変わる）");
  assert.match(html, /spotClusterer = new MC\.MarkerClusterer\(\{ map: addMap, markers: addMarkers \}\);/, "印をまとめていない");
  assert.match(html, /addMarkers = allSpots\.value\.map\(sp => \(spotMarkerById\[sp\.spotId\] = spotMarker\(sp, null\)\)\);/,
    "まとめるときに全部のスポットを渡していない");
  assert.match(html, /addMap\.addListener\('idle', \(\) => \{ if \(!spotClusterer\) drawSpotMarkers\(\); \}\);/, "動かすたびに印を作り直す（重い）");
  assert.match(html, /if \(m\) m\.setIcon\(spotIcon\(sp\)\);/, "足したスポットを灰色に塗り直していない");
  assert.match(html, /const shown = PA\.spotsInBounds\(/, "まとめる部品が読めないときの描き方が無い");
});

test("地図の印を押したら写真・本文・おすすめポイント・タグ・近くの道・詳細へのリンクを出す（利用者の要望 2026-10-16）", () => {
  const spot = PA.spotFromDoc("doc 1", { location_name: "鋸山", lat: 35.16, lng: 139.84, comment: "地獄のぞきが絶景\n階段が多い",
    locationImageURLs: ["a", "", "b", "c", "d", "e"], points: ["scenic", "unknown", "photo"], tag: ["#絶景", " ", "千葉"],
    road: { name: "国道127号", ref: "127" } });
  const card = PA.spotCard(spot, SP);
  assert.deepStrictEqual(card.images, ["a", "b", "c", "d"], "写真を4枚に収めていない／空を出した");
  assert.deepStrictEqual(card.points.map((p) => p.label), ["景色・絶景", "写真映え"], "おすすめポイントをアプリの順・表示名で出していない（知らない鍵は落とす）");
  assert.deepStrictEqual(card.tags, ["絶景", "千葉"], "タグの # を重ねた／空のタグを出した");
  assert.strictEqual(card.road, "国道127号", "近くの道がスポット詳細と違う");
  assert.strictEqual(card.comment, "地獄のぞきが絶景\n階段が多い");
  assert.strictEqual(card.detailUrl, "/detail.html?id=doc%201");
  // 名前の無い投稿は本文の1行目が見出し。同じ文を二度出さない
  const noName = PA.spotCard(PA.spotFromDoc("x", { lat: 35, lng: 139, comment: "海の見えるカフェ\nランチがおいしい" }), SP);
  assert.strictEqual(noName.comment, "ランチがおいしい", "見出しと同じ本文を二度出した");
  assert.strictEqual(PA.spotCard(PA.spotFromDoc("y", { location_name: "長文", lat: 35, lng: 139, comment: "あ".repeat(300) }), SP).comment,
                     "あ".repeat(PA.MAX_CARD_COMMENT) + "…", "長い本文を切っていない");
  const bare = PA.spotCard(PA.spotFromDoc("z", { location_name: "A", lat: 35, lng: 139 }), SP);
  assert.deepStrictEqual([bare.points, bare.tags, bare.road, bare.comment, bare.images], [[], [], null, "", []]);

  assert.match(html, /const pickedCard = computed\(\(\) => \(mapPicked\.value && mapPicked\.value\.spotId \? PA\.spotCard\(mapPicked\.value, SP\) : null\)\);/,
    "地図で選んだスポットのカードを作っていない");
  for (const part of ["pickedCard.images", "pickedCard.points", "pickedCard.tags", "pickedCard.road", "pickedCard.comment", "pickedCard.detailUrl"]) {
    assert.ok(html.includes('v-if="' + part), "カードに出していない: " + part);
  }
  assert.match(html, /<script src="\/plan-add-lib\.js\?v=([2-9]|\d{2,})"><\/script>/, "部品を変えたのに読み込みの版を上げていない（1年キャッシュ）");
});
