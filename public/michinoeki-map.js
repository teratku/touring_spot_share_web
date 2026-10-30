/*
 * michinoeki-map.js — Web の道の駅マップ（michinoeki.html）の点と都道府県ごとの数を作る。
 *
 * 利用者の要望（2026-10-30）:「道の駅マップみたいなものがあるとわかりやすい」→「webも同じようにしたい」。
 * 写した元: アプリの MichiNoEkiMapData（biketeilen_firebase/NewTabs/MichiNoEkiMapView.swift）。
 * ⚠️ **アプリの決まりを変えたら、ここも直すこと。** service/test/michinoekiMap.test.js がアプリと同じ例で見ている
 * ⚠️ 本番の一覧に ID 1147 の空の行があり、そのあとに同じ ID の佐賀関がある。ID は座標を確かめてから押さえる
 * ⚠️ 訪問はアプリの端末の中にしかない。Web が読めるのはクラウドのバックアップ（micinoEkiBackUp/{uid}.backupData・
 *    JSON 文字列・日付は ISO8601）だけ。アプリの「Webの道の駅マップにも出す」がオンなら、訪問が増えるたびに書かれる
 * ブラウザでは window.TSSMichiNoEki、テスト（node）では module.exports
 */
(function (root) {
  "use strict";

  /** バックアップの文字列 → [{id, name, visitDates: [ms]}]。読めなければ null */
  function parseBackup(json) {
    if (typeof json !== "string" || !json) return null;
    var list;
    try { list = JSON.parse(json); } catch (_) { return null; }
    if (!Array.isArray(list)) return null;
    return list.filter(function (v) { return v && typeof v.id === "string"; }).map(function (v) {
      var dates = (Array.isArray(v.visitDates) ? v.visitDates : [])
        .map(function (d) { return Date.parse(d); })
        .filter(function (t) { return !isNaN(t); });
      return { id: v.id, name: v.name || "", visitDates: dates };
    });
  }

  /** 一覧と訪問から地図の点。座標が読めない行・(0,0)・ID の無い行は出さない */
  function items(master, visits) {
    var datesByID = {};
    (visits || []).forEach(function (v) {
      if (!v.visitDates || !v.visitDates.length) return;
      datesByID[v.id] = (datesByID[v.id] || []).concat(v.visitDates);
    });
    var seen = {};
    var out = [];
    (master || []).forEach(function (e) {
      if (!e || !e.id) return;
      var lat = parseFloat(e.lat), lng = parseFloat(e.lng);
      if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) return;
      if (seen[e.id]) return;
      seen[e.id] = true;
      out.push({
        id: String(e.id),
        name: e.name || "",
        prefecture: e.admin || "",
        lat: lat,
        lng: lng,
        visitDates: (datesByID[e.id] || []).slice().sort(function (a, b) { return a - b; }),
      });
    });
    return out;
  }

  function isVisited(item) { return item.visitDates.length > 0; }

  /** 都道府県ごとの達成数。並びは一覧の順（北海道から）。県名の無いものは数えない */
  function prefectures(list) {
    var order = [], visited = {}, total = {};
    list.forEach(function (it) {
      if (!it.prefecture) return;
      if (total[it.prefecture] === undefined) { order.push(it.prefecture); total[it.prefecture] = 0; visited[it.prefecture] = 0; }
      total[it.prefecture] += 1;
      if (isVisited(it)) visited[it.prefecture] += 1;
    });
    return order.map(function (name) {
      return { name: name, visited: visited[name], total: total[name], complete: total[name] > 0 && visited[name] === total[name] };
    });
  }

  /** 'all' | 'visited' | 'unvisited' */
  function shows(filter, item) {
    if (filter === "visited") return isVisited(item);
    if (filter === "unvisited") return !isVisited(item);
    return true;
  }

  /** 新しい訪問から n 件（[{id, name, prefecture, date}]） */
  function recent(list, n) {
    var flat = [];
    list.forEach(function (it) {
      it.visitDates.forEach(function (d) { flat.push({ id: it.id, name: it.name, prefecture: it.prefecture, date: d }); });
    });
    flat.sort(function (a, b) { return b.date - a.date; });
    return flat.slice(0, n);
  }

  var api = { parseBackup: parseBackup, items: items, isVisited: isVisited, prefectures: prefectures, shows: shows, recent: recent };
  root.TSSMichiNoEki = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
