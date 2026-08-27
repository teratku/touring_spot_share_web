"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { blame, dropBacktrackingRoads, MAX_RETRIES, MAX_ELAPSED_MS,
        ARRIVAL_UTURN_METERS } = require("../lib/funRouteRefine");
const FIXB = require("path").join(__dirname, "fixtures-backtrack.json");
const fixB = require("fs").existsSync(FIXB) ? JSON.parse(require("fs").readFileSync(FIXB, "utf8")) : null;

/**
 * 引いた経路を見て、余計に走らせている道を外すところ。
 *
 * ⚠️ **書き直してある。** 以前は「Valhalla が返す maneuver の Uターン数」を
 *    前提に、作り物の経路で外し方だけを試していた。
 *    しかし**経由地を through にすると uturn の maneuver が1件も返らない**ため、
 *    その前提そのものが成り立たなかった（実測: 137km の経路で往復66.7km・
 *    maneuver では0回）。いまは経路の形から幾何的に見る（`lib/navGeometry.js`）。
 *
 * ⚠️ **材料は実際の経路。** 手作りの経路では往復を再現できない。
 */
const FIX = path.join(__dirname, "fixtures-backtrack.json");
const fixtures = fs.existsSync(FIX) ? JSON.parse(fs.readFileSync(FIX, "utf8")) : null;
const skipIfNoFixture = (t) => (fixtures ? false : t.skip("材料が無い環境"));

// MARK: 原因を突き止める

test("往復している経路から、原因の道が分かる", (t) => {
  if (skipIfNoFixture(t)) return;
  const route = { points: fixtures.retracing.points, uTurns: fixtures.retracing.uTurns };
  const info = blame(route, fixtures.retracing.segments, fixtures.retracing.to);
  assert.ok(info.retracedMeters > 50_000,
    `往復が ${(info.retracedMeters / 1000).toFixed(1)}km しか見えていない（実測66.7km）`);
  assert.ok(info.forever.length > 0, "原因の道が1本も挙がらない");
});

test("往復の原因は「覚える」側に入る", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **往復は道路網そのものの性質。** 行き先が変わっても同じところで往復するので
  //    覚えてよい。ゴールの回り込みは今回の行き先次第なので覚えてはいけない
  const route = { points: fixtures.retracing.points, uTurns: 0 };
  const info = blame(route, fixtures.retracing.segments, fixtures.retracing.to);
  assert.ok(info.forever.length > 0, "覚える側に入っていない");
  for (const s of info.forever) {
    assert.ok(!info.once.some((o) => o.id === s.id),
      `${s.name} が両方に入っている`);
  }
});

test("往復していなければ、何も挙げない", (t) => {
  if (skipIfNoFixture(t)) return;
  const pts = fixtures.hairpin.points;
  const route = { points: pts, uTurns: 0 };
  const info = blame(route, fixtures.retracing.segments, pts[pts.length - 1]);
  assert.strictEqual(info.retracedMeters, 0);
  assert.deepStrictEqual(info.forever, []);
  assert.deepStrictEqual(info.once, []);
});

test("経路が無くても落ちない", () => {
  for (const bad of [null, { error: "だめ" }, { points: [] }, { points: [[139, 35]] }]) {
    const info = blame(bad, [], [139, 35]);
    assert.strictEqual(info.retracedMeters, 0);
    assert.deepStrictEqual(info.forever, []);
  }
});

// MARK: 外して組み立て直す

