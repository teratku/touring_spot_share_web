"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  backtracks, retracedMeters, alongWherePassedDestination, segmentNearest,
  decodeSegmentLine, project, distance,
  MAX_SPATIAL_GAP_METERS, MIN_ALONG_GAP_METERS, MIN_RETRACED_RATIO,
  MIN_TRAVEL_AFTER_METERS, BLAME_WITHIN_METERS,
} = require("../lib/navGeometry");

/**
 * 経路の形から「余計に走らされる形」を見つけるところ。
 *
 * ⚠️ **材料は手で作らない。** 実際に Valhalla が返した経路をそのまま置いてある
 *    （`fixtures-backtrack.json`）。手作りの材料では、壊しても落ちないテストになる
 *    （過去に実際そうなった）。
 *
 *   往復する経路   新座→愛川 南まわり 137km / 7,428点 / **maneuver では Uターン0回**
 *   峠（対照）     甲府→富士吉田 40km / 1,352点（ヘアピンが多い）
 *   周回（対照）   甲府発・甲府着 50km / 1,806点
 */
const FIX = path.join(__dirname, "fixtures-backtrack.json");
const fixtures = fs.existsSync(FIX) ? JSON.parse(fs.readFileSync(FIX, "utf8")) : null;
const skipIfNoFixture = (t) => (fixtures ? false : t.skip("材料が無い環境"));

// MARK: 往復を見つける

test("maneuver では0でも、往復を見つける", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **これがこの仕組みの理由そのもの。** 経路案内は uturn を1件も返していない
  assert.strictEqual(fixtures.retracing.uTurns, 0, "材料が悪い（uTurnが0でない）");
  const found = backtracks(fixtures.retracing.points);
  assert.ok(found.length > 0, "往復している経路で1箇所も見つからない");
  const total = found.reduce((a, b) => a + b.alongGapMeters, 0);
  assert.ok(total > 50_000,
    `往復が ${(total / 1000).toFixed(1)}km しか見つからない（実測66.7km）`);
});

test("峠のヘアピンを往復と間違えない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **判別の本質は離隔。** 本物の折り返しは同じ中心線を戻る（0.0m/4.7m）が、
  //    ヘアピンは曲がり半径ぶん離れる（22〜25m）
  assert.strictEqual(retracedMeters(fixtures.hairpin.points), 0,
    "ヘアピンの多い峠を往復と判定している");
});

test("周回を往復と間違えない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ 周回は同じ場所へ戻るので、「戻ってくる」だけでは区別できない。
  //    同じ道を二度走っている割合で見る（実測: 往復0.93〜0.99 / 周回0.02）
  const total = retracedMeters(fixtures.loop.points);
  assert.ok(total / fixtures.loop.lengthMeters < MIN_RETRACED_RATIO,
    `周回を往復と判定している（${(total / 1000).toFixed(1)}km / `
    + `${(fixtures.loop.lengthMeters / 1000).toFixed(1)}km）`);
});

test("離隔の値がアプリと揃っている", () => {
  // ⚠️ **この値はアプリ側の実測で決まっている**（本物のUターン0.0/4.7m、
  //    ヘアピン22〜25m）。管理ツール側で勝手に変えると、
  //    アプリと違う判定になり、どちらが正しいか分からなくなる。
  //
  // ⚠️ **こちらの材料ではヘアピンの誤検出を再現できていない。**
  //    甲府→富士吉田の峠は離隔40mまで広げても往復0kmだった。
  //    つまり「25にすると拾う」を**このテストでは証明できていない**。
  //    値を変えるなら、先に再現する材料を用意すること。
  assert.strictEqual(MAX_SPATIAL_GAP_METERS, 8);
  assert.strictEqual(MIN_ALONG_GAP_METERS, 200);
  assert.strictEqual(MIN_RETRACED_RATIO, 0.5);
});

test("折り返しの先端は、往復のちょうど中間にある", (t) => {
  if (skipIfNoFixture(t)) return;
  const found = backtracks(fixtures.retracing.points);
  const pts = fixtures.retracing.points;
  for (const b of found) {
    // 先端は入口から「往復の半分」ぶん進んだところ
    const projLoc = project(b.location, pts);
    const projApex = project(b.apex, pts);
    const half = b.alongGapMeters / 2;
    const gap = Math.abs((projApex.along - projLoc.along) - half);
    assert.ok(gap < b.alongGapMeters * 0.1,
      `先端が中間から ${Math.round(gap)}m ずれている（往復 ${Math.round(b.alongGapMeters)}m）`);
  }
});

