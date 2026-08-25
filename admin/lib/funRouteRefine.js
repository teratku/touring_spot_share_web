/**
 * funRouteRefine.js
 *
 * 実際に引いた経路を見て、**Uターンを起こすおすすめ道路を外す**。
 *
 * 【なぜ選ぶ側で防げないか】
 * ⚠️ `funRouteSelect.js` の後退チェックは、出発地→目的地の**直線**の上で見ている。
 *    Uターンは道そのものの都合（行き止まり・中央分離帯・一方通行）で起きるので、
 *    直線の幾何では見えない。**実際に引いてみるまで分からない。**
 *
 * ⚠️ **「点数の低いものから外す」では当たらない。** 一度それで試したが、
 *    Uターンを起こしているのが点数最高の道だったため、1本まで減らしても
 *    Uターンが消えなかった。**1本ずつ抜いて、実際に消えるものを探す。**
 *
 * 【実測（新座→愛川・たっぷり4本）】
 *     そのまま           82.5km Uターン2回
 *     競馬場通りを抜く    76.8km Uターン2回
 *     浅川相模湖線を抜く  75.6km Uターン1回  ← これ
 *     三井相模湖線を抜く  71.5km Uターン1回
 *     鳥屋川尻線を抜く    80.5km Uターン2回
 *   1本抜くごとに1つ減る。減らなくなるまで繰り返す。
 *
 * ⚠️ **経路を引く処理は外から渡す。** ここでネットワークを叩かない
 *    （テストで実際の Valhalla を立てずに確かめられるようにするため）。
 */
"use strict";

const { waypointsFor, selectFunRoads, distance } = require("./funRouteSelect");

/**
 * Uターンの原因になった道を、**1回引いた結果から**突き止める。
 *
 * ⚠️ **Uターンは経由地のところで起きる。** 実測11件すべてで、いちばん近い経由地は
 *    その道の**出口**だった。距離は 0m が4件・17m が3件・125m が1件・965m が2件で、
 *    そこから次は 15.7km まで飛ぶ。**2,000m で切れば、当てになる分だけ拾える。**
 *
 * ⚠️ 遠すぎるものは**当てずっぽうにしない。** 呼び出し側が1本ずつ抜いて確かめる。
 *
 * @returns {Array} 原因と見なした道（重複なし）
 */
function blameForUTurns(route, segments, origin, destination, withinMeters = BLAME_WITHIN_METERS) {
  if (!route || route.error || !route.uTurns) return [];
  const wps = waypointsFor(segments, origin, destination);
  const blamed = new Map();
  for (const step of route.steps || []) {
    if (!String(step.maneuver).startsWith("uturn")) continue;
    const at = (route.points || [])[step.beginIndex];
    if (!at) continue;
    let best = -1, bestMeters = Infinity;
    wps.forEach((w, k) => {
      const d = distance(w, at);
      if (d < bestMeters) { bestMeters = d; best = k; }
    });
    if (best < 0 || bestMeters > withinMeters) continue;   // 遠いものは決めつけない
    const seg = segments[Math.floor(best / 2)];
    if (seg) blamed.set(seg.id, seg);
  }
  return [...blamed.values()];
}

//: 経由地からこれ以上離れたUターンは、その道のせいと決めつけない（m）
const BLAME_WITHIN_METERS = 2_000;

/**
 * Uターンを起こす道を外していく。
 *
 * @param {Array} segments   通したいおすすめ道路（並び順は決まっているもの）
 * @param {[number,number]} origin       [経度, 緯度]
 * @param {[number,number]} destination  [経度, 緯度]
 * @param {(vias:Array)=>Promise<object>} routeFn  経由地を渡すと経路を返す関数
 * @param {object} opts
 *   - maxDrops  何本まで外すか（既定: 全部）
 * @returns {{segments, route, dropped, calls}}
 */