/** 作り物: `badIds` の道が入っていたら往復する経路を返す */
function fakeWorld(badIds) {
  const straight = [];
  for (let i = 0; i <= 200; i++) straight.push([139.0 + 0.001 * i, 35.5]);
  // 往復: 同じ線を行って戻る（同じ中心線なので離隔0m）
  const retrace = straight.concat(straight.slice().reverse(), straight);
  return (waypoints) => {
    const ids = (waypoints || []).map((w) => w.__id).filter(Boolean);
    const bad = ids.some((id) => badIds.includes(id));
    return Promise.resolve({ points: bad ? retrace : straight, uTurns: 0, error: null });
  };
}
/**
 * 作り物の区間。
 * ⚠️ **座標を離すこと。** 最初どれも同じ座標にしたため、折り返しの先端から
 *    見て全部が「原因」になり、良い道まで外れて道が無くなった。
 *    往復するのは 139.10 のあたりなので、良い道は遠くに置く。
 */
const mkSeg = (id, score, lng = 139.1, lat = 35.5) => ({
  id, name: id, score, lengthKm: 5, curviness: 600,
  start: [lat, lng], end: [lat, lng + 0.01],
});
//: 往復の先端から遠い場所（原因にならない）
const FAR = [138.5, 34.5];
/** 経由地に印を付けて、どの道が入っているか作り物側で分かるようにする */
const viasOf = (segs) => segs.map((s) => Object.assign([139.1, 35.5], { __id: s.id }));

test("原因を外して組み立て直す", async () => {
  const good = mkSeg("良い道", 80, FAR[0], FAR[1]);
  const bad = mkSeg("悪い道", 90);
  const routeFn = fakeWorld(["悪い道"]);
  const rebuild = (banIds) => {
    const left = [good, bad].filter((s) => !banIds.has(s.id));
    return left.length ? { segments: left, waypoints: viasOf(left) } : null;
  };
  const out = await dropBacktrackingRoads(
    { segments: [good, bad], waypoints: viasOf([good, bad]) },
    [139.2, 35.5], rebuild, routeFn);

  assert.ok(out.dropped.some((s) => s.id === "悪い道"), "原因を外していない");
  assert.ok(!out.picked.segments.some((s) => s.id === "悪い道"), "原因が残っている");
  assert.strictEqual(out.retracedMeters, 0, "往復が消えていない");
  assert.ok(out.calls >= 2, `引き直していない（${out.calls}回）`);
});

test("往復が無ければ引き直さない", async () => {
  const s = mkSeg("良い道", 80);
  const routeFn = fakeWorld([]);
  const out = await dropBacktrackingRoads(
    { segments: [s], waypoints: viasOf([s]) },
    [139.2, 35.5], () => null, routeFn);
  assert.strictEqual(out.calls, 1, `${out.calls}回引いている（1回でよい）`);
  assert.deepStrictEqual(out.dropped, []);
});

test("道が無くなったら、そのことを返す", async () => {
  // ⚠️ **黙って往復を残さない。** 楽しい道が1本しかない案では
  //    「外すと何も残らない」ので、そのことを伝える
  const only = mkSeg("唯一の道", 90);
  const routeFn = fakeWorld(["唯一の道"]);
  const out = await dropBacktrackingRoads(
    { segments: [only], waypoints: viasOf([only]) },
    [139.2, 35.5], () => null, routeFn);
  assert.strictEqual(out.ranOut, true, "道が無くなったことを伝えていない");
  assert.ok(out.dropped.some((s) => s.id === "唯一の道"));
});

test("覚えてよい原因だけを bannedForever に返す", async () => {
  const bad = mkSeg("悪い道", 90);
  const good = mkSeg("良い道", 80, FAR[0], FAR[1]);
  const routeFn = fakeWorld(["悪い道"]);
  const rebuild = (banIds) => {
    const left = [good, bad].filter((s) => !banIds.has(s.id));
    return left.length ? { segments: left, waypoints: viasOf(left) } : null;
  };
  const out = await dropBacktrackingRoads(
    { segments: [good, bad], waypoints: viasOf([good, bad]) },
    [139.2, 35.5], rebuild, routeFn);
  assert.ok(out.bannedForever.some((s) => s.id === "悪い道"),
    "往復の原因が「覚える」側に入っていない");
});

