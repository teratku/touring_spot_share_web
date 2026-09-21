/**
 * restrictionOverlap.js
 *
 * 通行規制の区間と、おすすめ道路の区間が重なっていないかを調べる。
 *
 * 【なぜ必要か】
 * 生成もアプリも**規制をまったく見ていない**。二輪通行禁止の道がおすすめとして
 * 配信され、ルート生成が自分でそれを選ぶことがあり得る。走れない道へ案内する
 * ことになるので、配信する前に気付けるようにする。
 *
 * 【重なりの測り方】
 * 規制の線を一定間隔で打ち直し、その点が道の線の `nearMeters` 以内に何割あるかを見る。
 * 「近い点が1つでもあれば重なり」にはしない。交差するだけの道（交差点で1点だけ近い）
 * まで拾ってしまい、無関係な道が軒並み引っかかる。
 */
"use strict";

/** 点が線の上にあるとみなす距離（m）。GPS ではなく地図データ同士なので厳しめでよい */
const NEAR_METERS = 25;

/** 規制の線を打ち直す間隔（m） */
const STEP_METERS = 20;

/** これ以上の割合が重なっていたら「同じ道」とみなす */
const MIN_RATIO = 0.3;

/**
 * **経路が**規制線の上を連続して走った距離（m）。これを超えたら「通っている」。
 *
 * ⚠️ **割合（`MIN_RATIO`）では経路を測れない。** あれは「この道とこの道は同じ道か」
 *    を見る物差しで、おすすめ道路を一覧から落とすのに使う。経路は**1mでも走れば
 *    通行禁止違反**なので、長い規制線をかすめただけでも拾わなければならない。
 *    実測（2026-09-20・朝日峠展望公園への経路。実機で報告された形）:
 *      フルーツライン(八郷広域農道) … 重なり100%・連続3,228m → 割合でも拾えた
 *      表筑波スカイライン            … 重なり 17%・連続  763m → **割合では見逃す**
 *      フルーツライン(八郷広域農道) … 重なり  2%・連続   67m → **割合では見逃す**
 *
 * ⚠️ **交差点で横切るだけを拾わないための下限。** 実測（打ち直したあとの値）:
 *      90度で横切る … 連続 50m
 *      45度        … 連続 71m
 *      30度        … 連続100m
 *      20度        … 連続146m
 *    浅い角度で交わる道まで含めて外すため、**150m** を下限にする。
 * ⚠️ これを下回る「短く走った」ぶんは見逃す。同じ道の別区間で長く走っていれば
 *    そちらで拾えるので、警告そのものは出る（実測: フルーツライン(八郷広域農道)は
 *    67m の区間を見逃すが、3,228m の区間で拾える）。
 * ⚠️ もっと厳しく見たくなったら、距離ではなく**経路と規制線の向き**
 *    （並行か直交か）で見分けること。距離だけでは浅い角度の横切りと区別できない。
 */
const ROUTE_RUN_METERS = 150;

function distanceMeters(a, b) {
  const R = 6371000;
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 一定間隔で打ち直す。点の粗密で判定がぶれないように */
function resample(points, step = STEP_METERS) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = distanceMeters(points[i - 1], points[i]);
    if (seg <= 0) continue;
    let t = step - carry;
    while (t <= seg) {
      const f = t / seg;
      out.push([
        points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f,
        points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f,
      ]);
      t += step;
    }
    carry = (carry + seg) % step;
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * 点の並びを囲む箱（余白つき）。⚠️ 点は **[経度, 緯度]**。
 *
 * ⚠️ **長い経路では、これで弾かないと終わらない。** 規制1件ごとに経路の全点を
 *    測っていたため、1,509kmの経路×199件で **67秒**かかっていた
 *    （実機で報告 2026-09-21: 50ccで鹿児島まで引くとタイムアウトする）。
 */
function boundsOf(points, marginMeters = 0) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of points) {
    if (!p) continue;
    if (p[0] < minLon) minLon = p[0];
    if (p[0] > maxLon) maxLon = p[0];
    if (p[1] < minLat) minLat = p[1];
    if (p[1] > maxLat) maxLat = p[1];
  }
  if (!Number.isFinite(minLon)) return null;
  const dLat = marginMeters / 111_320;
  // ⚠️ 経度の余白は緯度で変わる。高緯度ほど1度が短いので、余白は広く取る
  const cos = Math.max(0.1, Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));
  const dLon = marginMeters / (111_320 * cos);
  return { minLon: minLon - dLon, maxLon: maxLon + dLon,
           minLat: minLat - dLat, maxLat: maxLat + dLat };
}

