/*
 * plan-road-lib.js — Web のプラン画面（touring-plan.html）でおすすめ道路を出すための計算。
 *
 * 利用者の要望（2026-10-11）:「web でもおすすめ道路を表示したい」。
 * アプリがプランに入れたおすすめ道路（TouringSpot の isRoad・path・roadSection・roadId）を読む。
 * ⚠️ 以前は道も1つの点（ゴール）としか見ておらず、一覧に「📌 カスタムピン」、地図にゴールの点だけが出ていた。
 * ⚠️ **スポットの中身に書き足さないこと。** 並べ替え・削除は読み込んだスポットをそのまま Firestore に書き戻すので、
 *    画面のための値を足すと保存されてしまう。ここは描くときに計算する
 * ブラウザでは window.TSSPlanRoads、テスト（node）では module.exports
 */
(function (root) {
  "use strict";

  function ok(p) { return !!p && isFinite(p.lat) && isFinite(p.lng); }

  /** 通り道（[{lat, lng}]）。古い形 [[緯度, 経度]] も読む（route-maker-lib.toDestinations と同じ）。道でなければ空 */
  function roadPath(spot) {
    if (!spot || !spot.isRoad) return [];
    var path = (spot.path || []).map(function (p) {
      return Array.isArray(p) ? { lat: p[0], lng: p[1] } : { lat: p && p.lat, lng: p && p.lng };
    }).filter(ok);
    return path.length >= 2 ? path : [];
  }

  function isRoad(spot) { return roadPath(spot).length >= 2; }

  /** 2点の距離（m・球面） */
  function distance(a, b) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** 線の長さ（m） */
  function pathMeters(path) {
    var m = 0;
    for (var i = 1; i < path.length; i++) m += distance(path[i - 1], path[i]);
    return m;
  }

  /**
   * 一覧の行の説明（アプリの RoadSection.subtitle と同じ言い方）。道でなければ null。
   * 区間を選んでいれば「おすすめ道路・北の端 → 南の端（3.0km）」、道全体なら「おすすめ道路・全長 12.3km」
   */
  function roadSubtitle(spot) {
    if (!isRoad(spot)) return null;
    var s = spot.roadSection;
    if (s && s.entry && s.goal && isFinite(s.meters)) {
      return "おすすめ道路・" + s.entry + " → " + s.goal + "（" + (s.meters / 1000).toFixed(1) + "km）";
    }
    var dir = travelDirection(spot);
    // ⚠️ 区間の呼び名が無い道は、向き（「北から南へ」）を添える。無いと入れ替えても見た目が変わらない（利用者の要望 2026-10-14）
    return "おすすめ道路・全長 " + (pathMeters(roadPath(spot)) / 1000).toFixed(1) + "km" + (dir ? "（" + dir + "）" : "");
  }

  var COMPASS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  function compass(bearing) { return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]; }

  /** 入口 → 出口の向き（「北から南へ」）。入口と出口が近すぎる・道でなければ null */
  function travelDirection(spot) {
    var path = roadPath(spot);
    if (path.length < 2) return null;
    var a = path[0], b = path[path.length - 1];
    if (distance(a, b) < 300) return null;
    var toRad = Math.PI / 180;
    var y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
    var x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
    var bearing = Math.atan2(y, x) / toRad;
    return compass(bearing + 180) + "から" + compass(bearing) + "へ";
  }

  /**
   * おすすめ道路の入口と出口を入れ替えたスポット（アプリの TouringSpot.reversedRoad と同じ。Firestore にそのまま書ける形）。
   * ⚠️ 通り道（path）ごと裏返し、lat/lng を新しい出口に、区間の呼び名（roadSection）の入口・出口を入れ替え、
   *    利用者が向きを決めた印（directionByUser）を付ける（付けないとアプリのルート生成が勝手に向きを戻そうとする）。
   * ⚠️ 通り道の点の形（{lat,lng} か古い [緯度, 経度]）は変えない。道でなければそのまま返す
   */
  function reversedPlanSpot(spot) {
    var path = roadPath(spot);
    if (path.length < 2) return spot;
    var goal = path[0];
    var copy = Object.assign({}, spot, { path: spot.path.slice().reverse(), lat: goal.lat, lng: goal.lng, directionByUser: true });
    if (spot.roadSection && spot.roadSection.entry) {
      copy.roadSection = Object.assign({}, spot.roadSection, { entry: spot.roadSection.goal, goal: spot.roadSection.entry });
    }
    return copy;
  }

  /**
   * 地図に引く線と、距離の概算に使う点の並び。道は入口 →〜→ ゴールの通り道を全部、スポットは1点。
   * ⚠️ 道をゴールの1点にすると、道を走らずに前のスポットからゴールへ直線で結ぶことになる
   */
  function routePoints(spots) {
    var out = [];
    (spots || []).forEach(function (spot) {
      var path = roadPath(spot);
      if (path.length) path.forEach(function (p) { out.push(p); });
      else if (ok(spot)) out.push({ lat: spot.lat, lng: spot.lng });
    });
    return out;
  }

  /**
   * Google マップに渡す立ち寄りの並び。道は入口とゴールの2点、スポットは1点。
   * ⚠️ 通り道の点を全部渡さないこと。Google マップの経由地は9つまで
   */
  function mapsStops(spots) {
    var out = [];
    (spots || []).forEach(function (spot) {
      var path = roadPath(spot);
      if (path.length) { out.push(path[0]); out.push(path[path.length - 1]); }
      else if (ok(spot)) out.push({ lat: spot.lat, lng: spot.lng });
    });
    return out;
  }

  var api = { roadPath: roadPath, isRoad: isRoad, pathMeters: pathMeters, roadSubtitle: roadSubtitle,
              travelDirection: travelDirection, reversedPlanSpot: reversedPlanSpot,
              routePoints: routePoints, mapsStops: mapsStops, distance: distance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSPlanRoads = api;
})(typeof window !== "undefined" ? window : this);