test("最初から外してある道は、また外さない", async () => {
  const bad = mkSeg("悪い道", 90);
  const good = mkSeg("良い道", 80, FAR[0], FAR[1]);
  const routeFn = fakeWorld([]);
  const out = await dropBacktrackingRoads(
    { segments: [good], waypoints: viasOf([good]) },
    [139.2, 35.5], () => null, routeFn, { bannedIds: [bad.id] });
  assert.deepStrictEqual(out.dropped, [], "既に外してある道を数え直している");
});

test("回数で打ち切る", async () => {
  // ⚠️ 原因を外しても次の原因が出続ける場合に、無限に引き直さない
  let n = 0;
  const segs = Array.from({ length: 20 }, (_, i) => mkSeg(`道${i}`, 90 - i));
  const routeFn = fakeWorld(segs.map((s) => s.id));   // どれを通しても往復する
  const rebuild = (banIds) => {
    const left = segs.filter((s) => !banIds.has(s.id));
    return left.length ? { segments: left, waypoints: viasOf(left) } : null;
  };
  const out = await dropBacktrackingRoads(
    { segments: segs, waypoints: viasOf(segs) },
    [139.2, 35.5], rebuild, (w) => { n++; return routeFn(w); });
  assert.ok(out.calls <= MAX_RETRIES + 1,
    `${out.calls}回引いている（上限は ${MAX_RETRIES + 1}回）`);
});

test("時間でも打ち切る", async () => {
  // ⚠️ 回数だけだと長距離で「ぐるぐる回ったまま戻らない」ように見える
  const segs = Array.from({ length: 20 }, (_, i) => mkSeg(`道${i}`, 90 - i));
  const slow = async (w) => {
    await new Promise((r) => setTimeout(r, 30));
    return fakeWorld(segs.map((s) => s.id))(w);
  };
  const rebuild = (banIds) => {
    const left = segs.filter((s) => !banIds.has(s.id));
    return left.length ? { segments: left, waypoints: viasOf(left) } : null;
  };
  const began = Date.now();
  const out = await dropBacktrackingRoads(
    { segments: segs, waypoints: viasOf(segs) },
    [139.2, 35.5], rebuild, slow, { maxElapsedMs: 50 });
  assert.ok(Date.now() - began < 1000, "時間で打ち切れていない");
  assert.ok(out.calls < MAX_RETRIES + 1,
    `回数の上限まで引いている（時間で止まっていない）`);
});

// MARK: 覚える／覚えない・重複・ゴール回り込み

/** 作り物: ゴールの近くを通ってから大きく回り込んで戻る経路 */
function goalLoopWorld(badIds, goal) {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push([goal[0] + 0.001 * (10 - i), goal[1]]);
  for (let i = 1; i <= 60; i++) pts.push([goal[0] + 0.0015 * i, goal[1] + 0.01]);
  for (let i = 60; i >= 0; i--) pts.push([goal[0] + 0.0015 * i, goal[1] + 0.02]);
  pts.push(goal);
  const straight = [];
  for (let i = 0; i <= 60; i++) straight.push([goal[0] + 0.001 * (60 - i), goal[1]]);
  return (waypoints) => {
    const ids = (waypoints || []).map((w) => w.__id).filter(Boolean);
    const bad = ids.some((id) => badIds.includes(id));
    return Promise.resolve({ points: bad ? pts : straight, uTurns: 0, error: null });
  };
}