async function dropUTurnRoads(segments, origin, destination, routeFn, opts = {}) {
  const maxDrops = opts.maxDrops ?? segments.length;
  let remaining = segments.slice();
  let calls = 0;

  let route = await routeFn(waypointsFor(remaining, origin, destination));
  calls++;
  const dropped = [];

  // --- ① 1回引いた結果から原因を突き止めて、まとめて外す ---
  //
  // ⚠️ **ここが効けば、引き直しは1回で済む。** 1本ずつ抜いて試すと
  //    「本数＋1」回引くことになり、案が3つあると十数回になる。
  while (route && !route.error && route.uTurns > 0
         && remaining.length > 0 && dropped.length < maxDrops) {
    const blame = blameForUTurns(route, remaining, origin, destination);
    if (!blame.length) break;
    const ids = new Set(blame.map((s) => s.id));
    const rest = remaining.filter((s) => !ids.has(s.id));
    const trial = await routeFn(waypointsFor(rest, origin, destination));
    calls++;
    // ⚠️ 減らないなら、突き止め方が外れている。②へ落とす
    if (!trial || trial.error || trial.uTurns >= route.uTurns) break;
    dropped.push(...blame);
    remaining = rest;
    route = trial;
  }

  // --- ② それでも残るなら、1本ずつ抜いて確かめる（まれ） ---
  while (route && !route.error && route.uTurns > 0
         && remaining.length > 0 && dropped.length < maxDrops) {
    let best = null;
    for (let i = 0; i < remaining.length; i++) {
      const rest = remaining.filter((_, j) => j !== i);
      const trial = await routeFn(waypointsFor(rest, origin, destination));
      calls++;
      if (!trial || trial.error) continue;
      // ⚠️ Uターンがいちばん減るものを選ぶ。同じだけ減るなら**点数の低い方**を捨てる
      const better = !best
        || trial.uTurns < best.route.uTurns
        || (trial.uTurns === best.route.uTurns && remaining[i].score < best.seg.score);
      if (better) best = { seg: remaining[i], rest, route: trial };
    }
    // ⚠️ 減らないなら諦める。**外し続けて道が全部消えるのを防ぐ**
    //    （Uターンが道のせいでないこともある）
    if (!best || best.route.uTurns >= route.uTurns) break;
    dropped.push(best.seg);
    remaining = best.rest;
    route = best.route;
  }
  // ⚠️ **外したぶんを埋め直す。** そのままだと本数が減りっぱなしになり、
  //    「ひかえめが1本だけ」のようになる。外した道を候補から除いて選び直し、
  //    **Uターンが増えないなら**そちらを採る
  if (dropped.length && opts.refill !== false && Array.isArray(opts.pool)) {
    // ⚠️ **選び直しは、その案の選び方のままで行うこと。**
    //    どの案も同じ条件で選び直すと、たっぷり・ひかえめ・別ルートが
    //    同じ顔ぶれに揃ってしまい、**案が1通りに潰れる**（実際にそうなった）。
    const pickOptions = opts.pickOptions || {};
    const banned = new Set(dropped.map((s) => s.id));
    for (const id of pickOptions.excludeIds || []) banned.add(id);
    const pool = opts.pool.filter((s) => !banned.has(s.id));
    const again = selectFunRoads(origin, destination, pool, {
      count: pickOptions.count ?? opts.count ?? segments.length,
      budgetRatio: pickOptions.budgetRatio ?? opts.budgetRatio,
      corridorScale: pickOptions.corridorScale,
    });
    if (again && again.segments.length > remaining.length) {
      const trial = await routeFn(again.waypoints);
      calls++;
      if (trial && !trial.error && trial.uTurns <= (route ? route.uTurns : 0)) {
        return { segments: again.segments, route: trial, dropped, calls, refilled: true };
      }
    }
  }
  return { segments: remaining, route, dropped, calls, refilled: false };
}

module.exports = { dropUTurnRoads, blameForUTurns, BLAME_WITHIN_METERS };
