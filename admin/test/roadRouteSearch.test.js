"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { routeBetween } = require("../lib/roadRoute");

/**
 * 経路探索そのもの（ダイクストラ）の確認。
 *
 * ⚠️ ここは**手で作った材料だけ**で確かめる。手元のCSVに依存させると、
 *    データを差し替えたときに落ちて、探索が壊れたのかデータが変わったのかが
 *    分からなくなる（roadRoute.test.js は実データを使う側）。
 */

/** 一時フォルダに1マスぶんのCSVを書く。返り値は読ませるフォルダ */
function writeGrid(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roadroute-"));
  // ⚠️ マス名は座標から決まる（lat*10+900 / lng*10+1800）。
  //    35.6〜35.7N / 138.8〜138.9E に置くので 1256_3188 になる
  fs.writeFileSync(path.join(dir, "roads_grid_1256_3188.csv"),
                   ["osm_id,name,highway,ref,geometry", ...lines].join("\n"));
  return dir;
}

const LAT = 35.61;
//: この緯度での1度あたりの距離。coord を meters から作るために使う
const M_PER_LNG = 111320 * Math.cos(LAT * Math.PI / 180);
const M_PER_LAT = 110574;

let osmId = 0;
const line = (a, b) =>
  `${++osmId},,residential,,"LINESTRING (${a[0].toFixed(6)} ${a[1].toFixed(6)}, ${b[0].toFixed(6)} ${b[1].toFixed(6)})"`;

// MARK: いちばん短い道を選ぶ

/**
 * ⚠️ **短い区間をたくさん通る道の方が、実際には近いことがある。**
 *    区間の数ではなく**距離の合計**で選べているかを見る。
 *
 * ⚠️ **分かれ目を始点に置かないこと。** 最初これで書いて、順位の付け方を
 *    壊しても落ちなかった。始点は道の途中に吸い付いて新しいノードになるので、
 *    そこから出る枝は「吸い付いた区間の両端」だけになり、**分かれ道が
 *    探索から隠れてしまう**。だから始点から少し入った F で分ける。
 *
 *        始点 ──500m── F ┬── 2,000m ×3 ──┬ 終点   （遠い: 6,000m）
 *                        └── 100m ×30 ───┘        （近い: 3,000m）
 *
 *    正しく選べば 500 + 3,000 = 3,500m。
 *    大きい方から取り出すなど順位を間違えると 6,500m の方が返る。
 */
