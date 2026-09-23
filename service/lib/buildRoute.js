/**
 * buildRoute.js
 *
 * 配信APIの応答を組み立てる（通信の入口とは切り離してある）。
 *
 * ⚠️ **express から切り出してあるのは、テストできるようにするため。**
 *    実際に叩くには Firebase の ID トークンが要り、手元では作れない
 *    （サービスアカウント鍵が無いと custom token に署名できない）。
 *    中身だけはここで確かめられるようにしておく。
 *
 * ⚠️ **判断は `admin/lib` のものをそのまま使う。** 複製しないこと。
 *    規制の見立て（排気量・時間・重なり）が2か所に分かれると必ずずれる。
 */
"use strict";

// ⚠️ **区間ごとに条件が違うときも Valhalla で引く**（ナビは Valhalla 一択）。
//    条件がそろっていれば、中で `routeWithValhalla` をそのまま呼ぶ
const { routeWithValhallaSegmented } = require("../../admin/lib/segmentedRoute");
const { simulate } = require("../../admin/lib/navSimulate");
const { normalized: normalizedAnnounce } = require("../../admin/lib/navGuide");
const { ATTRIBUTION } = require("../../admin/lib/restrictionOrigin");
const { encode: encodePolyline } = require("../../admin/lib/polyline");
const { toAppManeuver } = require("../../admin/lib/navManeuver");

/**
 * @param {object} body    受け取った依頼
 * @param {object} deps    { baseUrl, restrictionsFor }
 * @returns {{status:number, body:object}}
 */
/**
 * 引けた経路を、アプリが読める形にする。
 *
 * ⚠️ **代替ルートにも同じ形を使う。** 片方だけ直すと、選んだ候補によって
 *    出るものが変わる（有料の内訳・線の塗り分け・規制の警告）
 */
function toAppRoute(route) {
  const steps = route.steps.map((step, i) => ({
    // ⚠️ **アプリの生値に直して返すこと。** 中は camelCase、アプリの enum は
    //    kebab-case。そのまま渡すと `NavManeuver.from` が `.none` にして、
    //    **エラーも出ないまま曲がり角の案内が全部消える**（`lib/navManeuver.js`）
    maneuver: toAppManeuver(step.maneuver),
    instruction: step.instruction,
    roadName: step.roadName || null,
    spokenRoad: step.spokenRoad || null,
    roadNames: step.roadNames || [],
    intersectionName: step.intersectionName || null,
    // ⚠️ **標識の「〇〇方面」。** ここで詰め直すときに入れ忘れると、
    //    `admin/lib` が取り出していてもアプリには届かない（実際に抜けていた）
    towardNames: step.towardNames || [],
    // ⚠️ **Valhalla の種類番号。** アプリは出口（20/21）の見分けに使う。
    //    `maneuver` は出口も入口も `ramp-*` なので、これが無いと
    //    高速の出口で「左の入口に入ります」と言う
    valhallaType: step.valhallaType,
    prefecture: step.prefecture || null,
    distanceMeters: step.distanceMeters,
    durationSeconds: step.durationSeconds,
    isCurvyAhead: !!step.isCurvyAhead,
    // ⚠️ **曲がる場所に信号があるか。** 案内を「この交差点で〜」に変えるのに使う
    //    （信号の無い交差点は今までどおり）
    atSignal: !!step.atSignal,
    // ⚠️ **曲がったあとに走る道の車線数。** アプリは「2車線以上のときだけ
    //    車線を言う」判断に使う（1車線の道で「左車線へ」と言わないため）。
    //    ⚠️ OSM 由来なので入っていない道がある（実測: 浦和所沢バイパスは
    //    片側2車線だがデータ上は1）。無い・1のときは黙ること
    laneCount: Number.isInteger(step.laneCount) ? step.laneCount : null,
    roadKind: step.roadKind,
    //: **その指示のうち何mが有料か。** 指示の有料の旗は一部でも有料なら丸ごう立つ
    //  ので、画面の「通る道」が4倍に膨れていた（実測 6.8km → 28.4km）
    tollMeters: step.tollMeters,
    // ⚠️ 指示の `highway` の旗は一部でも立つ。実測: 27.2kmの指示のうち高速は9.2km
    expresswayMeters: step.expresswayMeters,
    beginIndex: step.beginIndex,
    endIndex: step.endIndex,
    // ⚠️ **番号で決めないこと。** 最後の1つだけを終点にすると、途中の
    //    立ち寄り先が「着いた」にならず、アプリが何も言わない（実機で報告）。
    //    区間の切れ目は `valhallaRoute.js` が印を付けている
    isLegEnd: step.isLegEnd === true || i === route.steps.length - 1,
  }));

  return {
        totalDistanceMeters: route.lengthMeters,
        totalDurationSeconds: route.durationSeconds,
        // ⚠️ **5桁で返す。** Valhalla の6桁のまま渡すと座標が10倍ずれる
        polyline: encodePolyline(route.points),
        steps,
        uTurns: route.uTurns,
        // ⚠️ **高速・有料・下道を分けたまま返すこと。** アプリはこれを読んで
        //    「有料」の札を出す。応答に入れ忘れていたため、自前エンジンでは
        //    その札が一度も出ていなかった（`ValhallaRouteService.hasTolls`）
        kindMeters: route.kindMeters,
        // ⚠️ **線を塗り分けるための本当の区間。** 指示の旗で塗ると、
        //    一部が高速なだけの国道まで高速の色になる（実機で報告）
        kindSpans: route.kindSpans,
        // ⚠️ **塞げずに残った「無駄な輪」の場所。** 経由地（おすすめ道路の出入口）が
        //    輪になっていると塞げないので、アプリが原因の道を外して組み立て直す
        wastefulLoopSpans: route.wastefulLoopSpans,
        //: **避けきれなかった有料の距離。** `use_tolls: 0` は重みであって禁止ではない
        //  ので、代替路が無ければ通る。⚠️ **黙って通させないために必ず返す**
        //  （実機で報告: 有料を避ける設定なのに雁坂トンネル6.8kmを通り、画面は無言だった）
        tollUnavoidableMeters: route.tollUnavoidableMeters,
        ferryMeters: route.ferryMeters,
        arrivedSide: route.arrivedSide,
        // ⚠️ **避けきれなかった規制は必ず返す。** 黙って通させない
        restrictionTries: route.restrictionTries,
        restrictionHits: route.restrictionHits,
        restrictionSkipped: route.restrictionSkipped,
        restrictionPrefectures: route.restrictionPrefectures,
  };
}