test("ゴールの回り込みも原因として外す", async () => {
  // ⚠️ **往復では捕まらない形。** 行きと帰りが別の道なので同じ道を二度走らない
  const goal = [139.0, 35.5];
  // 回り込みの先（＝ゴールより東）に置いた道が原因になる
  const far = mkSeg("回り込ませる道", 90, goal[0] + 0.08, goal[1] + 0.02);
  const near = mkSeg("ふつうの道", 80, goal[0] - 0.5, goal[1] - 0.5);
  const routeFn = goalLoopWorld(["回り込ませる道"], goal);
  const rebuild = (banIds) => {
    const left = [near, far].filter((s) => !banIds.has(s.id));
    return left.length ? { segments: left, waypoints: viasOf(left) } : null;
  };
  const out = await dropBacktrackingRoads(
    { segments: [near, far], waypoints: viasOf([near, far]) },
    goal, rebuild, routeFn);
  assert.ok(out.dropped.some((s) => s.id === "回り込ませる道"),
    "ゴールの回り込みを起こす道を外していない");
});

test("ゴールの回り込みは「覚えない」側に入る", async () => {
  // ⚠️ **これを覚えると、使うほど楽しい道が減る。**
  //    実機で報告: 所沢→相模原で候補が1本に減った（条件を満たす区間は14本あった）。
  //    往復は道路網の性質なので覚えてよいが、回り込みは今回の行き先次第
  const goal = [139.0, 35.5];
  const far = mkSeg("回り込ませる道", 90, goal[0] + 0.08, goal[1] + 0.02);
  const near = mkSeg("ふつうの道", 80, goal[0] - 0.5, goal[1] - 0.5);
  const routeFn = goalLoopWorld(["回り込ませる道"], goal);
  const rebuild = (banIds) => {
    const left = [near, far].filter((s) => !banIds.has(s.id));
    return left.length ? { segments: left, waypoints: viasOf(left) } : null;
  };
  const out = await dropBacktrackingRoads(
    { segments: [near, far], waypoints: viasOf([near, far]) },
    goal, rebuild, routeFn);

  assert.ok(out.dropped.some((s) => s.id === "回り込ませる道"), "材料が悪い（外れていない）");
  assert.ok(!out.bannedForever.some((s) => s.id === "回り込ませる道"),
    "ゴールの回り込みを「覚える」側に入れている（使うほど道が減る）");
});

test("同じ道を二度数えない", async () => {
  // ⚠️ 同じ原因が続けて出たとき、外した一覧に二度出さない
  const bad = mkSeg("悪い道", 90);
  const routeFn = fakeWorld(["悪い道"]);
  let round = 0;
  const rebuild = (banIds) => {
    round++;
    // わざと、外したはずの道をもう一度入れて返す（呼び出し側の作りが悪い場合）
    return round < 3 ? { segments: [bad], waypoints: viasOf([bad]) } : null;
  };
  const out = await dropBacktrackingRoads(
    { segments: [bad], waypoints: viasOf([bad]) },
    [139.2, 35.5], rebuild, routeFn);
  const ids = out.dropped.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length,
    `外した一覧に同じ道が二度入っている: ${ids.join(",")}`);
});

test("既に覚えている道は、最初に引く前に外す", async () => {
  // ⚠️ **案は一度にまとめて作られる。** そのため、前の案で覚えた道が
  //    この案の初期の顔ぶれにそのまま残っている。最初に引く前に外さないと、
  //    往復が出ても「もう覚えている」として飛ばされ、**呼び出し1回で終わる**。
  //    実測: 高崎→草津 東 往復34.3km 呼出1回／甲府→富士吉田 東 往復38.0km 呼出1回
  const bad = mkSeg("前の案で覚えた道", 90);
  const good = mkSeg("ふつうの道", 80, 139.1, 35.52);
  const routeFn = fakeWorld(["前の案で覚えた道"]);
  let rebuilt = 0;
  const rebuild = (banIds) => {
    rebuilt++;
    const left = [bad, good].filter((s) => !banIds.has(s.id));
    return left.length ? { segments: left, waypoints: viasOf(left) } : null;
  };
  const out = await dropBacktrackingRoads(
    { segments: [bad, good], waypoints: viasOf([bad, good]) },   // ← 覚えた道が入ったまま
    [139.2, 35.5], rebuild, routeFn,
    { bannedIds: new Set(["前の案で覚えた道"]) });

  assert.ok(rebuilt > 0, "覚えている道が入っているのに組み立て直していない");
  assert.strictEqual(out.retracedMeters, 0,
    `往復が ${out.retracedMeters}m 残っている（呼出${out.calls}回）`);
  assert.ok(!out.picked.segments.some((s) => s.id === "前の案で覚えた道"),
    "覚えている道がそのまま経路に残っている");
});

