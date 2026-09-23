"use strict";
/**
 * viaLoops.js
 *
 * 経由地（道の入口・途中の点・道の終点）のまわりにできる輪（Uターン路）を見つけ、
 * **点の置き方で**ほどく。判断だけを持つ（引き直しは `valhallaRoute.js`）。
 *
 * 【なぜ起きるか】
 * Valhalla は経由地を**1つずつ順に**引き、通るだけの点（`through`）と道の終点
 * （`break_through`）では、前の区間が**着いた辺と向きのまま**次の区間を始める
 * （その場で向きを変えない）。だから前の区間が点の「裏側」から着くと、
 * 次の区間は先へ進んで回り込むしかなく、輪になる。
 *
 * 実機で報告（2026-09-23・ツーリング3＝国道286号→347号→398号）:
 *   「250cc以上だとUターン路は生成されないが125cc以下で生成されてしまう」
 * ⚠️ **原付で出やすいのは重みのせい。** 原付は法定速度（`top_speed`）より速い道に
 *    罰が掛かり、Valhalla は速度未登録の国道を88〜90km/hとみなすので、国道を避けて
 *    脇道から道の端に近づく。脇道は端の「裏側」に着きやすい。
 *    実測（ツーリング3）:
 *      125cc … 286号の終点 2,187m / 347号の入口 713m / 347号の終点 2,117m
 *      50cc  … 286号の入口 1,222m / 347号の入口 713m / 347号の途中 495m / 347号の終点 1,274m
 *      250cc以上 … 0本（国道13号・347号をそのまま走る）
 *
 * 【直し方（実測で決めた）】
 *   道の終点（`break_through`）
 *     ・**裏側から着いた**（着いた向きが道と逆）→ 道なりの向きを付ける。
 *       道を終点まで走って、そのまま先へ出る（347号の終点: 輪が消えて1.0km短く）
 *     ・**順向きに着いたが、次の行き先が後ろにある** → 戻り始める所の手前まで終点を切る
 *       （286号の終点: 400m手前の分岐で曲がる。⚠️ 向きを付けても消えなかった）
 *     ・**その場で折り返す行き止まり** → 触らない（引き返すしか無い。利用者の判断）
 *   通るだけの点（`through`）
 *     ・輪を抜けて道へ戻った所の少し先へずらす（347号の入口: 213mずらして消えた）
 *   実測（ツーリング3）: 125cc 555.4→551.5km・輪3→0 / 50cc 581.3→578.2km・輪4→0 /
 *   250cc 542.5km のまま（引き直し0回）
 *
 * ⚠️ **立ち寄り先（スポット・`break`）は触らない。** 寄って戻るのは自然な動き。
 * ⚠️ **ずらす距離に上限を置くこと。** 「短くなれば採る」だけだと、道を飛ばすほど得をする。
 *    実測（おすすめ道路から作ったプラン・兵庫）: 入口が谷の奥にあり、道を逆走して
 *    迎えに行く形で、点を2つ1.1kmずつずらしたら**その道を丸ごと走らない経路**が
 *    「短い」として採られた。上限（通る点300m・終点1,000mかつ道の半分）で止まる。
 */

const { distance } = require("./routeLoops");

/** 経由地が線の上にあるとみなす近さ（m）。⚠️ 道の上に置いた点なら実測0〜5m */
const LOCATE_METERS = 40;
/** 最初に近づいた所から、これだけ離れたら「その経由地を通った所」の探索を打ち切る（m） */
const LEAVE_METERS = 200;
/**
 * 「元の場所へ戻ってきた」とみなす近さ（m）。
 *
 * ⚠️ **広げないこと。** 60m（`routeLoops` の輪の見つけ方）にすると、並走する側道や
 *    分岐の手前を「戻った」と取り違え、切る場所が道の途中へずれる。
 */
const RETURN_METERS = 30;
/** これより短い輪は見ない（m）。交差点の中の小さな回り込みまで拾わない */
const MIN_LOOP_METERS = 150;
/**
 * これより長い輪は見ない（m）。
 *
 * ⚠️ **長いものは「点の置き方」では直らない。** 実測（おすすめ道路から作ったプラン18件）で
 *    5km近い輪は、道の入口を道そのものを逆走して迎えに行く形（利用者の選んだ向き）で、
 *    点をずらしても経路が1mも変わらなかった。向きの入れ替えはアプリが知らせる
 *    （`NavRoadDirection.reversedRoadIndices`）
 */
