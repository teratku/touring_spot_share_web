"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { segmentsBetween, prefecturesWithin, build, clearIndex, MIN_RADIUS_KM, DIR }
  = require("../lib/roadRecommendIndex");
const { selectFunRoads } = require("../lib/funRouteSelect");

/**
 * 両端のあいだにある県のおすすめ道路を、県をまたいで集めるところ。
 *
 * ⚠️ 手元に data/road-recommend/ が無い環境では飛ばす。
 */
const hasData = fs.existsSync(DIR) && fs.readdirSync(DIR).some((f) => f.endsWith(".json"));
const skipIfNoData = (t) => (hasData ? false : t.skip("おすすめ道路のデータが無い環境"));

const SHINJUKU = [139.7003, 35.6896];
const CHICHIBU = [139.0784, 35.9926];      // 秩父は**埼玉県**
const KOFU = [138.5684, 35.6642];
const FUJI = [138.8087, 35.4876];

test("県をまたいで集める", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ **これが無いと市街地の道しか選べない。**
  //    新宿→秩父は東京から埼玉へ渡る。東京のデータだけだと
  //    候補3本（祝田通り・明治通りなど市街地の道）しか無い
  const { prefectures } = segmentsBetween(SHINJUKU, CHICHIBU);
  assert.ok(prefectures.includes("tokyo"), "出発地の県が入っていない");
  assert.ok(prefectures.includes("saitama"),
    `目的地（秩父＝埼玉）の県が入っていない: ${prefectures.join(" ")}`);
});

test("県をまたぐと、市街地の道ではなく峠が選ばれる", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ この差が、この仕組みを入れた理由そのもの。実測:
  //      東京だけ    候補 3本 → 祝田通り(66点)・明治通り(71点)
  //      東京＋埼玉  候補21本 → 青梅秩父線(77点)・下日野沢東門平吉田線(82点)
  const tokyoOnly = JSON.parse(
    fs.readFileSync(path.join(DIR, "tokyo.json"), "utf8")).segments;
  const across = segmentsBetween(SHINJUKU, CHICHIBU).segments;

  const a = selectFunRoads(SHINJUKU, CHICHIBU, tokyoOnly, { count: 4 });
  const b = selectFunRoads(SHINJUKU, CHICHIBU, across, { count: 4 });

  assert.ok(b.considered > a.considered * 3,
    `候補が増えていない（東京だけ${a.considered}本 → またぐと${b.considered}本）`);
  const worstAcross = Math.min(...b.segments.map((s) => s.score));
  const worstTokyo = Math.min(...a.segments.map((s) => s.score));
  assert.ok(worstAcross > worstTokyo,
    `選ばれた道の質が上がっていない（東京だけ最低${worstTokyo}点 → またぐと最低${worstAcross}点）`);
});

test("近い2点でも、まわりの県を見る", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ 半径には下限がある。近い2点だからと出発地の県だけにすると、
  //    県境のすぐ向こうにある道を見落とす
  const { prefectures } = segmentsBetween(KOFU, FUJI);   // 直線22km・どちらも山梨
  assert.ok(prefectures.length > 1,
    `${MIN_RADIUS_KM}km の下限が効いていない（${prefectures.join(" ")}）`);
  assert.ok(prefectures.includes("yamanashi"), "山梨が入っていない");
});

