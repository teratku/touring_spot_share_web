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
    return "おすすめ道路・全長 " + (pathMeters(roadPath(spot)) / 1000).toFixed(1) + "km";
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
              routePoints: routePoints, mapsStops: mapsStops, distance: distance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSPlanRoads = api;
})(typeof window !== "undefined" ? window : this);