test("楽しい道が尽きたら、楽しい道なしで引き直す", async () => {
  // ⚠️ **直前の経路をそのまま返してはいけない。** 画面には「道0本」と出るのに
  //    往復した線が残る（実測: 札幌→富良野が4案とも道切れで往復1〜34kmを残した）
  const bad = mkSeg("唯一の道", 90);
  const routeFn = fakeWorld(["唯一の道"]);
  const seenVias = [];
  const wrapped = (w) => { seenVias.push((w || []).length); return routeFn(w); };
  const rebuild = () => null;              // もう選べる道が無い
  const out = await dropBacktrackingRoads(
    { segments: [bad], waypoints: viasOf([bad]) },
    [139.2, 35.5], rebuild, wrapped);

  assert.strictEqual(out.ranOut, true, "道切れになっていない（材料が悪い）");
  assert.strictEqual(out.picked.segments.length, 0, "道が残っている");
  assert.strictEqual(seenVias[seenVias.length - 1], 0,
    "楽しい道なしで引き直していない");
  assert.strictEqual(out.retracedMeters, 0,
    `道0本と言いながら往復 ${out.retracedMeters}m の線を返している`);
});

test("組み立て直しの上限が実測を満たしている", () => {
  // ⚠️ 実測（10区間・32案）で必要だった呼び出しは最大9回＝組み立て直し8回。
  //    5回だと東京→箱根 東に31.5kmの往復が残った。下げるなら測り直すこと
  assert.ok(MAX_RETRIES >= 8,
    `上限 ${MAX_RETRIES} 回では実測の最大（8回）に届かない`);
});

// MARK: 経路案内が言うUターン（幾何と補い合う）

test("幾何が拾えないUターンを、経路案内の指示から拾う", (t) => {
  if (!fixB || !fixB.dividedUTurn) return t.skip("材料が無い環境");
  // ⚠️ **実際に Valhalla が返した経路。** 新座→愛川 東・南まわり 95.6km。
  //    市電通り（川崎）は中央分離帯があり行きと帰りが8〜16m離れるため、
  //    `backtracks` は0件。だが経路案内は「右方向、Uターンです」と明示している。
  //    利用者からはこれが「Uターンしている」と報告された
  const f = fixB.dividedUTurn;
  const route = { points: f.points, steps: f.steps, uTurns: f.uTurns };
  const info = blame(route, f.segments, [139.26196, 35.55397]);

  assert.strictEqual(info.retracedMeters, 0, "材料が悪い（幾何で拾えてしまっている）");
  assert.strictEqual(info.uTurnManeuvers, 1, "経路案内のUターンを数えていない");
  assert.ok(info.forever.some((s) => s.name === "市電通り"),
    `Uターンの原因を特定できていない（見つけた: ${info.forever.map((s) => s.name).join("・") || "なし"}）`);
});

test("経路案内のUターンは「覚える」側に入る", (t) => {
  if (!fixB || !fixB.dividedUTurn) return t.skip("材料が無い環境");
  // ⚠️ 行き止まりの道に入らされた結果なので**道路網の性質**。
  //    行き先が変わっても同じところでUターンする
  const f = fixB.dividedUTurn;
  const info = blame({ points: f.points, steps: f.steps }, f.segments, [139.26196, 35.55397]);
  assert.ok(!info.once.some((s) => s.name === "市電通り"),
    "覚えない側に入れている");
});