test("速い（格子に配っている）", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ 総当たりは実測2,062ms。案ごとに毎回かけるので重すぎる
  const began = Date.now();
  backtracks(fixtures.retracing.points);
  const took = Date.now() - began;
  assert.ok(took < 500,
    `7,428点に ${took}ms かかっている（格子に配っていないのでは）`);
});

test("点が少なくても落ちない", () => {
  assert.deepStrictEqual(backtracks([]), []);
  assert.deepStrictEqual(backtracks([[139, 35]]), []);
  assert.strictEqual(retracedMeters(null), 0);
});

// MARK: 原因の区間を突き止める

test("折り返しの先端から原因の道が分かる", (t) => {
  if (skipIfNoFixture(t)) return;
  const found = backtracks(fixtures.retracing.points);
  const segs = fixtures.retracing.segments;
  let hit = 0;
  for (const b of found) {
    if (segmentNearest(b.apex, segs)) hit++;
  }
  assert.strictEqual(hit, found.length,
    `${found.length}箇所のうち ${hit}箇所しか原因が分からない`);
});

test("入口（location）では原因が分からない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **これが「先端を使う」理由。** 入口は往復が始まる交差点で、
  //    原因の区間からは遠く離れうる（アプリ側の実測: 1,416m）
  const found = backtracks(fixtures.retracing.points);
  const segs = fixtures.retracing.segments;
  const byApex = found.filter((b) => segmentNearest(b.apex, segs)).length;
  const byLocation = found.filter((b) => segmentNearest(b.location, segs)).length;
  assert.ok(byApex >= byLocation,
    `入口の方が当たっている（先端${byApex} / 入口${byLocation}）。先端を使う理由が崩れている`);
});

test("道の線で測る（端点だけでは当たらない）", (t) => {
  if (skipIfNoFixture(t) || !fixtures.longSegment) return;
  // ⚠️ **実測の実例。** 道志みち（山梨県:61・36.7km）の折り返しの先端まで、
  //    **線までなら127m、端点だと8,593m**。端点で測っていたため原因を特定できず、
  //    66.7km の往復がそのまま残っていた。
  //    ⚠️ 材料は「線でしか上限に届かない」ものを選んである
  //       （端点でも届く材料だと、端点で測る実装でも通ってしまう）。
  const { apex, seg, onLineMeters, endOnlyMeters } = fixtures.longSegment;
  const line = decodeSegmentLine(seg);
  assert.ok(line && line.length > 2, "区間の線が解けていない");

  const onLine = project(apex, line).lateralDistance;
  const endOnly = Math.min(distance(apex, [seg.start[1], seg.start[0]]),
                           distance(apex, [seg.end[1], seg.end[0]]));
  assert.ok(Math.abs(onLine - onLineMeters) < 5,
    `線までの距離が変わっている（${Math.round(onLine)}m / 材料は${onLineMeters}m）`);
  assert.ok(endOnly > onLine * 10,
    `材料が悪い（線${Math.round(onLine)}m・端点${Math.round(endOnly)}m。`
    + "端点の方がずっと遠い材料であること)");

  // ⚠️ **線で測るからこそ原因として拾える。**
  assert.ok(segmentNearest(apex, [seg]), "線で測っても原因として拾えていない");
  // ⚠️ **端点だけでは上限に届かないこと。** ここが材料の要点
  assert.ok(endOnly > BLAME_WITHIN_METERS,
    `端点まで ${Math.round(endOnly)}m が上限 ${BLAME_WITHIN_METERS}m 以内。`
    + "この材料では「線で測る」を守れていない（もっと長い区間を選ぶこと）");
});

test("遠すぎる道は原因にしない", () => {
  // ⚠️ 当てずっぽうにしない。実測で次に近い区間は最小4,075m
  const apex = [139.0, 35.5];
  const far = { id: "far", name: "遠い道",
                start: [36.5, 140.5], end: [36.6, 140.6] };
  assert.strictEqual(segmentNearest(apex, [far]), null,
    `${BLAME_WITHIN_METERS}m より遠い道を原因にしている`);
});

