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

const { routeWithValhalla } = require("../../admin/lib/valhallaRoute");
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
async function buildRouteResponse(body, deps = {}) {
  const { from, to, vias, variant, displacement, avoidHighways, avoidTolls,
          arriveOnNearSide, roadNameStyle, announce, guidance,
          at, isHoliday, stopAt } = body || {};
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!ok(from) || !ok(to)) {
    return { status: 400, body: { error: "from / to は [経度, 緯度] で要ります" } };
  }

  let route;
  try {
    route = await routeWithValhalla(from, to, {
      vias: Array.isArray(vias) ? vias : [],
      // ⚠️ **止まる場所（立ち寄り先）の番号。** ここが空だと経由地が全部
      //    「通るだけ」になり、着いても知らせられない
      stopAt: Array.isArray(stopAt) ? stopAt : [],
      variant: variant || "normal",
      displacement, avoidHighways, avoidTolls, arriveOnNearSide, roadNameStyle,
      withRoadClass: false,
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
    prefecture: step.prefecture || null,
    distanceMeters: step.distanceMeters,
    durationSeconds: step.durationSeconds,
    isCurvyAhead: !!step.isCurvyAhead,
    roadKind: step.roadKind,
    beginIndex: step.beginIndex,
    endIndex: step.endIndex,
    // ⚠️ **番号で決めないこと。** 最後の1つだけを終点にすると、途中の
    //    立ち寄り先が「着いた」にならず、アプリが何も言わない（実機で報告）。
    //    区間の切れ目は `valhallaRoute.js` が印を付けている
    isLegEnd: step.isLegEnd === true || i === route.steps.length - 1,
  }));

  return {
    status: 200,
    body: {
      route: {
        totalDistanceMeters: route.lengthMeters,
        totalDurationSeconds: route.durationSeconds,
        // ⚠️ **5桁で返す。** Valhalla の6桁のまま渡すと座標が10倍ずれる
        polyline: encodePolyline(route.points),
        steps,
        uTurns: route.uTurns,
        ferryMeters: route.ferryMeters,
        arrivedSide: route.arrivedSide,
        // ⚠️ **避けきれなかった規制は必ず返す。** 黙って通させない
        restrictionTries: route.restrictionTries,
        restrictionHits: route.restrictionHits,
        restrictionSkipped: route.restrictionSkipped,
        restrictionPrefectures: route.restrictionPrefectures,
      },
      guidance: guidance === false ? undefined : simulate({ steps }, { announce }),
      announce: normalizedAnnounce(announce),
      // ⚠️ **消さないこと。** OSM の ODbL と JARTIC の規約が求めている
      attribution: ATTRIBUTION,
    },
  };
}

module.exports = { buildRouteResponse };