async function buildRouteResponse(body, deps = {}) {
  // ⚠️ `excludeTolls` を取り出し忘れないこと。下で渡しているのに取り出しておらず
  //    ReferenceError で窓口ごと500を返した前例がある（`stopAt` で同じことをやった）
  const { from, to, vias, variant, displacement, avoidHighways, avoidTolls, excludeTolls,
          avoidFerries, alternates,
          arriveOnNearSide, roadNameStyle, announce, guidance,
          at, isHoliday, stopAt, throughStopAt, heading, headingTolerance, viaHeadings,
          legConditions } = body || {};
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!ok(from) || !ok(to)) {
    return { status: 400, body: { error: "from / to は [経度, 緯度] で要ります" } };
  }

  // ⚠️ **区間ごとの条件は、形が正しいときだけ使う。** 崩れた値で区間ごとに引くと、
  //    避けたい区間で有料・高速に乗せることになる。使わないときは全体の条件で引く
  //    （アプリは全体の条件に「一番厳しい組み合わせ」を入れて送ってくる）
  const conditions = Array.isArray(legConditions)
    && legConditions.every((c) => c && typeof c === "object"
      && typeof c.avoidTolls === "boolean" && typeof c.avoidHighways === "boolean")
    ? legConditions.map((c) => ({ avoidTolls: c.avoidTolls, avoidHighways: c.avoidHighways }))
    : undefined;

  let route;
  try {
    // ⚠️ **区間ごとの条件が無ければ、いつもの引き方そのもの**（`routeWithValhallaSegmented` が委ねる）
    route = await routeWithValhallaSegmented(from, to, {
      legConditions: conditions,
      vias: Array.isArray(vias) ? vias : [],
      // ⚠️ **止まる場所（立ち寄り先）の番号。** ここが空だと経由地が全部
      //    「通るだけ」になり、着いても知らせられない
      stopAt: Array.isArray(stopAt) ? stopAt : [],
      // ⚠️ **おすすめ道路の終点。** 立ち寄るが、その場で引き返させない
      //    （`admin/lib/valhallaRoute.js` の `locationType` を読むこと）
      throughStopAt: Array.isArray(throughStopAt) ? throughStopAt.filter(Number.isInteger) : [],
      // ⚠️ **走っている向き。** 引き直しのときに渡すと、その場で向きを変えさせず
      //    そのまま進んで小道で回り込む経路になる（`lib/valhallaRoute.js`）
      heading, headingTolerance,
      // ⚠️ おすすめ道路の入口に「道に沿った向き」を渡すと、行って戻らず回り込む
      viaHeadings,
      variant: variant || "normal",
      displacement, avoidHighways, avoidTolls, excludeTolls,
      // ⚠️ **フェリーは既定で避ける。** 外すのは `false` を明示されたときだけ
      //    （古いアプリは渡してこない。渡さなければこれまでどおり避ける）
      avoidFerries: avoidFerries !== false,
      // ⚠️ **別の道も一緒に頼む。** 立ち寄り先があると返らない（Valhalla の性質）
      alternates: Number(alternates) || 0,
      arriveOnNearSide, roadNameStyle,
      // ⚠️ **車線数を取るために測る。** かつては通信を減らすため false にしていたが、
      //    「曲がったあとどの車線にいればよいか」を言うのに要る（実機の要望）。
      //    実測で増えるのは誤差のうち（11km: 128→78ms / 82km: 218→178ms・3回平均。
      //    Valhalla は同じコンテナの中なので往復が軽い）
      withRoadClass: true,
      baseUrl: deps.baseUrl,
      restrictionsFor: deps.restrictionsFor,
      // ⚠️ 渡さなければ時間の判断をしない（時間限定の規制も避ける＝避けすぎ側）
      at: at ? new Date(at) : undefined,
      isHoliday: !!isHoliday,
    });
  } catch (e) {
    return { status: 500, body: { error: e.message } };
  }
  if (!route || route.error) {
    return { status: 502, body: { error: (route && route.error) || "経路が引けません" } };
  }

  const app = toAppRoute(route);
  // ⚠️ **代替も同じ形にする。** 立ち寄り先があると Valhalla が返さないので空になる
  const alternateRoutes = (route.alternates || []).map(toAppRoute);

  return {
    status: 200,
    body: {
      route: app,
      //: 別の道（Google のように選ばせるため）。⚠️ 立ち寄り先があるときは空
      alternates: alternateRoutes,
      guidance: guidance === false ? undefined : simulate({ steps: app.steps }, { announce }),
      announce: normalizedAnnounce(announce),
      // ⚠️ **消さないこと。** OSM の ODbL と JARTIC の規約が求めている
      attribution: ATTRIBUTION,
    },
  };
}

module.exports = { buildRouteResponse };