test("区間の数ではなく距離の合計で選ぶ", async () => {
  const east = (m) => m / M_PER_LNG;
  const north = (m) => m / M_PER_LAT;
  const at = (e, n) => [138.81 + east(e), LAT + north(n)];

  const from = at(0, 0);
  const fork = at(500, 0);
  const goal = at(3500, 0);

  const lines = [line(from, fork)];
  // 遠い方: 2,000m を3区間で 6,000m（北へ膨らませて別の道にする）
  let prev = fork;
  for (let i = 1; i <= 3; i++) {
    // ⚠️ 東西の伸びを 1,000m ずつにして、北へ約1,732m寄せると1区間2,000mになる
    const next = i === 3 ? goal : at(500 + 1000 * i, 1732);
    lines.push(line(prev, next));
    prev = next;
  }
  // 近い方: 100m を30区間で 3,000m（まっすぐ東へ）
  prev = fork;
  for (let i = 1; i <= 30; i++) {
    const next = i === 30 ? goal : at(500 + 100 * i, 0);
    lines.push(line(prev, next));
    prev = next;
  }

  const dir = writeGrid(lines);
  try {
    const r = await routeBetween(from, goal, { gridDir: dir });
    assert.ok(!r.error, "つながらない: " + r.error);
    assert.ok(r.lengthMeters < 4500,
              `区間が少ないだけの遠回りを選んでいる（${Math.round(r.lengthMeters)}m。`
              + `近い道は約3,500m、遠回りは約6,500m）`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MARK: ノードが増えても終わること

/**
 * ⚠️ **これは速さの話に見えて、実は使えるかどうかの話。**
 *    元は「ノードは数千だから」と、距離の表を毎回なめて最小を選んでいた。
 *    名前の無い道も読むようにしたら 2,977 → 35,216 ノードになり、
 *    1本引くのに **12.2秒** かかるようになった（画面が固まる）。
 *
 *    この材料（19,600ノード）での実測:
 *        なめる版  6,985ms
 *        ヒープ版    405ms
 *    しきい値の 2.5秒 は、ヒープ版の6倍・なめる版の1/2.8。
 *    読ませるCSVを増やすたびにここが効くので、外さないこと。
 */
test("ノードが2万近くあっても2.5秒で終わる", async () => {
  const N = 140;                       // 140×140 = 19,600ノード
  const LAT0 = 35.605, LNG0 = 138.805, SPAN = 0.09;
  const step = SPAN / (N - 1);
  const at = (i, j) => [LNG0 + j * step, LAT0 + i * step];

  const lines = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      // 右と上へ繋いで格子にする
      if (j + 1 < N) lines.push(line(at(i, j), at(i, j + 1)));
      if (i + 1 < N) lines.push(line(at(i, j), at(i + 1, j)));
    }
  }

  const dir = writeGrid(lines);
  try {
    const began = Date.now();
    const r = await routeBetween(at(0, 0), at(N - 1, N - 1), { gridDir: dir });
    const took = Date.now() - began;
    assert.ok(!r.error, "つながらない: " + r.error);
    assert.ok(took < 2500,
              `19,600ノードに ${took}ms かかっている。`
              + `距離の表をなめて最小を選ぶ形に戻っていないか確かめること`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MARK: 読んだマスを控える

/**
 * ⚠️ **CSVを差し替えたら控えを捨てること。** ルート生成は同じ地域で
 *    12本引くので、読んだ結果を控えている（1本 1,126ms → 416ms）。
 *    ただし作り直したCSVに古い控えを返すと、「作り直したのに変わらない」になる。
 *    ファイルの更新時刻を鍵に入れてあり、書き換われば読み直す。
 */
test("CSVを書き換えたら読み直す", async () => {
  const east = (m) => m / M_PER_LNG;
  const at = (e) => [138.81 + east(e), LAT];
  const from = at(0);
  const goal = at(2000);

  const dir = writeGrid([line(from, at(1000)), line(at(1000), goal)]);
  try {
    const before = await routeBetween(from, goal, { gridDir: dir });
    assert.ok(!before.error, "つながらない: " + before.error);

    // 同じ両端のまま、あいだの道を北へ大きく膨らませて書き換える
    const north = (m) => m / M_PER_LAT;
    const bulge = [138.81 + east(1000), LAT + north(3000)];
    fs.writeFileSync(path.join(dir, "roads_grid_1256_3188.csv"),
      ["osm_id,name,highway,ref,geometry",
       line(from, bulge), line(bulge, goal)].join("\n"));
    // ⚠️ 更新時刻はミリ秒まで見ている。同じミリ秒に書くと差が出ないので、
    //    ここだけは時刻を明示して進めておく
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, "roads_grid_1256_3188.csv"), later, later);

    const after = await routeBetween(from, goal, { gridDir: dir });
    assert.ok(!after.error, "書き換えたらつながらなくなった: " + after.error);
    assert.ok(after.lengthMeters > before.lengthMeters * 1.5,
              `書き換えたCSVを読んでいない（${Math.round(before.lengthMeters)}m → `
              + `${Math.round(after.lengthMeters)}m。膨らませたので3倍以上になるはず）`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ⚠️ **控えは上限を持つこと。** 1マス約1.6万点・1点97バイト（実測）なので、
 *    上限が無いと全国4,780マスで数GB抱えて落ちる。古く使ったものから捨てる。
 *
 * ⚠️ 「結果が変わらない」だけでは足りない。最初それで書いて、**上限を丸ごと
 *    外しても通ってしまった**。何マス控えているかを直接見る。
 */
test("控えは上限を超えたら古いマスから捨てる", async () => {
  const east = (m) => m / M_PER_LNG;
  // 1マスに10本＝20点ちょうど。3マス（60点）だけ入る上限にする
  const PER_CELL = 20;
  const dirs = [];
  for (let d = 0; d < 4; d++) {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(line([138.81 + east(i * 100), LAT], [138.81 + east(i * 100 + 50), LAT]));
    }
    dirs.push(writeGrid(lines));
  }

  const kept = process.env.ROUTE_CACHE_POINTS;
  process.env.ROUTE_CACHE_POINTS = String(PER_CELL * 3 + 1);
  delete require.cache[require.resolve("../lib/roadRoute")];
  const limited = require("../lib/roadRoute");
  try {
    for (const dir of dirs) {
      // 繋がるかどうかはここでは関係ない。読んだ時点で控えに入る
      await limited.routeBetween([138.81, LAT], [138.81 + east(400), LAT], { gridDir: dir });
    }
    const stats = limited.cellCacheStats();
    // ⚠️ 4マス読んで、3マスぶんだけ残っているのが正しい。
    //    4のままなら**捨てていない**。1まで減っていたら**捨てすぎ**
    //    （控えている点数を引き忘れると、以後ずっと上限を超えたままになる）
    assert.strictEqual(stats.cells, 3,
      `4マス読んだあと ${stats.cells}マス控えている（3マスのはず）。`
      + `4なら捨てていない、1なら捨てすぎ（点数の引き忘れ）`);
    assert.strictEqual(stats.points, PER_CELL * 3,
      `控えている点数が ${stats.points}（${PER_CELL * 3}点のはず）`);
  } finally {
    if (kept === undefined) delete process.env.ROUTE_CACHE_POINTS;
    else process.env.ROUTE_CACHE_POINTS = kept;
    delete require.cache[require.resolve("../lib/roadRoute")];
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

/**
 * ⚠️ **同じマスを2回読まないこと。** これが控えの本来の目的。
 *    ルート生成は同じ地域で12本引くので、ここが効かないと元の遅さに戻る。
 */
test("同じマスは読み直さない", async () => {
  const east = (m) => m / M_PER_LNG;
  const dir = writeGrid([line([138.81, LAT], [138.81 + east(1000), LAT]),
                         line([138.81 + east(1000), LAT], [138.81 + east(2000), LAT])]);
  delete require.cache[require.resolve("../lib/roadRoute")];
  const fresh = require("../lib/roadRoute");
  try {
    await fresh.routeBetween([138.81, LAT], [138.81 + east(2000), LAT], { gridDir: dir });
    const first = fresh.cellCacheStats();
    await fresh.routeBetween([138.81, LAT], [138.81 + east(2000), LAT], { gridDir: dir });
    const second = fresh.cellCacheStats();
    assert.deepStrictEqual(
      { cells: second.cells, points: second.points },
      { cells: first.cells, points: first.points },
      `2回目で控えが増えている（${first.points}点 → ${second.points}点）。`
      + "控えを引かずに読み直している");
  } finally {
    delete require.cache[require.resolve("../lib/roadRoute")];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ⚠️ **捨てるのは「いちばん昔に使った」マス。「いちばん昔に読んだ」ではない。**
 *    ずっと使っているマスが、読んだのが古いというだけで捨てられると、
 *    12本引くあいだ同じマスを読み直し続けることになる。
 */
test("捨てるのは、いちばん昔に使ったマス", async () => {
  const east = (m) => m / M_PER_LNG;
  const PER_CELL = 4;
  const dirs = [];
  for (let d = 0; d < 4; d++) {
    dirs.push(writeGrid([line([138.81, LAT], [138.81 + east(100), LAT]),
                         line([138.81 + east(100), LAT], [138.81 + east(200), LAT])]));
  }
  const kept = process.env.ROUTE_CACHE_POINTS;
  process.env.ROUTE_CACHE_POINTS = String(PER_CELL * 3);
  delete require.cache[require.resolve("../lib/roadRoute")];
  const limited = require("../lib/roadRoute");
  const visit = (dir) =>
    limited.routeBetween([138.81, LAT], [138.81 + east(200), LAT], { gridDir: dir });
  try {
    await visit(dirs[0]);
    await visit(dirs[1]);
    await visit(dirs[2]);
    await visit(dirs[0]);        // 0 をもう一度使う → いちばん昔は 1 になる
    await visit(dirs[3]);        // ここで1マス捨てられる

    const left = limited.cellCacheStats().paths.map((p) => dirs.findIndex((d) => p.startsWith(d)));
    assert.ok(!left.includes(1),
              `いちばん昔に使った1を残している（残り: ${left.join(",")}）`);
    assert.ok(left.includes(0),
              `直前に使い直した0を捨てている（残り: ${left.join(",")}）`);
  } finally {
    if (kept === undefined) delete process.env.ROUTE_CACHE_POINTS;
    else process.env.ROUTE_CACHE_POINTS = kept;
    delete require.cache[require.resolve("../lib/roadRoute")];
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});
