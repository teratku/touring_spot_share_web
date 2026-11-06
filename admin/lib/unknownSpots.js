/**
 * admin/lib/unknownSpots.js
 *
 * 未知のスポットの判定（定義はアプリの repo の docs/unknown-spots-definition.md）。
 * 利用者の判断（2026-11-06）: B（アプリにとって未知）を本命・A（自分にとって未知）も一緒・通り過ぎたは未知のまま。
 * まずは開発者だけが調整ツール（/unknown）で確かめる。
 *
 * B: OSM の候補（buildUnknownSpots.py → data/unknown-spots.json）のうち
 *    ① アプリの投稿から 300m 以内に無い（広い地物は形の大きさ r を足す）
 *    ② 名前がある（候補は名前ありだけ書き出してある）
 *    ③ バイクで行ける: 車の通れる道のそば（`road`）・立入禁止でない
 *    ④ 値打ちの手がかり: wikidata／wikipedia／文化財・おすすめ道路から 1km・展望所／滝／峠／岬
 * A: アプリの投稿のうち、その人の投稿から 300m 以内に無いもの（ほかの人の投稿）。
 *    ⚠️ 「寄った」（走行記録で 150m に 5分）は端末の中にしか無いので、ここでは見ない
 */
"use strict";

const { decode } = require("./polyline");

const POSTED_METERS = 300;
const FUN_ROAD_METERS = 1000;
const OWN_POST_METERS = 300;
/** 種類そのものが寄る先になりやすい（値打ちの手がかりに数える） */
const STRONG_KINDS = new Set(["viewpoint", "waterfall", "pass", "cape"]);
const KIND_LABELS = {
  viewpoint: "展望所", waterfall: "滝", pass: "峠", cape: "岬", beach: "海岸", onsen: "温泉",
  dam: "ダム", attraction: "観光地", camp: "キャンプ場", lake: "湖・池", historic: "城・史跡",
  worship: "神社・寺", park: "公園",
};

/** 判定の理由（ビット）。0 なら未知のスポットとして出す */
const FLAG = { posted: 1, noRoad: 2, noValue: 4, closed: 8 };

function metersBetween(lat1, lng1, lat2, lng2) {
  const k = Math.cos((lat1 * Math.PI) / 180) * 111320;
  return Math.hypot((lat1 - lat2) * 111320, (lng1 - lng2) * k);
}

/** 点の升目（約 1.1km）。近さを見るときは隣の升目まで見る（それより遠い距離は見ない） */
class PointGrid {
  constructor(cell = 0.01) { this.cell = cell; this.cells = new Map(); }
  key(i, j) { return i * 100000 + j; }
  add(lat, lng, item = null) {
    const k = this.key(Math.floor(lat / this.cell), Math.floor(lng / this.cell));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push([lat, lng, item]);
  }
  /** 距離 meters 以内に点があるか（⚠️ meters は升目の大きさ 1.1km まで） */
  nearest(lat, lng, meters) {
    const ci = Math.floor(lat / this.cell), cj = Math.floor(lng / this.cell);
    const span = Math.max(1, Math.ceil(meters / (this.cell * 111320 * Math.cos((lat * Math.PI) / 180))));
    let best = null;
    for (let i = ci - span; i <= ci + span; i++) {
      for (let j = cj - span; j <= cj + span; j++) {
        for (const p of this.cells.get(this.key(i, j)) || []) {
          const d = metersBetween(lat, lng, p[0], p[1]);
          if (d <= meters && (!best || d < best.meters)) best = { meters: d, item: p[2] };
        }
      }
    }
    return best;
  }
}

/** アプリの投稿（{lat,lng,spotId,name,...}）の升目 */
function postGrid(posts) {
  const g = new PointGrid();
  for (const p of posts) if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) g.add(p.lat, p.lng, p);
  return g;
}