const inBounds = (p, b) => p[0] >= b.minLon && p[0] <= b.maxLon
  && p[1] >= b.minLat && p[1] <= b.maxLat;

const boundsOverlap = (a, b) => !(a.maxLon < b.minLon || a.minLon > b.maxLon
  || a.maxLat < b.minLat || a.minLat > b.maxLat);

/** 格子の一辺（度）。約2km。⚠️ `NEAR_METERS`(25m) より十分大きいこと */
const CELL_DEG = 0.02;
const cellKey = (lon, lat) => `${Math.floor(lon / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;

/**
 * 長い線を格子に入れて、近くの点だけ測れるようにする。
 *
 * ⚠️ **打ち直してから入れること。** 格子には線の「点」しか入らないので、
 *    点の間隔が格子（約2km）より広い区間があると、その真ん中を問われたときに
 *    近傍のセルが空になり**取りこぼす**。打ち直せば間隔が `STEP_METERS` に
 *    揃うので、この穴が塞がる（中点を足す小細工では塞ぎきれない）。
 * ⚠️ 打ち直した点の番号は**返さない**。ここは距離を測るためだけの道具で、
 *    範囲の番号は `spansOnLine` が元の線で出す
 */
function indexLine(line) {
  const pts = resample(line, STEP_METERS);
  const cells = new Map();
  for (let i = 0; i < pts.length; i++) {
    const k = cellKey(pts[i][0], pts[i][1]);
    const at = cells.get(k);
    if (at) at.push(i); else cells.set(k, [i]);
  }
  return { line: pts, cells, bounds: boundsOf(pts, 0) };
}

/** 格子を使って点と線の距離を測る。⚠️ 近く（数km）でなければ Infinity でよい */
function distanceToIndexed(point, index) {
  const cx = Math.floor(point[0] / CELL_DEG), cy = Math.floor(point[1] / CELL_DEG);
  let best = Infinity;
  const line = index.line;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const at = index.cells.get(`${cx + dx}:${cy + dy}`);
      if (!at) continue;
      for (const i of at) {
        const d = distanceMeters(point, line[i]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** 点から線までの最短距離。辺の途中も見る */
function distanceToLine(point, line) {
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    best = Math.min(best, distanceMeters(point, line[i]));
    if (i + 1 < line.length) {
      const mid = [(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2];
      best = Math.min(best, distanceMeters(point, mid));
    }
  }
  return best;
}

/**
 * 規制の線が、道の線とどれだけ重なっているか（0〜1）。
 *
 * ⚠️ **規制の側を基準にすること。** 道の側を基準にすると、長い道の一部だけに
 *    掛かった規制を「ほとんど重なっていない」と見誤る。規制されている区間が
 *    その道の上にあるかどうかが知りたい。
 */
function overlapRatio(restrictionLine, roadLine, nearMeters = NEAR_METERS, index = null) {
  const points = resample(restrictionLine);
  if (!points.length || roadLine.length < 2) return 0;
  // ⚠️ **長い線は格子で測ること。** 総当たりだと1,509kmの経路で待たされる
  //    （`boundsOf` の説明を読むこと）。格子は呼ぶ側が使い回す
  const idx = index || (roadLine.length > 2_000 ? indexLine(roadLine) : null);
  let hit = 0;
  for (const p of points) {
    const d = idx ? distanceToIndexed(p, idx) : distanceToLine(p, roadLine);
    if (d <= nearMeters) hit++;
  }
  return hit / points.length;
}

/**
 * 規制に重なっているおすすめ道路を探す。
 *
 * @param {Array} restrictions [{ id, name, kind, points }]
 * @param {Array} roads        [{ id, name, points }]
 * @returns {Map} 道のid → [{ restrictionId, name, kind, ratio }]
 */
function findOverlaps(restrictions, roads, options = {}) {
  const nearMeters = options.nearMeters ?? NEAR_METERS;
  const minRatio = options.minRatio ?? MIN_RATIO;
  const found = new Map();
  for (const road of roads) {
    if (!road.points || road.points.length < 2) continue;
    // ⚠️ **道ごとに1回だけ作ること。** 規制1件ごとに作り直すと元の木阿弥
    const idx = road.points.length > 2_000 ? indexLine(road.points) : null;
    const roadBox = boundsOf(road.points, 5000);
    for (const restriction of restrictions) {
      if (!restriction.points || restriction.points.length < 2) continue;
      // ⚠️ 先に大づかみで弾く。全部の点を測ると、県内150本×規制数で待たされる。
      //    ⚠️ **まず箱で弾く**（O(1)）。距離での足切りは経路の全点を測るので、
      //    長い経路では1件ごとに数十msかかる（実測: 1,509kmで11.5秒）
      const rBox = boundsOf(restriction.points, 0);
      if (!rBox || !roadBox || !boundsOverlap(rBox, roadBox)) continue;
      if (!idx && distanceToLine(restriction.points[0], road.points) > 5000) continue;
      const ratio = overlapRatio(restriction.points, road.points, nearMeters, idx);
      if (ratio < minRatio) continue;
      if (!found.has(road.id)) found.set(road.id, []);
      found.get(road.id).push({
        restrictionId: restriction.id,
        name: restriction.name,
        kind: restriction.kind,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  }
  return found;
}

/** 「そもそも通れない」規制の種別。二人乗り禁止・冬季閉鎖は条件次第で走れる */
const BLOCKING_KINDS = new Set(["noMotorcycle", "closed"]);

/**
 * 排気量の区切り。アプリの `BikeDisplacement.ccRange` と同じ
 * （`touringSpotShare/saveRoute/nav/BikeProfile.swift`）。
 * ⚠️ 片方だけ変えると、生成で落とす道とアプリが避ける道が食い違う
 */
const DISPLACEMENT_RANGES = [[0, 50], [51, 125], [126, 250], [251, 99_999]];

/** その規制が、この排気量の乗り手に当たるか。範囲が重なっていれば当たり */
function appliesToRange(restriction, [low, high]) {
  const min = Number.isFinite(restriction.minCc) ? restriction.minCc : 0;
  const max = Number.isFinite(restriction.maxCc) ? restriction.maxCc : 99_999;
  return low <= max && high >= min;
}

/**
 * どの排気量の乗り手でも通れない規制か。
 *
 * ⚠️ **おすすめ道路は排気量ごとに作り分けていない。** 1県につき1本の同じ一覧を
 *    全員に配る。だから生成の段で落としてよいのは「全員が通れない」規制だけ。
 *    原付だけ通れない道（小田原厚木道路・ターンパイク箱根・芦ノ湖スカイラインなど、
 *    神奈川県だけで324本）をここで落とすと、251ccの人のおすすめからも消える。
 *    排気量ごとの出し分けはアプリ側の仕事
 *    （`FunRoadRestrictionFilter` が `RoadRestriction.applies(to:)` で乗り手を見る）。
 */
function blocksEveryone(restriction) {
  return DISPLACEMENT_RANGES.every((range) => appliesToRange(restriction, range));
}

/**
 * いつでも効いている規制か（時間・曜日・月の指定が無い）。
 *
 * ⚠️ **時間限定の規制をおすすめから落としてはいけない。** 落とすと、
 *    1日23時間走れる道が丸ごと消える。実測: JARTIC の候補1,442件のうち
 *    **全員が通れないもの235件、そのうち90件が時間・曜日つき**
 *    （千葉の通学路規制「07:00〜08:00」など）。
 *    いま登録済みの時間つきは48件しかないので表面化していなかったが、
 *    JARTIC を入れると388件になる。
 *
 * ⚠️ **「効いている時間帯だけ避ける」のは経路を引くときの仕事**
 *    （`excludePolygons`）。おすすめ道路の一覧は時刻を持たないので、
 *    ここでは「いつ行っても通れない」ものだけを落とす。
 */
function blocksAlways(restriction) {
  if (!restriction) return false;
  if (restriction.activeHours) return false;
  if (Array.isArray(restriction.activeDays) && restriction.activeDays.length
      && restriction.activeDays.length < 7) return false;
  if (restriction.includesHoliday) return false;
  if (Array.isArray(restriction.activeMonths) && restriction.activeMonths.length
      && restriction.activeMonths.length < 12) return false;
  return true;
}

/**
 * 二輪が通れない規制と重なる、おすすめ道路の番号を返す。
 *
 * ⚠️ **おすすめ道路の区間は `points` を持っていない。** 持っているのは
 *    `polyline`（符号化した文字列）で、`points` は生成の途中でしか存在しない。
 *    そこを取り違えて `seg.points` を渡していたため、この除外は
 *    **一度も働いていなかった**（栃木で「0本除外」と出ていたのは、規制が
 *    重ならなかったのではなく空振りしていたから）。エラーは出ない。
 *    だからここで受け取って、この中で復号する。
 *
 * ⚠️ 落とすのは**全員が通れない**規制だけ（`blocksEveryone`）。理由はそちらに書いた。
 *
 * @param {Array} saved    data/road-restrictions/<romaji>.json の `restrictions`
 * @param {Array} segments おすすめ道路の区間（`polyline` を持つ形）
 * @returns {Map} 区間の番号 → [{ restrictionId, name, kind, ratio }]
 */
function blockedSegments(saved, segments) {
  const { decode } = require("./polyline");
  const restrictions = (saved || [])
    // ⚠️ **全員が・いつでも通れないものだけ落とす**（`blocksAlways` の説明を読むこと）
    .filter((r) => r && BLOCKING_KINDS.has(r.kind) && r.polyline
                     && blocksEveryone(r) && blocksAlways(r))
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, points: decode(r.polyline) }))
    .filter((r) => r.points.length >= 2);
  if (!restrictions.length) return new Map();

  const roads = (segments || []).map((seg, index) => ({
    id: index,
    name: seg.name,
    // 生成の途中では `points`、書き出したあとは `polyline`。どちらでも受ける
    points: seg.points || (seg.polyline ? decode(seg.polyline) : null),
  }));
  return findOverlaps(restrictions, roads);
}

/**
 * 経路が規制線の上を**連続して走った**距離のうち、いちばん長いもの（m）。
 *
 * ⚠️ 合計ではなく連続を見る。交差点で何度も横切る道と、一度まとまって走る道を
 *    同じ扱いにしないため。
 */
function longestRunOnLine(routePoints, linePoints, nearMeters = NEAR_METERS) {
  // ⚠️ **打ち直してから測ること。** 経路の点は間隔がまちまちで、粗いところでは
  //    1区間まるごとが「近い」と数えられて**実際の3倍**になる
  //    （実測: 同じ直角の横切りが、点の間隔22mで67m・222mで222m）。
  const pts = resample(routePoints, STEP_METERS);
  // ⚠️ **規制線の近くだけ測ること。** 経路の全点×規制の全点を測ると、
  //    1,509kmの経路で1件あたり90msかかる（実測）。
  //    箱の外は「近くない」と決まっているので測らなくてよい
  const box = boundsOf(linePoints, nearMeters + STEP_METERS * 2);
  let best = 0, run = 0;
  for (let i = 1; i < pts.length; i++) {
    if (box && !inBounds(pts[i], box)) { run = 0; continue; }
    if (distanceToLine(pts[i], linePoints) <= nearMeters) {
      run += distanceMeters(pts[i - 1], pts[i]);
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * 経路のうち、規制線の上を走っている範囲（**元の経路の添字**）。
 *
 * ⚠️ **添字は打ち直す前のものを返すこと。** 画面はこの範囲で線を塗り分けるので、
 *    打ち直した点の番号を返すと**別の場所に赤が出る**。
 *    測るとき（`longestRunOnLine`）だけ打ち直す。
 */
function spansOnLine(routePoints, linePoints, nearMeters = NEAR_METERS) {
  const spans = [];
  let begin = -1;
  for (let i = 0; i < routePoints.length; i++) {
    const on = distanceToLine(routePoints[i], linePoints) <= nearMeters;
    if (on && begin < 0) begin = i;
    if (!on && begin >= 0) { spans.push({ begin, end: i - 1 }); begin = -1; }
  }
  if (begin >= 0) spans.push({ begin, end: routePoints.length - 1 });
  // ⚠️ 1点だけの範囲は線にならない。捨てる
  return spans.filter((s) => s.end > s.begin);
}

module.exports = {
  findOverlaps, overlapRatio, resample, distanceToLine, blockedSegments,
  longestRunOnLine, spansOnLine, ROUTE_RUN_METERS,
  blocksEveryone, blocksAlways, appliesToRange,
  NEAR_METERS, STEP_METERS, MIN_RATIO, BLOCKING_KINDS, DISPLACEMENT_RANGES,
};