test("Uターンの原因が通した道でなければ、外さない", () => {
  // ⚠️ **空回りさせない。** 実測: 広島→出雲は出発点が国道2号の反対車線側にあり、
  //    走り出して3つ目の指示でUターンする。通した道は31km以上先で、
  //    どの道を外しても直らない。原因なしと判じて止まること
  const far = mkSeg("遠い道", 85, 132.9, 34.9);
  const route = {
    points: [[132.4553, 34.3853], [132.4556, 34.3844], [132.46, 34.39]],
    steps: [{ maneuver: "start", beginIndex: 0 },
            { maneuver: "uturnRight", beginIndex: 1 }],
  };
  const info = blame(route, [far], [132.6853, 35.3667]);
  assert.strictEqual(info.uTurnManeuvers, 1, "Uターンを数えていない");
  assert.strictEqual(info.forever.length, 0,
    `関係の無い道を原因にしている: ${info.forever.map((s) => s.name).join("・")}`);
});

// MARK: 到着のための切り返し

test("ゴールの目の前のUターンは、道のせいにしない", () => {
  // ⚠️ **実測。** 「目的地を渡らずに着ける側に」を入れると、東京→箱根の3案とも
  //    **ゴールから0.05km・最後から2番目の指示**で uturnRight が出た。
  //    道の反対側へ渡り直すだけの切り返しで、おすすめ道路のせいではない。
  //    ここで原因を探すと、4km以内にあるおすすめ道路が濡れ衣で外される
  const goal = [139.1069, 35.2324];
  const near = mkSeg("ゴールの近くの道", 85, goal[0] + 0.01, goal[1] + 0.01);
  const route = {
    points: [[goal[0] - 0.02, goal[1]], [goal[0] - 0.0005, goal[1]], goal],
    steps: [{ maneuver: "start", beginIndex: 0 },
            { maneuver: "uturnRight", beginIndex: 1 }],   // ゴールから約45m
  };
  const info = blame(route, [near], goal);
  assert.strictEqual(info.arrivalUTurns, 1, "到着時の切り返しとして数えていない");
  assert.strictEqual(info.uTurnManeuvers, 0, "道のせいのUターンとして数えている");
  assert.strictEqual(info.forever.length, 0,
    `濡れ衣で外している: ${info.forever.map((s) => s.name).join("・")}`);
});

test("ゴールから離れたUターンは、いままでどおり道のせいにする", () => {
  // ⚠️ **見逃さないこと。** 上の除外が広すぎると、本当に道のせいのUターンが
  //    素通りする。実測の市電通り（川崎）はゴールから約20km
  const goal = [139.1069, 35.2324];
  const far = mkSeg("原因の道", 85, goal[0] + 0.1, goal[1] + 0.1);
  const route = {
    points: [[goal[0] + 0.2, goal[1] + 0.2], [goal[0] + 0.1, goal[1] + 0.1], goal],
    steps: [{ maneuver: "start", beginIndex: 0 },
            { maneuver: "uturnRight", beginIndex: 1 }],
  };
  const info = blame(route, [far], goal);
  assert.strictEqual(info.arrivalUTurns, 0, "到着時の切り返しに数えている");
  assert.strictEqual(info.uTurnManeuvers, 1, "道のせいのUターンとして数えていない");
  assert.ok(info.forever.some((s) => s.id === "原因の道"), "原因を特定できていない");
});

test("到着とみなす範囲が、原因を探す範囲よりずっと内側である", () => {
  const { BLAME_WITHIN_METERS } = require("../lib/navGeometry");
  // ⚠️ 逆転すると、ゴールの近くのUターンを全部見逃す
  assert.ok(ARRIVAL_UTURN_METERS < BLAME_WITHIN_METERS / 5,
    `到着とみなす範囲 ${ARRIVAL_UTURN_METERS}m が、`
    + `原因を探す範囲 ${BLAME_WITHIN_METERS}m に近すぎる`);
});