/** おすすめ道路（県ごとの segments）の升目。線の上に 200m ごとに点を置く */
function funRoadGrid(segments) {
  const g = new PointGrid();
  for (const s of segments) {
    let pts;
    try { pts = decode(s.polyline); } catch (_) { continue; }
    let last = null;   // 最後に置いた点
    let prev = null;   // 1つ前の頂点
    // ⚠️ decode は [経度, 緯度] の並びで返す（roadCsv と同じ）
    for (const [lng, lat] of pts) {
      if (!last) { g.add(lat, lng, s.id); last = prev = [lat, lng]; continue; }
      // ⚠️ 頂点の間が長い直線（数百 m〜）だと頂点だけでは抜ける。間を 200m ごとに埋める
      const d = metersBetween(prev[0], prev[1], lat, lng);
      const steps = Math.floor(d / 200);
      for (let i = 1; i <= steps; i++) {
        const f = i / (steps + 1);
        g.add(prev[0] + (lat - prev[0]) * f, prev[1] + (lng - prev[1]) * f, s.id);
      }
      if (steps > 0 || metersBetween(lat, lng, last[0], last[1]) >= 200) { g.add(lat, lng, s.id); last = [lat, lng]; }
      prev = [lat, lng];
    }
  }
  return g;
}

/** 1件の判定。返すのは理由のビットと、近くの投稿・おすすめ道路 */
function judge(spot, posts, funRoads) {
  let flags = 0;
  const near = posts.nearest(spot.lat, spot.lng, POSTED_METERS + (spot.r || 0));
  if (near) flags |= FLAG.posted;
  if (!spot.road) flags |= FLAG.noRoad;
  const x = spot.x || {};
  if (x.access === "private" || x.access === "no") flags |= FLAG.closed;
  const wiki = !!(x.wikidata || x.wikipedia);
  const heritage = !!x.heritage;
  // ⚠️ おすすめ道路はほかの手がかりが無いときだけ引く（数万件で毎回引くと重い）
  const strong = STRONG_KINDS.has(spot.kind);
  const funRoad = !(wiki || heritage || strong) && funRoads
    ? !!funRoads.nearest(spot.lat, spot.lng, FUN_ROAD_METERS) : false;
  if (!(wiki || heritage || strong || funRoad)) flags |= FLAG.noValue;
  return { flags, postedBy: near ? near.item : null, wiki, heritage, strong, funRoad };
}

/** 全部の判定と、種類ごとの数 */
function classify(spots, posts, funRoads) {
  const pg = postGrid(posts);
  const counts = {};
  const out = [];
  for (const s of spots) {
    const j = judge(s, pg, funRoads);
    const c = counts[s.kind] || (counts[s.kind] = { all: 0, unknown: 0, posted: 0, noRoad: 0, noValue: 0, closed: 0 });
    c.all++;
    if (j.flags === 0) c.unknown++;
    if (j.flags & FLAG.posted) c.posted++;
    if (j.flags & FLAG.noRoad) c.noRoad++;
    if (j.flags & FLAG.noValue) c.noValue++;
    if (j.flags & FLAG.closed) c.closed++;
    const why = [j.wiki && "wiki", j.heritage && "文化財", j.strong && "種類", j.funRoad && "おすすめ道路"].filter(Boolean);
    out.push([s.lat, s.lng, s.name, s.kind, s.osm, j.flags, why.join("・"), j.postedBy ? j.postedBy.spotId : null]);
  }
  return { counts, spots: out };
}

/** A: その人の投稿から 300m 以内に無い、ほかの人の投稿 */
function othersUnknown(posts, uid) {
  const mine = posts.filter((p) => p.userID === uid);
  const g = postGrid(mine);
  const others = posts.filter((p) => p.userID !== uid);
  const unknown = others.filter((p) => !g.nearest(p.lat, p.lng, OWN_POST_METERS));
  return { mine: mine.length, others: others.length, unknown };
}

module.exports = {
  POSTED_METERS, FUN_ROAD_METERS, OWN_POST_METERS, STRONG_KINDS, KIND_LABELS, FLAG,
  metersBetween, PointGrid, postGrid, funRoadGrid, judge, classify, othersUnknown,
};
