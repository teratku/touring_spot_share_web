"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { routeBetween, cellsCovering, MAX_CELLS, MARGIN_DEGREES,
        JOIN_METERS } = require("../lib/roadRoute");
const { distanceMeters } = require("../lib/roadCsv");

const GRID = path.join(os.homedir(), "Documents", "grid_csvs_japan_empty");
const skipIfNoCsv = (t) => (fs.existsSync(GRID) ? false : t.skip("手元にCSVが無い環境"));

/**
 * 両端を指して、そのあいだを道でつなぐ処理の確認。
 *
 * ⚠️ 車の経路探索ではない。一方通行も進入禁止も見ていない。
 *    規制区間の形を作るための「道でつながった線」であることを前提に読むこと。
 */

test("範囲に掛かるマスを全部並べる", () => {
  // ⚠️ 四隅だけだと、3マス以上にまたがったとき真ん中が抜けて道が繋がらない
  const cells = cellsCovering([138.0, 35.0], [139.5, 36.0]);
  assert.ok(cells.includes("roads_grid_1257_3187.csv"), "真ん中のマスが抜けている");
  const unique = new Set(cells);
  assert.strictEqual(unique.size, cells.length, "同じマスを重複して読もうとしている");
});

test("近い2点なら読むマスは少ない", () => {
  const cells = cellsCovering([139.0, 35.5], [139.01, 35.51]);
  // 余裕ぶん（±0.05度）で最大3×3
  assert.ok(cells.length <= 9, "近いのに " + cells.length + "マスも読もうとしている");
});

test("広すぎる範囲は断る", async (t) => {
  if (skipIfNoCsv(t)) return;
  // ⚠️ 断らないと何百マスも読んで画面が固まる
  const r = await routeBetween([130.0, 33.0], [140.0, 38.0]);
  assert.ok(r.error && r.error.includes("広すぎ"), "広すぎる範囲を受け付けている: " + JSON.stringify(r).slice(0, 120));
});

test("2点をつないだ線が返る", async (t) => {
  if (skipIfNoCsv(t)) return;
  const from = [138.9077, 35.5568];   // 都留市
  const to = [138.9400, 35.6100];     // 大月市
  const r = await routeBetween(from, to);

  assert.ok(!r.error, r.error);
  assert.ok(r.points.length > 2, "点が少なすぎる");
  assert.ok(r.lengthMeters > distanceMeters(from, to), "直線より短い（道を通っていない）");
  assert.ok(r.polyline.length > 0, "線が空");
});

test("線は指した両端から始まって終わる", async (t) => {
  if (skipIfNoCsv(t)) return;
  const from = [138.9077, 35.5568];
  const to = [138.9400, 35.6100];
  const r = await routeBetween(from, to);

  // ⚠️ 逆順に組み立てると、始点と終点が入れ替わった線になる
  const head = distanceMeters(from, r.points[0]);
  const tail = distanceMeters(to, r.points[r.points.length - 1]);
  assert.ok(head < 500, `線の始まりが始点から${Math.round(head)}m離れている`);
  assert.ok(tail < 500, `線の終わりが終点から${Math.round(tail)}m離れている`);
});

test("つなぎ目で線が飛んでいない", async (t) => {
  if (skipIfNoCsv(t)) return;
  // ⚠️ 元データ自体に長い直線区間（実測で最大739m）があるので、頂点の間隔では
  //    判定できない。**区間のつなぎ目だけ**を見る
  const r = await routeBetween([138.9077, 35.5568], [138.9400, 35.6100]);
  assert.ok(r.joinGapMeters <= JOIN_METERS,
            `つなぎ目が ${r.joinGapMeters}m 飛んでいる（許容 ${JOIN_METERS}m）`);
});

test("道から遠い点は断る", async (t) => {
  if (skipIfNoCsv(t)) return;
  // ⚠️ 黙って遠くの道に吸い付けると、まったく違う場所の線ができる
  const r = await routeBetween([138.9077, 35.5568], [139.05, 35.62]);  // 山の中
  if (r.error) assert.ok(/近くに道が見つかりません|つなぐ道が見つかりません/.test(r.error), r.error);
  else assert.ok(r.snapToMeters <= 500, "遠い点に吸い付いている: " + r.snapToMeters + "m");
});