// MARK: ゴールの回り込み

test("ゴールを通り過ぎて戻る形を見つける", (t) => {
  if (skipIfNoFixture(t)) return;
  // 素直な峠道では出ないこと（実測: 素直な経路は最後の2.1〜2.3kmだけ）
  const pts = fixtures.hairpin.points;
  const goal = pts[pts.length - 1];
  assert.strictEqual(alongWherePassedDestination(pts, goal), null,
    "素直な経路を「回り込み」と判定している");
});

test("ゴールの近くを通っても、すぐ着くなら回り込みではない", () => {
  // ゴールの1km手前を通ってから2km走って着く（＝最後の詰め）
  const goal = [139.0, 35.5];
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([139.0 + 0.0005 * (40 - i), 35.5 + 0.0005 * (40 - i)]);
  const along = alongWherePassedDestination(pts, goal);
  assert.strictEqual(along, null,
    `${MIN_TRAVEL_AFTER_METERS}m 未満なのに回り込みと判定している`);
});

test("往復では捕まらない形（行きと帰りが別の道）を捕まえる", () => {
  // ⚠️ **`backtracks` では捕まらない。** 同じ道を二度走らないため。
  //    ゴールの近くを通ってから、大きく回って戻る形を手で作る
  const goal = [139.0, 35.5];
  const pts = [];
  // ゴールのすぐ近くを通る
  for (let i = 0; i <= 10; i++) pts.push([139.0 + 0.001 * (10 - i), 35.5]);
  // そこから東へ大きく回り込んで戻る（往路と別の緯度を通るので往復にならない）
  for (let i = 1; i <= 60; i++) pts.push([139.0 + 0.0015 * i, 35.51]);
  for (let i = 60; i >= 0; i--) pts.push([139.0 + 0.0015 * i, 35.52]);
  pts.push(goal);

  assert.strictEqual(retracedMeters(pts), 0, "材料が悪い（往復として捕まっている）");
  const along = alongWherePassedDestination(pts, goal);
  assert.ok(along !== null, "ゴールの回り込みを見つけられない");
});

// MARK: 経路案内が言うUターン（幾何では拾えないもの）

test("中央分離帯のある道のUターンは、幾何では拾えない", (t) => {
  if (skipIfNoFixture(t) || !fixtures.dividedUTurn) return;
  // ⚠️ **これが「maneuver も見る」理由そのもの。**
  //    市電通り（川崎）は中央分離帯があり、行きと帰りが8〜16m離れる。
  //    離隔8m以内の点が1,328m中2点しかなく、二重走行の割合が0.5に届かない。
  //    ⚠️ 上限を25mに上げて解決してはいけない（ヘアピンを誤検出する）
  const f = fixtures.dividedUTurn;
  assert.strictEqual(f.uTurns, 1, "材料が悪い（経路案内がUターンと言っていない）");
  assert.strictEqual(backtracks(f.points).length, 0,
    "幾何で拾えてしまっている（材料が「幾何では拾えない」を示せていない）");
});

test("離隔を上げれば拾えるが、それは根拠のある値を崩すこと", (t) => {
  if (skipIfNoFixture(t) || !fixtures.dividedUTurn) return;
  // 25mなら中央分離帯のUターンも幾何で拾える。**だが上げてはいけない。**
  assert.ok(backtracks(fixtures.dividedUTurn.points, { maxSpatialGap: 25 }).length > 0,
    "25mでも拾えない（材料が悪い）");

  // ⚠️ **ここは正直に書いておく。** 「25mにするとヘアピンを誤検出する」は
  //    アプリ側の実測（ヘアピンの離隔22〜25m）に基づく話で、
  //    **こちらの材料では再現できていない**（甲府→富士吉田の峠は40mでも0km）。
  //    つまりこのテストは「25mが駄目」を証明していない。
  //    値を動かすなら、先に誤検出を再現する材料を用意すること。
  //    いまは値を動かさず、**経路案内の maneuver を併用して**解決している
  //    （lib/funRouteRefine.js を読むこと）。
  assert.strictEqual(retracedMeters(fixtures.hairpin.points, { maxSpatialGap: 25 }), 0,
    "峠の誤検出をこの材料で再現できるようになった。"
    + "できたなら「25mにできない理由」をここで示すこと");
});
