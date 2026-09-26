"use strict";
/**
 * 区間ごとに有料・高速の条件が違うルートを、Valhalla で引く。
 *
 * 【なぜ要るか】
 * ⚠️ Valhalla は1回の問い合わせで1組の条件（`use_tolls` / `use_highways`）しか受け取らない。
 *    アプリの「区間ごとの有料・下道」は区間ごとに条件が違うので、これまでは
 *    Google で引いていた。利用者の判断（2026-09-16）で**ナビは Valhalla 一択**にするため、
 *    条件の同じまとまりごとに引いて、ここで1本につなぐ。
 *
 * 【つなぎ方】
 * ・まとまりごとに `routeWithValhalla` をそのまま呼ぶ。規制の回避・船の回避・
 *   無駄な輪の除去などは、まとまりの中でいつもどおり効く。
 * ・結果は点の番号で持っているので、**番号をずらしてつなぐ**。
 * ・⚠️ **条件の切り替え地点は立ち寄り先ではない。** そこで前のまとまりの「到着」と
 *   次のまとまりの「出発（〇〇方向です）」が生まれるので、到着は消し、出発は前の
 *   走る指示に足す。消さないと、切り替え地点で「目的地付近です」「直進します」と言う。
 * ・⚠️ **切り替え地点で折り返させない。** 次のまとまりは、前のまとまりの最後の向きで
 *   出発させる（引き直しと同じ `heading`）。向きで縛って引けなければ、縛らずに引く。
 * ・⚠️ 切り替え地点が**立ち寄り先と重なる**ときは、到着と出発をそのまま残す。
 */
const { routeWithValhalla } = require("./valhallaRoute");
const { encode } = require("./polyline");

/** 到着の指示（Valhalla の 4/5/6） */
const ARRIVAL_TYPES = new Set([4, 5, 6]);
/** 出発の指示（Valhalla の 1/2/3） */
const DEPARTURE_TYPES = new Set([1, 2, 3]);

const same = (a, b) => !!a.avoidTolls === !!b.avoidTolls && !!a.avoidHighways === !!b.avoidHighways;

/**
 * 区間を、条件の同じまとまりに分ける。
 *
 * 点の番号: -1 = 出発地、0〜n-1 = 経由地、n = 目的地。区間 i は点 i-1 から点 i まで。
 * @param {Array<{avoidTolls:boolean, avoidHighways:boolean}>} legConditions 区間ごとの条件（経由地の数＋1）
 * @returns {Array<{firstLeg:number, lastLeg:number, avoidTolls:boolean, avoidHighways:boolean}>}
 */
function splitRuns(legConditions) {
  const runs = [];
  (legConditions || []).forEach((c, i) => {
    const last = runs[runs.length - 1];
    if (last && same(last, c)) last.lastLeg = i;
    else runs.push({ firstLeg: i, lastLeg: i, avoidTolls: !!c.avoidTolls, avoidHighways: !!c.avoidHighways });
  });
  return runs;
}

/** 区間ごとに条件が違うか */
function hasMixedConditions(legConditions) {
  return splitRuns(legConditions).length > 1;
}