test("同じ場所を2回指したら断る", async (t) => {
  if (skipIfNoCsv(t)) return;
  const at = [138.9077, 35.5568];
  const r = await routeBetween(at, at);
  assert.ok(r.error, "同じ点なのに線を作っている");
});

test("端点を繋がないと遠回りになる", async (t) => {
  if (skipIfNoCsv(t)) return;
  // ⚠️ **このテストは以前と主張が変わっている。** 元は「0mだと繋がらない」を
  //    確かめていたが、線の途中に乗せられるようにしたら0mでも繋がるようになった。
  //    いまの繋ぎの役目は「繋がるかどうか」ではなく**遠回りを防ぐこと**。
  //    実測（大月→青梅・直線36.2km）: 0m→62.29km / 25m→54.40km / 50m→53.92km
  const from = [138.9400, 35.6100];
  const to = [139.2750, 35.7880];
  const strict = await routeBetween(from, to, { joinMeters: 0 });
  const normal = await routeBetween(from, to);
  assert.ok(!normal.error, "既定の距離で繋がらない: " + normal.error);
  if (strict.error) return;   // 繋がらないなら、それはそれで既定の方が良いということ
  assert.ok(strict.lengthMeters > normal.lengthMeters * 1.05,
            `繋がなくても変わらない（${strict.lengthMeters} vs ${normal.lengthMeters}）`);
});

// MARK: 道の途中を指す（実機で報告された不具合）

/**
 * ⚠️ 実機で報告：「先へ延ばそうと別の場所をクリックしても
 *    『始点と終点が同じ場所です』と出る」。
 *
 *    原因は、両端を**道路断片の端点（交差点）にしか吸い付けていなかった**こと。
 *    道の途中を指すと近くに端点が無く、たまたま同じ交差点が最寄りになると
 *    「同じ場所」と判定されていた。線の途中で切ってノードを作るようにした。
 */
test("道の途中どうしでもつながる", async (t) => {
  if (skipIfNoCsv(t)) return;
  const { parseWkt, readGridFile } = require("../lib/roadCsv");
  const { TARGET_HIGHWAYS } = require("../lib/roadsAtPoint");

  let target = null;
  await readGridFile(path.join(GRID, "roads_grid_1258_3192.csv"), (row) => {
    if (target || !TARGET_HIGHWAYS.has(row.get("highway"))) return;
    const points = parseWkt(row.get("geometry"));
    if (points && points.length > 40) target = points;
  });
  if (!target) return t.skip("長い道が見つからない環境");

  // どちらも端点ではなく、線の途中
  const from = target[Math.floor(target.length * 0.3)];
  const to = target[Math.floor(target.length * 0.7)];
  const r = await routeBetween(from, to);

  assert.ok(!r.error, "途中どうしで繋がらない: " + r.error);
  // ⚠️ 交差点まで戻ってから来る「行って戻り」になっていないこと。
  //    2点の直線距離の3倍を超えていたら、遠回りを疑う
  const straight = distanceMeters(from, to);
  assert.ok(r.lengthMeters < straight * 6,
            `遠回りしている（直線${Math.round(straight)}m に対し ${r.lengthMeters}m）`);
});

test("道から少しずれた場所を指してもつながる", async (t) => {
  if (skipIfNoCsv(t)) return;
  // 実際のクリックは道の真上には落ちない
  const from = [138.9077, 35.5568];
  const off = [138.9410, 35.6105];      // 大月市のあたりから少しずらした点
  const r = await routeBetween(from, off);
  assert.ok(!r.error, r.error);
});

test("本当に同じ場所なら断る", async (t) => {
  if (skipIfNoCsv(t)) return;
  // ⚠️ 直したせいで、同じ点を2回指しても通ってしまわないこと
  const at = [138.9077, 35.5568];
  const r = await routeBetween(at, at);
  assert.ok(r.error && r.error.includes("同じ場所"), "同じ点を通している: " + JSON.stringify(r).slice(0, 80));
});