test("短い旅でも下限ぶんの広さを見る", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ **半径の下限を外さないこと。** 直線7kmの旅（高尾→相模湖）で、
  //    下限が無いと3県、あると5県。県境をまたいですぐの道を見落とす
  const takao = [139.2700, 35.6250], sagami = [139.1900, 35.6100];
  const withFloor = segmentsBetween(takao, sagami).prefectures;
  // 下限を外したときに相当する範囲（中点から直線距離ぶんだけ）
  const center = [(takao[0] + sagami[0]) / 2, (takao[1] + sagami[1]) / 2];
  const spanKm = Math.hypot((sagami[1] - takao[1]) * 111,
                            (sagami[0] - takao[0]) * 111 * Math.cos(center[1] * Math.PI / 180));
  const withoutFloor = prefecturesWithin(center, spanKm);
  assert.ok(spanKm < MIN_RADIUS_KM,
    `材料が悪い（直線${spanKm.toFixed(0)}km。下限${MIN_RADIUS_KM}km より短いこと）`);
  assert.ok(withFloor.length > withoutFloor.length,
    `下限が効いていない（下限あり${withFloor.length}県／なし${withoutFloor.length}県）`);
});

test("箱の中心は両端の中点（出発地ではない）", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ 出発地を中心にすると、**目的地の側の県が落ちる。**
  //    実測（甲府→富士吉田）: 中点なら6県、出発地なら3県
  const midCenter = segmentsBetween(KOFU, FUJI).prefectures;
  const spanKm = Math.hypot((FUJI[1] - KOFU[1]) * 111,
                            (FUJI[0] - KOFU[0]) * 111 * Math.cos(35.6 * Math.PI / 180));
  const fromOrigin = prefecturesWithin(KOFU, Math.max(MIN_RADIUS_KM, spanKm));
  assert.ok(midCenter.length > fromOrigin.length,
    `中点を中心にしていない（中点${midCenter.length}県／出発地${fromOrigin.length}県）`);
});

test("遠く離れた県は読まない", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ 全県読むと 4.4MB を毎回解くことになる。関係ない県は落とす
  const { prefectures } = segmentsBetween(KOFU, FUJI);
  assert.ok(!prefectures.includes("hokkaido"), "北海道まで読んでいる");
  assert.ok(!prefectures.includes("okinawa"), "沖縄まで読んでいる");
  assert.ok(prefectures.length < 20, `${prefectures.length}県も読んでいる`);
});

test("距離が伸びれば、見る県も増える", (t) => {
  if (skipIfNoData(t)) return;
  const near = segmentsBetween(KOFU, FUJI).prefectures.length;
  const far = segmentsBetween([139.7671, 35.6812], [140.8694, 38.2682]).prefectures.length;
  assert.ok(far > near, `東京→仙台(${far}県) が 甲府→富士吉田(${near}県) より少ない`);
});

test("索引は使い回す（毎回4.4MBを解かない）", (t) => {
  if (skipIfNoData(t)) return;
  clearIndex();
  const t1 = Date.now(); build(); const first = Date.now() - t1;
  const t2 = Date.now(); build(); const second = Date.now() - t2;
  // ⚠️ 実測: 初回126ms / 2回目1ms
  assert.ok(second < Math.max(5, first / 10),
    `2回目が ${second}ms（初回 ${first}ms）。索引を作り直している`);
});

test("データを差し替えたら索引を作り直す", (t) => {
  if (skipIfNoData(t)) return;
  // ⚠️ 作り直しても古い索引を返すと、「生成したのに反映されない」になる。
  //    ファイルの更新時刻を指紋に入れてある
  const file = path.join(DIR, "yamanashi.json");
  const before = build();
  const kept = fs.statSync(file);
  try {
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const after = build();
    assert.notStrictEqual(after, before, "同じ索引を返している（作り直していない）");
    assert.ok(after.yamanashi, "作り直したら県が消えた");
  } finally {
    fs.utimesSync(file, kept.atime, kept.mtime);
    clearIndex();
  }
});

test("中心から離れた県は箱に入らない", (t) => {
  if (skipIfNoData(t)) return;
  // 半径を極端に小さくすると、まわりの県が落ちること
  const tight = prefecturesWithin(KOFU, 5);
  const wide = prefecturesWithin(KOFU, 200);
  assert.ok(tight.length < wide.length,
    `半径5km(${tight.length}県) が 200km(${wide.length}県) より少なくない`);
});
