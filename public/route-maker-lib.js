/*
 * route-maker-lib.js — Web でルートを作る画面（route-maker.html）の計算部分（純ロジック）。
 *
 * ⚠️ アプリと同じ決めごとにすること（片方だけ変えない）:
 *    - 行き先の作り方: TouringSpot.navDestination（道は通り道の最後がゴール・それ以外は中継点）
 *    - 地点の間引き: NavWaypointBudget.fitted（道の途中の点だけを道ごとに比例してまんべんなく・入口とゴールは残す）
 *    - 経路サーバへの体: ValhallaRouteService.send（stopAt は立ち寄り先・throughStopAt は道の終点）
 * ⚠️ ブラウザでは window.TSSRouteMaker、テスト（node）では module.exports
 */
(function (root) {
  /** 経路サーバ（バイク）が1回に受け付ける地点の数・楽しい道の分・出発地を引いた、立ち寄り先と道の途中の点の上限 */
  var MAX_DESTINATION_POINTS = 50 - 5 * 2 - 1;
  var DISPLACEMENTS = [["large", "251cc以上"], ["medium250", "126〜250cc"], ["small125", "51〜125cc"], ["moped50", "50cc以下"]];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function ok(p) { return p && isFinite(p.lat) && isFinite(p.lng); }
  function km(m) { return (m / 1000).toFixed(1) + " km"; }
  function dur(s) { var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? h + "時間" + m + "分" : m + "分"; }

  /** プランの1件を行き先にする（アプリの TouringSpot.navDestination と同じ: 道は通り道の最後がゴール） */
  function toDestinations(spots) {
    return spots.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).map(function (s) {
      var path = (s.path || []).map(function (p) { return Array.isArray(p) ? { lat: p[0], lng: p[1] } : { lat: p.lat, lng: p.lng }; }).filter(ok);
      if (s.isRoad && path.length >= 2) {
        var goal = path[path.length - 1];
        return { name: s.name, kind: "road", lat: goal.lat, lng: goal.lng, approach: path.slice(0, -1),
                 roadID: s.roadId || null, section: s.roadSection || null };
      }
      return { name: s.name, kind: "place", lat: s.lat, lng: s.lng, approach: [] };
    }).filter(function (d) { return ok(d); });
  }

  /** 地点が上限を超えるとき、道の途中の点だけを道ごとにまんべんなく間引く（入口とゴールは残す）。アプリの NavWaypointBudget.fitted と同じ */
  function fitted(dests, maxPoints) {
    var total = dests.reduce(function (n, d) { return n + d.approach.length + 1; }, 0);
    if (total <= maxPoints) return dests;
    var fixed = dests.reduce(function (n, d) { return n + 1 + Math.min(1, d.approach.length); }, 0);
    var mids = dests.map(function (d) { return Math.max(0, d.approach.length - 1); });
    var totalMids = mids.reduce(function (a, b) { return a + b; }, 0);
    if (!totalMids) return dests;
    var room = Math.max(0, maxPoints - fixed);
    var keep = mids.map(function (m) { return Math.floor(m * room / totalMids); });
    var left = room - keep.reduce(function (a, b) { return a + b; }, 0);
    var order = mids.map(function (_, i) { return i; }).sort(function (a, b) {
      var ra = mids[a] - keep[a], rb = mids[b] - keep[b]; return ra !== rb ? rb - ra : a - b; });
    order.forEach(function (i) { if (left > 0 && keep[i] < mids[i]) { keep[i]++; left--; } });
    return dests.map(function (d, i) {
      if (d.approach.length <= 1 || keep[i] >= mids[i]) return d;
      var middle = d.approach.slice(1), k = keep[i], picked = [];
      for (var j = 0; j < k; j++) picked.push(middle[Math.floor((j * middle.length + Math.floor(middle.length / 2)) / k)]);
      return Object.assign({}, d, { approach: [d.approach[0]].concat(picked) });
    });
  }

  /** 経路サーバへの体（アプリの ValhallaRouteService.send と同じ形） */
  function buildBody(origin, dests, cond) {
    var pair = function (p) { return [p.lng, p.lat]; };
    var points = [], stopAt = [], throughStopAt = [];
    dests.forEach(function (d, i) {
      d.approach.forEach(function (p) { points.push(p); });
      if (i < dests.length - 1) {
        stopAt.push(points.length);
        if (d.kind === "road") throughStopAt.push(points.length);
      }
      points.push({ lat: d.lat, lng: d.lng });
    });
    var last = points.pop();
    return { from: pair(origin), to: pair(last), vias: points.map(pair), displacement: cond.displacement,
             avoidTolls: cond.avoidTolls, avoidHighways: cond.avoidHighways, avoidFerries: cond.avoidFerries,
             alternates: 2, arriveOnNearSide: true, guidance: false, stopAt: stopAt, throughStopAt: throughStopAt };
  }

  function decodePolyline(str) {
    var idx = 0, lat = 0, lng = 0, out = [];
    while (idx < str.length) {
      var b, shift = 0, result = 0;
      do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      out.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return out;
  }


  var api = { MAX_DESTINATION_POINTS: MAX_DESTINATION_POINTS, DISPLACEMENTS: DISPLACEMENTS, esc: esc, ok: ok, km: km, dur: dur,
              toDestinations: toDestinations, fitted: fitted, buildBody: buildBody, decodePolyline: decodePolyline };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSRouteMaker = api;
})(typeof window !== "undefined" ? window : this);
