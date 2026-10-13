/*
 * spot-points.js — スポットの「おすすめポイント」（札）と、スポットの検索。
 *
 * 利用者の要望（2026-10-13）:「web のスポット詳細にも札を表示させる」「アプリ/web ともに札を選択して検索できるようにしたい」。
 * アプリの SpotPoint（SpotPoint.swift）と SpotSearch（SpotSearch.swift）の写し。
 * ⚠️ **鍵（key）は変えないこと。** Firestore の imagedownload.points に鍵のまま保存されている（アプリの投稿画面が書く）
 * ⚠️ 並びはアプリの allCases の順。知らない鍵（新しいアプリで増えた種類）は黙って落とす
 * ⚠️ アプリで種類を足したら、ここにも足す（service/test/spotPoints.test.js が Swift と突き合わせる）
 * ブラウザでは window.TSSSpotPoints、テスト（node）では module.exports
 */
(function (root) {
  "use strict";

  // アプリの SF Symbols の代わりに絵文字を使う
  var POINTS = [
    { key: "scenic", label: "景色・絶景", icon: "⛰️" },
    { key: "winding", label: "ワインディング", icon: "〰️" },
    { key: "gourmet", label: "グルメ", icon: "🍴" },
    { key: "cafe", label: "カフェ", icon: "☕" },
    { key: "onsen", label: "温泉", icon: "♨️" },
    { key: "rest", label: "休憩・道の駅", icon: "🅿️" },
    { key: "photo", label: "写真映え", icon: "📷" },
    { key: "history", label: "歴史・神社仏閣", icon: "⛩️" },
    { key: "nature", label: "自然（滝・湖・花）", icon: "🌿" },
    { key: "sea", label: "海・海岸", icon: "🌊" },
    { key: "bikeparking", label: "バイクを停めやすい", icon: "🏍️" },
  ];

  /** 保存された鍵から読む（アプリの SpotPoint.from(keys:) と同じ） */
  function fromKeys(keys) {
    var set = {};
    (Array.isArray(keys) ? keys : []).forEach(function (k) { set[k] = true; });
    return POINTS.filter(function (p) { return set[p.key]; });
  }

  /** そばの道（{name, ref}）。名前が無ければ null */
  function roadOf(spot) {
    var r = spot && spot.road;
    return r && typeof r.name === "string" && r.name.trim() ? r : null;
  }

  /** 投稿者が付けたタグ（#〜）。空は除く */
  function tagsOf(spot) {
    return (Array.isArray(spot && spot.tag) ? spot.tag : [])
      .filter(function (t) { return typeof t === "string" && t.trim(); });
  }

  /**
   * 文字の検索で探す項目（アプリの SpotSearch.haystack と同じ顔ぶれ）:
   * 名前・コメント・住所・タグ・そばの道（名前と路線番号）・おすすめポイントの表示名
   */
  function haystack(spot) {
    if (!spot) return [];
    var out = [spot.location_name, spot.comment, spot.administrative, spot.locality].concat(tagsOf(spot));
    var road = roadOf(spot);
    if (road) { out.push(road.name); if (road.ref) out.push(road.ref); }
    fromKeys(spot.points).forEach(function (p) { out.push(p.label); });
    return out.filter(function (s) { return typeof s === "string" && s !== ""; });
  }

  /**
   * 選んだおすすめポイントに当たるか。⚠️ 複数選んだら「どれかが付いている」スポット（利用者の判断 2026-10-13）。
   * 何も選んでいなければすべて当たる
   */
  function matchesPoints(spot, selected) {
    if (!selected || !selected.length) return true;
    var have = Array.isArray(spot && spot.points) ? spot.points : [];
    return selected.some(function (k) { return have.indexOf(k) >= 0; });
  }

  /** 文字の検索に当たるか。空の言葉はすべて当たる。大文字・小文字と前後の空白は区別しない */
  function matchesQuery(spot, query) {
    var q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    return haystack(spot).some(function (s) { return s.toLowerCase().indexOf(q) >= 0; });
  }

  var api = { POINTS: POINTS, fromKeys: fromKeys, roadOf: roadOf, tagsOf: tagsOf, haystack: haystack,
              matchesPoints: matchesPoints, matchesQuery: matchesQuery };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSSpotPoints = api;
})(typeof window !== "undefined" ? window : this);