const MAX_LOOP_METERS = 5_000;
/**
 * 道の終点を出てから、これ以内に来た道へ戻り始めるなら「その場で折り返す行き止まり」（m）。
 *
 * ⚠️ **行き止まりは触らない**（利用者の判断: 引き返すしか無い場所では引き返してよい。
 *    `valhallaLive.test.js` の石廊崎）。
 * ⚠️ **戻り始めるまでの距離で見ること。** 「根元からいちばん遠い点」で見ると、
 *    286号の終点（輪の先端は終点から110m）を行き止まりと取り違えた。
 *    実測: 行き止まりでない終点は 622〜1,956m、その場で折り返す終点は 95〜291m
 */
const DEAD_END_METERS = 300;
/** ずらした点を、分岐からこれだけ離して置く（m）。⚠️ 交差点の真上は辺の選び方が揺れる */
const SHIFT_METERS = 30;
/** 着いた向きを測る長さ（m）。終点の手前このぶんの線の向き */
const ARRIVE_BACK_METERS = 40;
/** 道なりの向きとこれ以上違う向きで着いたら「裏側から着いた」（度） */
const WRONG_SIDE_DEGREES = 90;
/** 道なりの向きを測るのに要る、前の点から終点までの長さ（m）。⚠️ 近すぎると向きが暴れる */
const MIN_CHORD_METERS = 50;
/**
 * 通る点をずらしてよい距離（元の点からの直線・m）。
 *
 * ⚠️ 実測: 直したい輪は 190〜213m（ツーリング3の入口・途中）。上の兵庫の形は 1,092m・1,107m。
 *    300〜370mの形（岐阜の山道）は、ずらすと選んだ道の一部を飛ばしていた
 */
const MAX_MOVE_METERS = 300;
/** 道の終点を切ってよい距離（元の終点からの直線・m）。実測: 286号 561m */
const MAX_TRIM_METERS = 1_000;
/**
 * 道の終点を切ってよい割合（その道を走る長さに対して）。
 *
 * ⚠️ アプリの「端の切り落とし」（`NavRoadDirection.maxTrimRatio`）と同じ考え方:
 *    半分より多く切るなら、それは「その道を走る」と言えない
 */
const MAX_TRIM_RATIO = 0.5;
/** これだけ短くならなければ採らない（m）。⚠️ 形が同じまま点だけ動いた結果を採らない */
const MIN_GAIN_METERS = 50;
/**
 * 引き直しの上限（回）。
 *
 * ⚠️ 1回目はまとめて直し、採れなければ1つずつに切り替える（どれか1つが悪さを
 *    すると、まとめた全部が棄却されるため。実測: 50cc 山形のプラン）
 */
const MAX_REDRAWS = 4;
/** 付けた向きの許容角（度）。⚠️ 道の入口の向き（`viaHeadings`）と揃える */
const HEADING_TOLERANCE = 45;

/** 線に沿った累積距離（m） */
function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distance(points[i - 1], points[i]));
  return cum;
}

