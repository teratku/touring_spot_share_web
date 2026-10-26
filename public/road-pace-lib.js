/*
 * road-pace-lib.js — 走りの速さのページ（road-pace.html・dev/road-pace.html）の計算。
 *
 * 利用者の要望（2026-10-26）:「web では計算したものがわかるようにしたい。別のページもしくは表示で」→
 *   判断「両方」: 公開ページ（3人以上の道）と開発者用ページ（1人から全部）。
 * 集計の決まりは Cloud Functions の functions/roadPace.js を写したもの（開発者用ページが生の要約から同じ答えを出すため）。
 * ⚠️ **functions/roadPace.js を直したら、ここも直すこと。** service/test/roadPaceLib.test.js が同じ入力で突き合わせている
 * ブラウザでは window.TSSRoadPace、テスト（node）では module.exports
 */
(function (root) {
  "use strict";

  var MIN_USERS = 3;
  var STOPGO_PCT = 25, FAST_KMH = 45, SMOOTH_KMH = 30;
  var LABELS = { fast: "快走路", smooth: "流れがよい", slow: "ゆっくり走る道", stopgo: "止まりがち" };
  /** 区分の順（一覧・凡例） */
  var ORDER = ["fast", "smooth", "slow", "stopgo"];
  /** 地図の線の色（明るい地図の上で見分けやすい4色） */
  var COLORS = { fast: "#0E9F6E", smooth: "#0891B2", slow: "#B7791F", stopgo: "#E8590C" };
  var SOURCES = { app: "アプリ", shared: "共有ルート", backup: "バックアップ" };

  function median(values) {
    var v = values.filter(function (x) { return isFinite(x) && x !== null; }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  function labelOf(x) {
    if (x.stopPct >= STOPGO_PCT) return "stopgo";
    if (x.kmh >= FAST_KMH) return "fast";
    if (x.kmh >= SMOOTH_KMH) return "smooth";
    return "slow";
  }

  /** road_pace_offline/{uid} の中身を road_pace と同じ形の並びに（functions/roadPace.js の offlineDocs） */
  function offlineDocs(data) {
    if (!data || typeof data.uid !== "string" || !data.roads || typeof data.roads !== "object") return [];
    return Object.keys(data.roads).map(function (roadID) {
      var v = data.roads[roadID] || {};
      return { uid: data.uid, roadID: roadID, roadName: v.name || "", rides: v.rides || [] };
    });
  }

  /**
   * 道ごとの集計（functions/roadPace.js の tallyRoadPace と同じ）。
   * 開発者用に sources（出どころごとの回数）も数える
   */
  function tally(docs, opts) {
    var minUsers = (opts && opts.minUsers) || MIN_USERS;
    var merged = {}, order = [];
    (docs || []).forEach(function (d) {
      if (!d || typeof d.roadID !== "string" || !d.roadID || typeof d.uid !== "string") return;
      var key = d.uid + "\u0000" + d.roadID;
      if (!merged[key]) { merged[key] = { uid: d.uid, roadID: d.roadID, roadName: "", rides: [] }; order.push(key); }
      if (d.roadName) merged[key].roadName = d.roadName;
      merged[key].rides = merged[key].rides.concat(Array.isArray(d.rides) ? d.rides : []);
    });
    var byRoad = {}, roadOrder = [];
    order.forEach(function (k) {
      var d = merged[k];
      var rides = d.rides.filter(function (r) { return r && r.cc !== "moped50" && isFinite(r.kmh) && isFinite(r.km) && r.km > 0; });
      if (!rides.length) return;
      var person = {
        kmh: median(rides.map(function (r) { return r.kmh; })),
        p85: median(rides.map(function (r) { return r.p85; })),
        stopPct: median(rides.map(function (r) { return r.stopPct; })),
        stopsPer10km: median(rides.map(function (r) { return isFinite(r.stops) ? r.stops / r.km * 10 : NaN; })),
        rides: rides.length,
      };
      if (!byRoad[d.roadID]) { byRoad[d.roadID] = { key: d.roadID, name: "", people: [], sources: {} }; roadOrder.push(d.roadID); }
      var e = byRoad[d.roadID];
      if (d.roadName) e.name = d.roadName;
      e.people.push(person);
      rides.forEach(function (r) { var s = r.src || "app"; e.sources[s] = (e.sources[s] || 0) + 1; });
    });
    return roadOrder.map(function (k) { return byRoad[k]; })
      .filter(function (e) { return e.people.length >= minUsers; })
      .map(function (e) {
        var pick = function (f) { return median(e.people.map(function (p) { return p[f]; })); };
        var value = { kmh: Math.round(pick("kmh")), p85: Math.round(pick("p85") || 0), stopPct: Math.round(pick("stopPct") || 0) };
        var s10 = pick("stopsPer10km");
        value.stopsPer10km = s10 == null ? null : Math.round(s10 * 10) / 10;
        var hist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        e.people.forEach(function (p) { hist[Math.min(9, Math.max(0, Math.floor(p.kmh / 10)))] += 1; });
        return Object.assign({ key: e.key, name: e.name, users: e.people.length,
          rides: e.people.reduce(function (s, p) { return s + p.rides; }, 0) }, value,
          { label: labelOf(value), hist: hist, sources: e.sources });
      })
      .sort(function (a, b) { return b.users - a.users || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
  }

  /** 道の鍵から県名（"r:長野県|152|primary" / "n:長野県|名前|…" / "s:長野県:12"） */
  function prefectureOfKey(key) {
    var m = String(key || "").match(/^[rns]:([^|:]+)/);
    return m ? m[1] : "";
  }

  var api = {
    MIN_USERS: MIN_USERS, STOPGO_PCT: STOPGO_PCT, FAST_KMH: FAST_KMH, SMOOTH_KMH: SMOOTH_KMH,
    LABELS: LABELS, ORDER: ORDER, COLORS: COLORS, SOURCES: SOURCES,
    median: median, labelOf: labelOf, offlineDocs: offlineDocs, tally: tally, prefectureOfKey: prefectureOfKey,
  };
  root.TSSRoadPace = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
