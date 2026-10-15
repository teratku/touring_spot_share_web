/*
 * plan-add-lib.js — Web のプラン画面（touring-plan.html）の「＋ 追加」の計算部分（純ロジック）。
 *
 * 利用者の要望（2026-10-16）:「web のプラン追加でアプリと同じようにスポット/おすすめ道路などを追加できるようにしたい」。
 * 判断: スポット一覧・地図からスポット・おすすめ道路の3つを、プラン画面の上に重ねて開く（アプリのプランの「スポットを追加」と同じ）。
 *
 * ⚠️ アプリと同じ決めごとにすること（片方だけ変えない）:
 *    - スポットの名前: Location.spotDisplayName（名前 → 本文の1行目40字 → 住所 → 札2つ → 「名前のないスポット」）
 *    - 検索・おすすめポイント: SpotSearch・SpotPoint（spot-points.js が写し）
 *    - プランに入れる形: TouringSpot.toDict（スポットは spotId を持つ。道は roads-lib.js の planRoadSpot）
 *    - 上限: TouringPlanLimits（無料3・サブスク10。roads-lib.js の spotsPerPlan）
 * ブラウザでは window.TSSPlanAdd、テスト（node）では module.exports
 */
(function (root) {
  "use strict";

  /** 一覧に一度に出す数（全件を並べると重い。「さらに表示」で足す） */
  var PAGE_SIZE = 60;
  /** 地図の印を押したときのカードに出す写真の数・本文の長さ */
  var MAX_CARD_IMAGES = 4, MAX_CARD_COMMENT = 200;
  /** 地図に一度に描くスポットの数（見えている範囲の近い順） */
  var MAP_CAP = 400;

  function str(v) { return typeof v === "string" ? v.trim() : ""; }

  /** スポットの見出し（アプリの Location.spotDisplayName と同じ順） */
  function displayName(x) {
    if (str(x.location_name)) return str(x.location_name);
    var first = str(String(x.comment || "").split(/\r?\n/)[0]);
    if (first) return first.slice(0, 40);
    var place = [str(x.administrative), str(x.locality)].filter(Boolean).join(" ");
    if (place) return place;
    var tags = (Array.isArray(x.tag) ? x.tag : []).map(str).filter(Boolean);
    if (tags.length) return tags.slice(0, 2).join("・");
    return "名前のないスポット";
  }

  /** imagedownload の1件を一覧の1件にする。座標が読めなければ null */
  function spotFromDoc(id, x) {
    x = x || {};
    var lat = Number(x.lat), lng = Number(x.lng);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return null;
    var images = Array.isArray(x.locationImageURLs) ? x.locationImageURLs.filter(Boolean) : [];
    return {
      spotId: id, name: displayName(x), lat: lat, lng: lng,
      address: str(x.administrative) || str(x.locality) || null,
      imageUrl: images[0] || x.iconImageURL || null,
      // 地図の印を押したときのカードに出す写真（枚数は spotCard で切る）
      images: images,
      // 検索に使う元の項目（spot-points.js の haystack・matchesPoints がこの名前で読む）
      location_name: x.location_name, comment: x.comment, administrative: x.administrative, locality: x.locality,
      tag: x.tag, points: x.points, road: x.road,
    };
  }

  /**
   * 地図の印を押したときのカードの中身（利用者の要望 2026-10-16:「スポットの詳細や札、タグなどみれるとユーザーに優しい」）。
   * おすすめポイント（札）・タグ・そばの道は spot-points.js（アプリの SpotPoint・SpotSearch の写し）と同じ読み方。
   * ⚠️ 本文が見出しに使われているとき（名前が無い投稿）は、同じ文を二度出さない
   * @param SP spot-points.js（TSSSpotPoints）
   */
  function spotCard(spot, SP) {
    var road = SP.roadOf(spot);
    var comment = str(spot.comment);
    if (comment && !str(spot.location_name) && comment.split(/\r?\n/)[0].trim().slice(0, 40) === spot.name) {
      comment = comment.split(/\r?\n/).slice(1).join("\n").trim();
    }
    return {
      points: SP.fromKeys(spot.points).map(function (p) { return { icon: p.icon, label: p.label }; }),
      tags: SP.tagsOf(spot).map(function (t) { return t.trim().replace(/^#/, ""); }),
      // ⚠️ スポット詳細（detail.html の「近くの道」）と同じく名前だけ
      road: road ? road.name : null,
      comment: comment.length > MAX_CARD_COMMENT ? comment.slice(0, MAX_CARD_COMMENT) + "…" : comment,
      images: (spot.images && spot.images.length ? spot.images : (spot.imageUrl ? [spot.imageUrl] : [])).slice(0, MAX_CARD_IMAGES),
      detailUrl: spot.spotId ? "/detail.html?id=" + encodeURIComponent(spot.spotId) : null,
    };
  }

  /** プランに入れる形（TouringSpot.toDict のスポット。⚠️ order は保存するときに振り直す） */
  function planSpotOf(spot, order) {
    var out = { spotId: spot.spotId, name: spot.name, lat: spot.lat, lng: spot.lng, isCustomPin: false, order: order || 0 };
    if (spot.address) out.address = spot.address;
    if (spot.imageUrl) out.imageUrl = spot.imageUrl;
    return out;
  }

  function isSpotInPlan(planSpots, spotId) {
    return (planSpots || []).some(function (s) { return s && s.spotId === spotId; });
  }

  /** プランにまだ入れられるか */
  function canAdd(planSpots, limit) { return (planSpots || []).length < limit; }

  /** 2点の距離（m・球面の近似） */
  function distance(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * 探す基準の場所: プランの最後の場所（次に足すのはその先のことが多い）→ 無ければ渡された場所（現在地など）。
   * ⚠️ 道は通り道の最後（ゴール）
   */
  function centerOf(planSpots, fallback) {
    var list = (planSpots || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    for (var i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      if (s && isFinite(s.lat) && isFinite(s.lng) && !(s.lat === 0 && s.lng === 0)) return { lat: s.lat, lng: s.lng };
    }
    return fallback || null;
  }

  /**
   * 一覧に出すスポット: 検索の言葉とおすすめポイントで絞り、基準の場所から近い順（基準が無ければ元の順）。
   * @param SP spot-points.js（TSSSpotPoints）
   */
  function filteredSpots(spots, query, points, center, SP) {
    var out = (spots || []).filter(function (s) { return SP.matchesQuery(s, query) && SP.matchesPoints(s, points); });
    if (!center) return out;
    return out.map(function (s) { return { s: s, d: distance(center, s) }; })
      .sort(function (a, b) { return a.d - b.d; })
      .map(function (x) { return x.s; });
  }

  /** 地図に描くスポット: 見えている範囲（{south, west, north, east}）の中を真ん中から近い順に `MAP_CAP` まで */
  function spotsInBounds(spots, bounds, cap) {
    if (!bounds) return [];
    var c = { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 };
    return (spots || []).filter(function (s) {
      return s.lat >= bounds.south && s.lat <= bounds.north && s.lng >= bounds.west && s.lng <= bounds.east;
    }).map(function (s) { return { s: s, d: distance(c, s) }; })
      .sort(function (a, b) { return a.d - b.d; })
      .slice(0, cap || MAP_CAP)
      .map(function (x) { return x.s; });
  }

  /** 距離の書き方（一覧の「ここから○km」） */
  function distanceLabel(center, p) {
    if (!center || !p) return "";
    var m = distance(center, p);
    return m < 1000 ? Math.round(m) + "m" : (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)) + "km";
  }

  /** 足したあとの並び（最後に足す・order を振り直す。プラン画面の並べ替えと同じ） */
  function appended(planSpots, item) {
    var list = (planSpots || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).concat([item]);
    return list.map(function (s, i) { return Object.assign({}, s, { order: i }); });
  }

  /**
   * 道タブに出すおすすめ道路（アプリのプランの「道」・Web のおすすめ道路のページと同じ: 範囲の道をまとめ、上位を点数順。
   * 無料の人は上位3本・地図も同じ。課金している人は一覧は上位・地図は範囲の道を全部）。
   * @param R roads-lib.js（TSSRoads）
   */
  function roadChoices(segments, center, radiusKm, unlimited, R) {
    var all = R.grouped(R.withinRadius(segments || [], center, radiusKm));
    var listed = R.sortRoads(R.limited(all, R.fetchLimit(radiusKm, 30)), "score", center, {});
    var visible = R.visibleForTier(listed, unlimited);
    return { all: all, visible: visible, locked: Math.max(0, listed.length - visible.length),
             onMap: R.mapRoads(all, visible, { tags: [], kinds: [] }, unlimited) };
  }

  var api = {
    PAGE_SIZE: PAGE_SIZE, MAP_CAP: MAP_CAP, roadChoices: roadChoices,
    MAX_CARD_IMAGES: MAX_CARD_IMAGES, MAX_CARD_COMMENT: MAX_CARD_COMMENT, spotCard: spotCard,
    displayName: displayName, spotFromDoc: spotFromDoc, planSpotOf: planSpotOf, isSpotInPlan: isSpotInPlan, canAdd: canAdd,
    distance: distance, centerOf: centerOf, filteredSpots: filteredSpots, spotsInBounds: spotsInBounds,
    distanceLabel: distanceLabel, appended: appended,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSPlanAdd = api;
})(typeof window !== "undefined" ? window : this);
