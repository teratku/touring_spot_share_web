/*
 * route-spots.js — 共有ルート（route-detail.html）の地図に出すスポットの印を選ぶ。
 *
 * 利用者の要望（2026-10-29）:「webも同じようにスポットマーカーを表示しタップして詳細が開けるようにする」。
 * 写した元: アプリの SharedRouteShareText.spotMarkers（shareRoute/SharedRouteDetailView.swift）。
 * ⚠️ **アプリの決まりを変えたら、ここも直すこと。** service/test/routeSpots.test.js がアプリと同じ例で見ている
 * ⚠️ 共有ルートの JSON は出発地のまわりが切り取られている。切り取った所のスポットまで出さないよう、
 *    点に付いたスポット（routePoints の markerType「スポット」）はそのまま、別に持つ印（markers・時刻なし）は
 *    共有する点から 500m 以内のものだけにする
 * ⚠️ 10/29 より前に共有したルートの JSON には印が無い（アプリが落としていた）。スポットを出すにはアプリで上書き共有し直す
 * ブラウザでは window.TSSRouteSpots、テスト（node）では module.exports
 */
(function (root) {
  "use strict";

  var SPOT = "スポット";
  var NEAR_M = 500;

  function distanceM(aLat, aLng, bLat, bLng) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * 共有する範囲にあるスポットの印（重複なし・ルートの順）
   * @param routeData 共有ルートの JSON（{ routePoints, markers }）
   * @returns [{ spotID, lat, lng }]
   */
  function spotMarkers(routeData, meters) {
    var near = meters == null ? NEAR_M : meters;
    var points = ((routeData && (routeData.routePoints || routeData.coordinates)) || []).slice();
    var markers = (routeData && routeData.markers) || [];
    var seen = {};
    var out = [];
    function add(id, lat, lng) {
      id = id == null ? "" : String(id).trim();
      if (!id || seen[id] || !isFinite(lat) || !isFinite(lng)) return;
      seen[id] = true;
      out.push({ spotID: id, lat: Number(lat), lng: Number(lng) });
    }
    points.sort(function (a, b) { return String(a.timestamp || "") < String(b.timestamp || "") ? -1 : 1; });
    points.forEach(function (p) { if (p.markerType === SPOT) add(p.spotID, p.latitude, p.longitude); });
    if (!points.length) return out;
    // 間引いた点で近さを測る（数千点 × 印の数でも軽く）
    var step = Math.max(1, Math.floor(points.length / 2000));
    var sample = [];
    for (var i = 0; i < points.length; i += step) sample.push(points[i]);
    markers.forEach(function (m) {
      if (!m || m.type !== SPOT) return;
      var isNear = sample.some(function (p) { return distanceM(p.latitude, p.longitude, m.latitude, m.longitude) <= near; });
      if (isNear) add(m.spotID, m.latitude, m.longitude);
    });
    return out;
  }

  /** 投稿済みのスポットの中身（imagedownload のドキュメント）から、地図の吹き出しに出すもの */
  function spotSummary(docID, data) {
    var d = data || {};
    var urls = Array.isArray(d.locationImageURLs) ? d.locationImageURLs.filter(Boolean) : [];
    if (!urls.length && d.imageDownloadURL) urls = [d.imageDownloadURL];
    return {
      docID: docID,
      name: d.location_name || d.locality || d.administrative || "スポット",
      area: [d.administrative, d.locality].filter(Boolean).join(""),
      image: urls[0] || "",
      url: "/detail.html?id=" + encodeURIComponent(docID),
    };
  }

  var api = { SPOT: SPOT, NEAR_M: NEAR_M, spotMarkers: spotMarkers, spotSummary: spotSummary, distanceM: distanceM };
  root.TSSRouteSpots = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