/** 線の最後の向き（度）。同じ点が続くときは飛ばす */
function endBearing(points) {
  for (let i = points.length - 1; i > 0; i--) {
    const [lon2, lat2] = points[i];
    const [lon1, lat1] = points[i - 1];
    if (lon1 === lon2 && lat1 === lat2) continue;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  return null;
}

/**
 * まとまりごとの結果を1本につなぐ。
 * @param {object[]} parts `routeWithValhalla` の結果（まとまりの順）
 * @param {boolean[]} stopAfter まとまり k の終わりが立ち寄り先か（長さは parts.length - 1）
 * @param {object[]} [runs] まとまりの条件（`splitRuns` の結果）。避けられなかった有料を数えるのに使う
 */
function mergeRuns(parts, stopAfter, runs) {
  const points = [];
  const steps = [];
  const kindSpans = [];
  const wastefulLoopSpans = [];
  let classSpans = [];
  const shift = (sp, offset) => ({ ...sp, begin: sp.begin + offset, end: sp.end + offset });

  parts.forEach((part, k) => {
    // ⚠️ **先頭の点は前の終点と同じ。** 足さないぶん、番号を1つ手前へずらす
    const offset = k === 0 ? 0 : points.length - 1;
    points.push(...(k === 0 ? part.points : part.points.slice(1)));
    let own = part.steps.map((s) => ({ ...s, beginIndex: s.beginIndex + offset, endIndex: s.endIndex + offset }));

    if (k > 0 && !stopAfter[k - 1]) {
      // 前のまとまりの「到着」を消す（切り替え地点は着く場所ではない）
      const tail = steps[steps.length - 1];
      if (tail && ARRIVAL_TYPES.has(tail.valhallaType)) steps.pop();
      // 次のまとまりの「出発」を、前の走る指示へ足す
      const head = own[0];
      const prev = steps[steps.length - 1];
      if (head && prev && DEPARTURE_TYPES.has(head.valhallaType)) {
        const longer = (head.distanceMeters || 0) > (prev.distanceMeters || 0) ? head : prev;
        steps[steps.length - 1] = {
          ...prev,
          endIndex: head.endIndex,
          distanceMeters: (prev.distanceMeters || 0) + (head.distanceMeters || 0),
          durationSeconds: (prev.durationSeconds || 0) + (head.durationSeconds || 0),
          tollMeters: (prev.tollMeters || 0) + (head.tollMeters || 0),
          expresswayMeters: (prev.expresswayMeters || 0) + (head.expresswayMeters || 0),
          // ⚠️ 道の種別は長く走るほうに合わせる（1つの指示に1つしか持てない）
          roadKind: longer.roadKind,
          isCurvyAhead: !!(prev.isCurvyAhead || head.isCurvyAhead),
        };
        own = own.slice(1);
      }
    }
    steps.push(...own);
    kindSpans.push(...(part.kindSpans || []).map((sp) => shift(sp, offset)));
    wastefulLoopSpans.push(...(part.wastefulLoopSpans || []).map((sp) => shift(sp, offset)));
    // 道路クラスの区間は、どれか1つでも取れていなければ出さない（中途半端に塗らない）
    if (classSpans && Array.isArray(part.classSpans)) classSpans.push(...part.classSpans.map((sp) => shift(sp, offset)));
    else classSpans = null;
  });

  const sum = (key) => parts.reduce((a, p) => a + (Number(p[key]) || 0), 0);
  const uniqueById = (list) => {
    const seen = new Set();
    return list.filter((x) => {
      const id = x && (x.id || JSON.stringify(x));
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const last = parts[parts.length - 1];
  const kindMeters = kindSpans.length
    ? kindSpans.reduce((acc, sp) => { acc[sp.kind] += sp.meters; return acc; },
                       { expressway: 0, toll: 0, surface: 0 })
    : steps.reduce((acc, x) => { acc[x.roadKind] += x.distanceMeters; return acc; },
                   { expressway: 0, toll: 0, surface: 0 });
  return {
    ...last,
    // ⚠️ まとまりごとに実際に効いた設定を残す（画面・調べもの用）
    costingOptions: parts.map((p) => p.costingOptions),
    segments: parts.length,
    highwayTries: sum("highwayTries"),
    ferryTries: sum("ferryTries"),
    ferryMeters: sum("ferryMeters"),
    restrictionTries: sum("restrictionTries"),
    restrictionHits: uniqueById(parts.flatMap((p) => p.restrictionHits || [])),
    restrictionSkipped: uniqueById(parts.flatMap((p) => p.restrictionSkipped || [])),
    restrictionPrefectures: [...new Set(parts.flatMap((p) => p.restrictionPrefectures || []))],
    // ⚠️ **避けきれなかったスマートIC はまとまりごとに足し合わせること。** `...last` のままだと
    //    前のまとまりで通るスマートICを黙って落とす（ETCが無いと出入りできない）
    ...(parts.some((p) => Array.isArray(p.etcOnlyIcs)) ? {
      etcOnlyTries: sum("etcOnlyTries"),
      etcOnlyIcs: [...new Set(parts.flatMap((p) => p.etcOnlyIcs || []))],
    } : {}),
    lengthMeters: sum("lengthMeters"),
    durationSeconds: steps.reduce((a, s) => a + (Number(s.durationSeconds) || 0), 0),
    timeAdjust: parts.reduce((acc, p) => {
      for (const [key, value] of Object.entries(p.timeAdjust || {})) {
        if (typeof value === "number") acc[key] = (acc[key] || 0) + value;
      }
      return acc;
    }, {}),
    points,
    polyline: encode(points),
    steps,
    uTurns: steps.filter((s) => String(s.maneuver).startsWith("uturn")).length,
    wastefulLoops: sum("wastefulLoops"),
    wastefulLoopsDropped: sum("wastefulLoopsDropped"),
    wastefulLoopSpans,
    // ⚠️ **経由地をずらした記録は、まとまりごとに足し合わせること。** `...last` のままだと
    //    最後のまとまりの分しか残らず、アプリが前のまとまりのマーカーを元の位置に描く。
    //    `via` はまとまりの中の番号なので、アプリは `from`（元の座標）で突き合わせる
    viaLoops: {
      found: parts.reduce((a, p) => a + ((p.viaLoops && p.viaLoops.found) || 0), 0),
      left: parts.reduce((a, p) => a + ((p.viaLoops && p.viaLoops.left) || 0), 0),
      fixes: parts.flatMap((p) => (p.viaLoops && p.viaLoops.fixes) || []),
      redraws: parts.reduce((a, p) => a + ((p.viaLoops && p.viaLoops.redraws) || 0), 0),
    },
    falseExitsMerged: sum("falseExitsMerged"),
    classSpans,
    // ⚠️ **有料を避けるまとまりの分だけ数える。** `routeWithValhalla` は避けたかどうかに
    //    関わらず有料の距離を返すので、そのまま足すと、有料を使ってよい区間の有料まで
    //    「避けられなかった」ことになり、アプリが有料を禁止して引き直してしまう
    tollUnavoidableMeters: parts.reduce((a, p, k) =>
      a + (!runs || runs[k].avoidTolls ? (Number(p.tollUnavoidableMeters) || 0) : 0), 0),
    classMeters: (classSpans || []).reduce((acc, sp) => {
      acc[sp.roadClass] = (acc[sp.roadClass] || 0) + sp.meters;
      return acc;
    }, {}),
    kindSpans,
    kindMeters,
    // ⚠️ 区間ごとの問い合わせでは別の道は頼まない（立ち寄り先がある形なので返らない）
    alternates: [],
  };
}

/**
 * 区間ごとに条件が違うルートを引く。条件がそろっていれば、いつもの引き方と同じ。
 *
 * @param opts `routeWithValhalla` と同じ。加えて `legConditions`（区間ごとの条件）
 */
async function routeWithValhallaSegmented(from, to, opts = {}) {
  const vias = Array.isArray(opts.vias) ? opts.vias : [];
  const conditions = Array.isArray(opts.legConditions) ? opts.legConditions : [];
  const { legConditions, ...rest } = opts;
  // ⚠️ **数が合わなければ区間ごとには引かない。** ずれた条件で引くと、
  //    利用者が避けたい区間で有料・高速に乗せることになる
  if (conditions.length !== vias.length + 1 || !hasMixedConditions(conditions)) {
    return withHeadAlternates(await routeWithValhalla(from, to, rest), from, to, rest);
  }
  const runs = splitRuns(conditions);
  const stopAt = Array.isArray(opts.stopAt) ? opts.stopAt : [];
  // ⚠️ **番号を振り直すこと。** まとまりごとに経由地を切り出すので、
  //    元の番号のまま渡すと**別の立ち寄り先**が通り抜けになる
  const throughStopAt = Array.isArray(opts.throughStopAt) ? opts.throughStopAt : [];
  const viaHeadings = Array.isArray(opts.viaHeadings) ? opts.viaHeadings : [];
  const pointAt = (i) => (i < 0 ? from : i >= vias.length ? to : vias[i]);

  const parts = [];
  let heading = opts.heading;
  for (const [r, run] of runs.entries()) {
    const inner = [];
    const innerStops = [];
    const innerThrough = [];
    const innerHeadings = [];
    for (let p = run.firstLeg; p < run.lastLeg; p++) {
      inner.push(vias[p]);
      innerHeadings.push(viaHeadings[p]);
      if (stopAt.includes(p)) innerStops.push(inner.length - 1);
      if (throughStopAt.includes(p)) innerThrough.push(inner.length - 1);
    }
    const isLast = r === runs.length - 1;
    const runOpts = {
      ...rest,
      vias: inner,
      stopAt: innerStops,
      throughStopAt: innerThrough,
      viaHeadings: innerHeadings,
      avoidTolls: run.avoidTolls,
      avoidHighways: run.avoidHighways,
      // ⚠️ **有料の禁止は、有料を避けるまとまりにだけ効かせる。** 使ってよい区間まで
      //    塞ぐと、利用者が選んだ有料道路を通らない遠回りになる
      excludeTolls: run.avoidTolls ? rest.excludeTolls : false,
      heading,
      // ⚠️ 最初のまとまりだけ、呼んだ側の許容角を使う（引き直しの向き）
      headingTolerance: r === 0 ? opts.headingTolerance : undefined,
      // ⚠️ **着く側の寄せは最後だけ。** 切り替え地点で寄せると、そこへ回り込む遠回りになる
      arriveOnNearSide: isLast ? opts.arriveOnNearSide : false,
      alternates: 0,
    };
    const start = pointAt(run.firstLeg - 1);
    const end = pointAt(run.lastLeg);
    let part = await routeWithValhalla(start, end, runOpts);
    if ((!part || part.error) && r > 0 && Number.isFinite(heading)) {
      // 向きで縛って引けなかった。縛らずにもう一度
      part = await routeWithValhalla(start, end, { ...runOpts, heading: undefined });
    }
    if (!part || part.error) return part || { error: "経路が引けません" };
    parts.push(part);
    heading = endBearing(part.points);
  }
  const stopAfter = runs.slice(0, -1).map((run) => stopAt.includes(run.lastLeg));
  return mergeRuns(parts, stopAfter, runs);
}

/**
 * 経由地（立ち寄り先・おすすめ道路）がある経路に、**最初の経由地までの行き方違い**を足す。
 *
 * ⚠️ **Valhalla は経由地があると代替を返さない**（2点のときだけ）。利用者の要望（2026-09-26）:
 *    「ルートが1つしか出ないことがある。おすすめ道路でも複数出てほしい」。
 *    実測（新座から12か所・行き先1つ）: 代替は24回中22回返る（候補の平均 2.6〜2.9本）。
 *    1本になるのは経由地があるとき（おすすめ道路を行き先にすると入口・中継点が経由地になる）。
 * 【作り方】最初の経由地まで（2点）を代替つきで引き、最初の経由地から先を1回引いて、
 *    代替ごとにつなぐ（`mergeRuns`。区間ごとの条件と同じつなぎ方）。
 * ⚠️ **最初の経由地へは本命と同じ向きで着かせる**（`toHeading`）。つないだ先は、その向きで出発する
 * ⚠️ **つないだ先が本命と食い違ったら足さない。** 最初の経由地から出発させると、別の道に吸い付くことがある
 *    （実測・高崎神流秩父線: 入口から先が林道東御荷鉾線6.2km・123分を通り、代替が本命の2.3倍の時間になった）。
 *    入口までと入口から先の合計が本命より2割（＋2分）以上長ければ、本命だけ返す（`TAIL_SLACK`）
 * ⚠️ **本命より多くUターンする代替は落とす。** 入口の向きに合わせるため、入口を通り過ぎて
 *    戻ってくる代替がある（実測・犬掛館山線・甲府山梨線・御坂みち）
 * ⚠️ 引けなければ本命だけ返す（今までどおり）。区間ごとに条件が違う経路では足さない
 * @param main 経由地つきで引いた本命（`routeWithValhalla` の結果）
 * @param route 経路を引く関数（検査で差し替える）
 */
async function withHeadAlternates(main, from, to, opts = {}, route = routeWithValhalla) {
  const vias = Array.isArray(opts.vias) ? opts.vias : [];
  const want = Number(opts.alternates) || 0;
  if (!main || main.error || want <= 0 || !vias.length) return main;
  if (Array.isArray(main.alternates) && main.alternates.length) return main;
  const stopAt = Array.isArray(opts.stopAt) ? opts.stopAt : [];
  const throughStopAt = Array.isArray(opts.throughStopAt) ? opts.throughStopAt : [];
  const viaHeadings = Array.isArray(opts.viaHeadings) ? opts.viaHeadings : [];
  const later = (list) => list.filter((i) => Number.isInteger(i) && i > 0).map((i) => i - 1);
  const head = await route(from, vias[0], {
    ...opts, vias: [], stopAt: [], throughStopAt: [], viaHeadings: [],
    toHeading: viaHeadings[0],
    // ⚠️ 着く側の寄せは最後だけ（経由地で寄せると、そこへ回り込む遠回りになる）
    arriveOnNearSide: false,
    alternates: want,
  });
  if (!head || head.error || !Array.isArray(head.alternates) || !head.alternates.length) return main;
  const tail = await route(vias[0], to, {
    ...opts,
    vias: vias.slice(1), stopAt: later(stopAt), throughStopAt: later(throughStopAt),
    viaHeadings: viaHeadings.slice(1),
    // ⚠️ **最初の経由地で折り返させない。** 着いた向きのまま出発する
    heading: Number.isFinite(viaHeadings[0]) ? viaHeadings[0] : endBearing(head.points),
    headingTolerance: undefined,
    alternates: 0,
  });
  if (!tail || tail.error) return main;
  const seconds = (r) => Number(r.durationSeconds) || 0;
  if (seconds(head) + seconds(tail) > seconds(main) * TAIL_SLACK.ratio + TAIL_SLACK.seconds) return main;
  const stopAfter = [stopAt.includes(0)];
  const alternates = head.alternates
    .map((alt) => ({ ...mergeRuns([alt, tail], stopAfter), alternates: [] }))
    .filter((alt) => (alt.uTurns || 0) <= (main.uTurns || 0));
  return alternates.length ? { ...main, alternates } : main;
}
/** つないだ本命（入口まで＋入口から先）が、経由地つきの本命よりこれ以上長ければつながない */
const TAIL_SLACK = { ratio: 1.2, seconds: 120 };

module.exports = {
  routeWithValhallaSegmented, withHeadAlternates, mergeRuns, splitRuns, hasMixedConditions, endBearing,
  ARRIVAL_TYPES, DEPARTURE_TYPES,
};