/** a から b への方位（度・真北から時計回り） */
function bearing(a, b) {
  const t = (x) => (x * Math.PI) / 180;
  const y = Math.sin(t(b[0] - a[0])) * Math.cos(t(b[1]));
  const x = Math.cos(t(a[1])) * Math.sin(t(b[1]))
    - Math.sin(t(a[1])) * Math.cos(t(b[1])) * Math.cos(t(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 2つの方位の差（0〜180度） */
function angleBetween(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** 線の k 番目から、線に沿って meters 進んだ（負なら戻った）点の番号 */
function pointAlong(cum, k, meters) {
  let x = k;
  if (meters < 0) {
    while (x > 0 && cum[k] - cum[x] < -meters) x--;
  } else {
    while (x < cum.length - 1 && cum[x] - cum[k] < meters) x++;
  }
  return x;
}

/**
 * 経由地ごとに、線のどこで通ったか（点の番号）。**前から順に**探す。
 *
 * ⚠️ **前の経由地より後ろだけを見ること。** 同じ場所を2回通る線（輪・往復）では、
 *    後ろの経由地の場所を行きがけに一度かすめる。
 * @returns 番号の配列。線から `LOCATE_METERS` より遠ければ null（間引かれた点など）
 */
function locateVias(points, vias, withinMeters = LOCATE_METERS) {
  const out = [];
  let from = 0;
  for (const via of vias) {
    let best = -1;
    let bestMeters = withinMeters;
    for (let i = from; i < points.length; i++) {
      const d = distance(points[i], via);
      if (d <= bestMeters) {
        bestMeters = d;
        best = i;
      } else if (best >= 0 && d > bestMeters + LEAVE_METERS) {
        break;                // 最初に近づいた所で決める
      }
    }
    out.push(best >= 0 ? best : null);
    if (best >= 0) from = best;
  }
  return out;
}

/** 点の番号を、近さで引ける升目に入れる */
function gridOf(points, indices, origin) {
  const kx = 111_320 * Math.cos((origin[1] * Math.PI) / 180);
  const ky = 110_540;
  const cell = RETURN_METERS;
  const key = (p) => `${Math.floor(((p[0] - origin[0]) * kx) / cell)}_${Math.floor(((p[1] - origin[1]) * ky) / cell)}`;
  const buckets = new Map();
  for (const i of indices) {
    const k = key(points[i]);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }
  /** p の近くにある点の番号 */
  return (p) => {
    const cx = Math.floor(((p[0] - origin[0]) * kx) / cell);
    const cy = Math.floor(((p[1] - origin[1]) * ky) / cell);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) out.push(...(buckets.get(`${cx + dx}_${cy + dy}`) || []));
    }
    return out;
  };
}

/**
 * 経由地（線の v 番目）を囲む輪。前後の経由地（lo, hi）のあいだだけを見る。
 *
 * - `base`   … 輪の根元。経由地より前で、あとで戻ってくる**いちばん手前**の点
 * - `back`   … `base` へ戻ってきた点
 * - `resume` … 経由地より前に通った場所へ戻ってくる**いちばん後ろ**の点（輪を抜けて道へ戻った所）
 * - `firstReturn` … 経由地を出てから、来た道へ初めて戻るまでの距離（行き止まりの見分け）
 * @returns 輪が無ければ null
 */
function loopAround(points, cum, v, lo, hi) {
  if (!(v > lo && v < hi)) return null;
  const idx = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; };
  const origin = points[v];
  const after = gridOf(points, idx(v + 1, hi), origin);
  const before = gridOf(points, idx(lo, v - 1), origin);
  const fits = (i, j) => {
    const along = cum[j] - cum[i];
    return along >= MIN_LOOP_METERS && along <= MAX_LOOP_METERS
      && distance(points[i], points[j]) <= RETURN_METERS;
  };

  let base = null;
  let back = null;
  for (let i = lo; i < v && base === null; i++) {
    for (const j of after(points[i])) {
      if (fits(i, j) && (back === null || j > back)) { base = i; back = j; }
    }
  }
  if (base === null) return null;

  let resume = back;
  for (let j = hi; j > v; j--) {
    if (before(points[j]).some((i) => fits(i, j))) { resume = j; break; }
  }

  let firstReturn = Infinity;
  for (let j = v + 1; j <= hi && cum[j] - cum[v] <= MAX_LOOP_METERS; j++) {
    if (before(points[j]).some((i) => fits(i, j))) { firstReturn = cum[j] - cum[v]; break; }
  }
  return { base, back, resume, firstReturn, meters: cum[back] - cum[base] };
}

/**
 * 経由地のまわりの輪を全部見つける。
 *
 * @param points 経路の線（[経度, 緯度]）
 * @param vias   経由地の位置（並び順どおり）
 * @param kinds  経由地の種別（`through` / `break` / `break_through`）
 */
function findViaLoops(points, vias, kinds) {
  const cum = cumulative(points);
  const at = locateVias(points, vias);
  const loops = [];
  for (let n = 0; n < vias.length; n++) {
    // ⚠️ 立ち寄り先（スポット）は寄って戻るのが自然。触らない
    if (kinds[n] === "break" || at[n] == null) continue;
    let lo = 0;
    for (let k = n - 1; k >= 0; k--) if (at[k] != null) { lo = at[k]; break; }
    let hi = points.length - 1;
    for (let k = n + 1; k < at.length; k++) if (at[k] != null) { hi = at[k]; break; }
    const loop = loopAround(points, cum, at[n], lo, hi);
    if (!loop) continue;
    loops.push({
      n, v: at[n], lo, hi, ...loop,
      deadEnd: kinds[n] === "break_through" && loop.firstReturn <= DEAD_END_METERS,
    });
  }
  return { loops, cum, at };
}

/**
 * 1つの輪の直し方を決める（純粋な判断）。
 *
 * @param loop `findViaLoops` の1件
 * @param ctx  { points, cum, at, kinds, vias, headings, tried }
 *             `tried` はその経由地で試した直し方（"heading" / "trim" / "move"）
 * @returns {{how: "heading", heading: number} | {how: "trim"|"move", point: number[]}
 *           | {how: null, why: string}}
 */
function remedyFor(loop, ctx) {
  const { points, cum, at, kinds, vias, headings, tried } = ctx;
  const n = loop.n;
  // ⚠️ **立ち寄り先は、ここでも触らない**（`findViaLoops` でも外している。二重の守り）。
  //    下の「通るだけの点」の扱いに落ちると、スポットを300mずらしてしまう
  if (kinds[n] === "break") return { how: null, why: "立ち寄り先" };
  if (loop.deadEnd) return { how: null, why: "行き止まり" };

  if (kinds[n] === "break_through") {
    // ⚠️ **裏側から着いたなら、切らずに向きを付ける。** 道を終点まで走れる
    //    （利用者の方針: 削らずに済むならそのほうがよい）
    const prev = n > 0 ? vias[n - 1] : null;
    const chord = prev && distance(prev, vias[n]) >= MIN_CHORD_METERS
      ? bearing(prev, vias[n]) : null;
    const k0 = pointAlong(cum, loop.v, -ARRIVE_BACK_METERS);
    const arrive = k0 < loop.v ? bearing(points[k0], points[loop.v]) : null;
    const wrongSide = chord !== null && arrive !== null
      && angleBetween(chord, arrive) > WRONG_SIDE_DEGREES;
    if (wrongSide && !tried.has("heading") && !Number.isFinite(headings[n])) {
      return { how: "heading", heading: chord };
    }
    if (tried.has("trim")) return { how: null, why: "切っても直らなかった" };
    // ⚠️ **戻り始める所（根元）の手前で止める。** 根元の上に置くと、分岐のどちらの
    //    辺に寄せるかが揺れて、また回り込む
    const k = pointAlong(cum, loop.base, -SHIFT_METERS);
    if (k <= loop.lo) return { how: null, why: "前の点より手前になる" };
    if (distance(points[k], vias[n]) > MAX_TRIM_METERS) return { how: null, why: "切りすぎ" };
    // その道を走る長さ（道の入口＝前の止まる場所の次の点から）
    let first = n;
    while (first > 0 && kinds[first - 1] === "through") first--;
    const start = at[first] != null ? at[first] : loop.lo;
    if (cum[loop.v] - cum[k] > (cum[loop.v] - cum[start]) * MAX_TRIM_RATIO) {
      return { how: null, why: "道の半分を超える" };
    }
    return { how: "trim", point: points[k] };
  }

  if (tried.has("move")) return { how: null, why: "ずらしても直らなかった" };
  const k = pointAlong(cum, loop.resume, SHIFT_METERS);
  if (k >= loop.hi) return { how: null, why: "次の点を越える" };
  if (distance(points[k], vias[n]) > MAX_MOVE_METERS) return { how: null, why: "ずらしすぎ" };
  return { how: "move", point: points[k] };
}

/**
 * 直し方を当てた経由地（Valhalla へ渡す形）。**元の入れ物は変えない。**
 *
 * @param location Valhalla の location（`{ lat, lon, type, heading?, heading_tolerance? }`）
 * @param remedy   `remedyFor` の結果（`how` が "heading" / "trim" / "move"）
 */
function applyRemedy(location, remedy) {
  const at = { ...location };
  if (remedy.how === "heading") {
    at.heading = remedy.heading;
    at.heading_tolerance = HEADING_TOLERANCE;
  } else {
    [at.lon, at.lat] = remedy.point;
    // ⚠️ **動かした点に元の向きを残さない。** 道の別の場所の向きになり、
    //    その向きで入れない点になる
    delete at.heading;
    delete at.heading_tolerance;
  }
  return at;
}

/**
 * 引き直した経路を採るか（純粋な判断）。
 *
 * ⚠️ **短くなり、輪が減り、船が増えないときだけ採る。**
 *    ・短くならない … 輪をほどいても遠回りになるなら、輪のほうがまし。
 *      ⚠️ 実測（おすすめ道路から作ったプラン・愛媛）: 引き直すと 147→218km、143→423km に
 *         なる形があった（原因は船の段が残した塞ぎ。点の置き方ではない）。長さで弾く
 *    ・輪が減らない … 点を動かしたのに、ほどけていない（別の輪を作った）
 *    ・船が増える … 「フェリーを避ける」を守る
 * @param before / after `{ meters, loops, ferryMeters }`
 * @param minGainMeters これだけ短くならなければ採らない。⚠️ 変えるのは検査だけ
 *        （`untangleMinGainMeters`。どの試しも採らない状態を作る）
 */
function shouldAccept(before, after, minGainMeters = MIN_GAIN_METERS) {
  return after.meters < before.meters - minGainMeters
    && after.loops < before.loops
    && after.ferryMeters <= before.ferryMeters;
}

module.exports = {
  cumulative, bearing, angleBetween, pointAlong, locateVias, loopAround, findViaLoops, remedyFor,
  applyRemedy, shouldAccept,
  LOCATE_METERS, RETURN_METERS, MIN_LOOP_METERS, MAX_LOOP_METERS, DEAD_END_METERS,
  SHIFT_METERS, ARRIVE_BACK_METERS, WRONG_SIDE_DEGREES, MIN_CHORD_METERS,
  MAX_MOVE_METERS, MAX_TRIM_METERS, MAX_TRIM_RATIO, MIN_GAIN_METERS, MAX_REDRAWS, HEADING_TOLERANCE,
};
