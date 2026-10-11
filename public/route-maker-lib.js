/*
 * route-maker-lib.js — Web でルートを作る画面（route-maker.html）の計算部分（純ロジック）。
 *
 * ⚠️ アプリと同じ決めごとにすること（片方だけ変えない）:
 *    - 行き先の作り方: TouringSpot.navDestination（道は通り道の最後がゴール・それ以外は中継点）
 *    - 地点の間引き: NavWaypointBudget.fitted（道の途中の点だけを道ごとに比例してまんべんなく・入口とゴールは残す）
 *    - 経路サーバへの体: ValhallaRouteService.send（stopAt は立ち寄り先・throughStopAt は道の終点・
 *      立ち寄り先ごとの有料・高速は NavLegSettings・走る日時・ETC 車載器なし）
 *    - 地図の色: NavRoadKind.color（下道=青・高速=緑・有料=オレンジ）・NavRecommendedSpans（金色の縁）・
 *      NavCandidatePalette（ほかの候補の縁）
 *    - 表示: NavFormat.displayDistance / displayDuration・NavRouteCandidate.compositionSummary
 * ⚠️ ブラウザでは window.TSSRouteMaker、テスト（node）では module.exports
 */
(function (root) {
  /** 経路サーバ（バイク）が1回に受け付ける地点の数・楽しい道の分・出発地を引いた、立ち寄り先と道の途中の点の上限 */
  var MAX_DESTINATION_POINTS = 50 - 5 * 2 - 1;
  var DISPLACEMENTS = [["large", "251cc以上"], ["medium250", "126〜250cc"], ["small125", "51〜125cc"], ["moped50", "50cc以下"]];

  // ---- 地図の色（アプリと同じ。⚠️ 地図の色はそれぞれ別の意味。重ねないこと） ----
  /** 道の種類。並びは凡例と内訳に出す順（アプリの NavRoadKind.allCases） */
  var ROAD_KINDS = [
    { kind: "expressway", label: "高速", color: "#34C759" },  // UIColor.systemGreen
    { kind: "toll", label: "有料", color: "#FF9500" },        // UIColor.systemOrange
    { kind: "surface", label: "下道", color: "#007AFF" },     // NavMapView.surfaceColor（0,122,255）
  ];
  /** 選んだ候補がおすすめ道路を走る区間の縁（NavRecommendedSpans.edgeColor） */
  var RECOMMENDED_EDGE_COLOR = "#F5B700";
  /** ほかの候補の縁（候補の並び順で決める・地図とカードで同じ色。systemPink / Teal / Indigo / Brown / Mint） */
  var CANDIDATE_PALETTE = ["#FF2D55", "#30B0C7", "#5856D6", "#A2845E", "#00C7BE"];
  /** おすすめ道路の線からこれ以内なら「その道を走っている」・これだけ続けて走っていたら縁を付ける（NavRecommendedSpans） */
  var RECOMMENDED_NEAR_METERS = 30, RECOMMENDED_MIN_RUN_METERS = 300;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function ok(p) { return p && isFinite(p.lat) && isFinite(p.lng); }
  /** 距離（NavFormat.displayDistance: 1km 以上は小数1桁の km・未満は m） */
  function km(m) { return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.max(0, Math.round(m)) + " m"; }
  /** 所要（NavFormat.displayDuration: 分は切り捨て。⚠️ 四捨五入すると「1時間60分」になる） */
  function dur(s) { var m = Math.floor(Math.max(0, s) / 60); return m >= 60 ? Math.floor(m / 60) + "時間" + (m % 60) + "分" : m + "分"; }
  function candidateColor(i) { var n = CANDIDATE_PALETTE.length; return CANDIDATE_PALETTE[((i % n) + n) % n]; }
  function kindInfo(kind) { return ROAD_KINDS.filter(function (k) { return k.kind === kind; })[0] || ROAD_KINDS[2]; }

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

  // ---- 立ち寄り先ごとの有料・高速（アプリの NavLegSettings。区間 i は「行き先 i へ向かう区間」） ----

  /** 125cc 以下は高速を走れない（BikeProfile.Displacement.canUseExpressway）。⚠️ 区間で「使う」にしても走らせない */
  function highwaysForbidden(displacement) { return displacement === "small125" || displacement === "moped50"; }

  /** 全体の設定（区間で決めていないときに使う。NavLegSettings.Defaults） */
  function legDefaults(cond) {
    var forbidden = highwaysForbidden(cond.displacement);
    return { avoidTolls: !!cond.avoidTolls, avoidHighways: forbidden || !!cond.avoidHighways, highwaysForbidden: forbidden,
             funRoads: (cond.funWeight || 0) >= MIN_FUN_WEIGHT };
  }

  /** 区間の設定（null は全体の設定に従う）を全体の設定で埋める（NavLegSettings.effective） */
  function effectiveLeg(setting, defaults) {
    var s = setting || {};
    return { avoidTolls: s.avoidTolls != null ? s.avoidTolls : defaults.avoidTolls,
             avoidHighways: defaults.highwaysForbidden || (s.avoidHighways != null ? s.avoidHighways : defaults.avoidHighways),
             funRoads: s.funRoads != null ? s.funRoads : !!defaults.funRoads };
  }

  /** 区間の札を押したとき（RouteStopsEditorView.legSettingChips）。全体と同じになったら null に戻す */
  function toggledLeg(setting, key, defaults) {
    var next = Object.assign({ avoidTolls: null, avoidHighways: null, funRoads: null }, setting || {});
    if (key === "funRoads") {
      // 楽しい道は「使う」が真（有料・高速は「避ける」が真）
      var use = !(next.funRoads != null ? next.funRoads : !!defaults.funRoads);
      next.funRoads = use === !!defaults.funRoads ? null : use;
      return next;
    }
    var avoid = !effectiveLeg(setting, defaults)[key];
    next[key] = avoid === defaults[key] ? null : avoid;
    return next;
  }

  /** `[出発地] + 行き先ごとの（中継点＋ゴール）` の並びで、地点のあいだごとの条件（NavLegSettings.gapConditions） */
  function gapConditions(dests, defaults) {
    var out = [];
    dests.forEach(function (d) {
      var e = effectiveLeg(d.legSetting, defaults);
      for (var k = 0; k <= d.approach.length; k++) out.push({ avoidTolls: e.avoidTolls, avoidHighways: e.avoidHighways });
    });
    return out;
  }

  /** 混ざっているときだけ返す（そろっていればサーバへ渡さない。今までと同じ引き方になる） */
  function mixedOrNil(conds) {
    if (!conds.length) return null;
    var f = conds[0];
    return conds.some(function (c) { return c.avoidTolls !== f.avoidTolls || c.avoidHighways !== f.avoidHighways; }) ? conds : null;
  }

  /** 全体の条件は一番厳しい組み合わせ（区間ごとの条件を知らない古いサーバ向け。NavLegSettings.strictest） */
  function strictest(conds) {
    return { avoidTolls: conds.some(function (c) { return c.avoidTolls; }),
             avoidHighways: conds.some(function (c) { return c.avoidHighways; }) };
  }

  /** 走る日時を送る形にする（アプリは ISO8601DateFormatter: 秒まで・UTC の Z） */
  function isoSeconds(date) { return date.toISOString().replace(/\.\d{3}Z$/, "Z"); }

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
    // ⚠️ 立ち寄り先ごとの有料・高速は、地点のあいだごとの条件にして混ざっているときだけ渡す。全体は一番厳しい組み合わせ
    var gaps = gapConditions(dests, legDefaults(cond));
    var strict = strictest(gaps);
    var body = { from: pair(origin), to: pair(last), vias: points.map(pair), displacement: cond.displacement,
                 avoidTolls: strict.avoidTolls, avoidHighways: strict.avoidHighways, avoidFerries: cond.avoidFerries,
                 alternates: 2, arriveOnNearSide: true, guidance: false, stopAt: stopAt, throughStopAt: throughStopAt };
    var mixed = mixedOrNil(gaps);
    if (mixed) body.legConditions = mixed;
    // ⚠️ 車載器が無いときだけ送る（渡さなければサーバは「あり」とみなす）
    if (cond.etc === false) body.etc = false;
    // ⚠️ 決めていなければ送らない（時間や曜日で切られた規制も避ける＝避けすぎ側）。「いま」を勝手に入れない
    if (cond.rideAt instanceof Date && isFinite(cond.rideAt.getTime())) {
      body.at = isoSeconds(cond.rideAt);
      body.isHoliday = !!cond.isHoliday;
    }
    return body;
  }

  // ---- アプリへ渡す ----

  /** アプリへ渡す道の大きさの上限（Firestore の1件は 1MiB まで。ほかの項目のぶんを空けておく） */
  var MAX_ROUTE_BYTES = 900000;

  /**
   * 選んだ候補を、アプリへ渡す形（経路サーバの応答の `route` そのままを JSON の文字列）にする。
   * ⚠️ 利用者の報告（2026-10-09）:「web で生成したルートをアプリ側に送ったときに、新たにルートが生成されてしまった」。
   *    アプリは これを `ValhallaRouteService.parse` で読み、引き直さずに出す（WebRouteStore.chosenRoute）。
   * ⚠️ 画面で足した項目（`path`）は入れない。大きすぎるときは null（アプリはそのときだけ引き直す）
   */
  function routeForApp(candidate, maxBytes) {
    if (!candidate || !candidate.polyline || !Array.isArray(candidate.steps)) return null;
    var copy = {};
    Object.keys(candidate).forEach(function (k) { if (k !== "path") copy[k] = candidate[k]; });
    var text = JSON.stringify(copy);
    var bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
    return bytes <= (maxBytes || MAX_ROUTE_BYTES) ? text : null;
  }

  // ---- 経路の線の塗り分け・内訳 ----

  /** 道の種類ごとの線（NavRoute.segmentsFromSpans: 区間の無い所は下道。⚠️ 指示の旗では塗らない） */
  function kindSegments(points, kindSpans) {
    var n = points.length, out = [], cursor = 0;
    if (n < 2) return out;
    function take(a, b, kind) {
      a = Math.max(0, Math.min(a, n - 1)); b = Math.max(0, Math.min(b, n - 1));
      if (b > a) out.push({ kind: kind, path: points.slice(a, b + 1) });
    }
    (kindSpans || []).slice().sort(function (x, y) { return x.begin - y.begin; }).forEach(function (sp) {
      if (sp.begin > cursor) take(cursor, sp.begin, "surface");
      take(sp.begin, sp.end, sp.kind);
      cursor = Math.max(cursor, sp.end);
    });
    if (cursor < n - 1) take(cursor, n - 1, "surface");
    return out;
  }

  /** 種類ごとの距離（区間から数える。NavRoute.distanceMeters(of:)） */
  function kindMeters(route, kind) {
    return (route.kindSpans || []).reduce(function (m, sp) { return m + (sp.kind === kind ? sp.meters || 0 : 0); }, 0);
  }

  /** 実際に出ている種類（凡例と内訳に出す順） */
  function presentKinds(route) {
    return ROAD_KINDS.filter(function (k) { return kindMeters(route, k.kind) > 0; });
  }

  /** 返ってきた経路の中身を1行に（NavRouteCandidate.compositionSummary）。⚠️ 頼んだ条件の名前ではなく、通る道を書く */
  function compositionSummary(route) {
    var kinds = presentKinds(route);
    if (kinds.length === 1) return kinds[0].label + "のみ";
    return kinds.map(function (k) { return k.label + " " + km(kindMeters(route, k.kind)); }).join(" ・ ");
  }

  /** 行き先ごとの区間（指示の「区間の終わり」の印で区切る）。⚠️ 行き先の数と合わなければ出さない（空） */
  function legBreakdown(route, dests) {
    var legs = [], cur = { distanceMeters: 0, durationSeconds: 0 };
    (route.steps || []).forEach(function (st) {
      cur.distanceMeters += st.distanceMeters || 0;
      cur.durationSeconds += st.durationSeconds || 0;
      if (st.isLegEnd) { legs.push(cur); cur = { distanceMeters: 0, durationSeconds: 0 }; }
    });
    if (legs.length !== dests.length) return [];
    return legs.map(function (l, i) { return Object.assign({ name: dests[i].name }, l); });
  }

  // ---- おすすめ道路を走る区間（金色の縁。アプリの NavRecommendedSpans・RoadRestrictionMatcher と同じ測り方） ----

  function roughDistance(a, b) {
    var dLat = (a.lat - b.lat) * 111320, dLng = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }
  function distanceToSegment(p, a, b) {
    var scale = Math.cos(p.lat * Math.PI / 180);
    var px = (p.lng - a.lng) * scale * 111320, py = (p.lat - a.lat) * 111320;
    var ex = (b.lng - a.lng) * scale * 111320, ey = (b.lat - a.lat) * 111320;
    var len = ex * ex + ey * ey;
    if (len === 0) return Math.sqrt(px * px + py * py);
    var t = Math.max(0, Math.min(1, (px * ex + py * ey) / len));
    return Math.sqrt((px - t * ex) * (px - t * ex) + (py - t * ey) * (py - t * ey));
  }
  function distanceToLine(p, line) {
    var best = Infinity;
    for (var i = 1; i < line.length; i++) { best = Math.min(best, distanceToSegment(p, line[i - 1], line[i])); if (best < 1) break; }
    return best;
  }
  function boxOf(line) {
    var b = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
    line.forEach(function (p) {
      b.minLat = Math.min(b.minLat, p.lat); b.maxLat = Math.max(b.maxLat, p.lat);
      b.minLng = Math.min(b.minLng, p.lng); b.maxLng = Math.max(b.maxLng, p.lng);
    });
    return b;
  }
  function inBox(b, p, margin) {
    var dLat = margin / 111320, dLng = margin / (111320 * Math.cos(p.lat * Math.PI / 180));
    return p.lat >= b.minLat - dLat && p.lat <= b.maxLat + dLat && p.lng >= b.minLng - dLng && p.lng <= b.maxLng + dLng;
  }

  /**
   * 経路のうち、おすすめ道路の上を続けて走る範囲（経路の点の番号・両端を含む [始, 終]）。
   * ⚠️ 交差点で横切るだけの道を光らせないため、300m 続けて走ったところだけ
   */
  function recommendedSpans(route, roads) {
    var lines = (roads || []).filter(function (l) { return l.length >= 2; });
    if (route.length < 2 || !lines.length) return [];
    var boxes = lines.map(boxOf), out = [], start = null, run = 0;
    function close(end) { if (start !== null && end > start && run >= RECOMMENDED_MIN_RUN_METERS) out.push([start, end]); start = null; run = 0; }
    for (var i = 0; i < route.length; i++) {
      var p = route[i], on = false;
      for (var j = 0; j < lines.length && !on; j++) {
        on = inBox(boxes[j], p, RECOMMENDED_NEAR_METERS) && distanceToLine(p, lines[j]) <= RECOMMENDED_NEAR_METERS;
      }
      if (on) { if (start === null) start = i; else run += roughDistance(route[i - 1], p); }
      else close(i - 1);
    }
    close(route.length - 1);
    return out;
  }

  /** 経路が掛かる県（外接矩形が重なる県。RoadPassability.prefectures(for:)）。prefectures は conquest/prefecture-data.js の形 */
  function prefecturesFor(routes, prefectures) {
    var pts = [].concat.apply([], routes);
    if (!pts.length) return [];
    var b = boxOf(pts);
    return prefectures.filter(function (pf) {
      var x = pf.bounds;
      return x.latMin <= b.maxLat && x.latMax >= b.minLat && x.lngMin <= b.maxLng && x.lngMax >= b.minLng;
    }).map(function (pf) { return pf.name; });
  }

  // ---- 楽しい道・距離ガバ（アプリの RouteCandidatesView.loadFunRoute のつなぎ） ----
  //
  // ⚠️ 利用者の判断（2026-10-09）: Web のルート作成に「楽しい道＋距離ガバ」を持ってくる。
  //    道の選び方そのものは route-maker-fun.js（admin/lib/appFunRoute.js から作る生成物・アプリと答え合わせ済み）。
  //    ここはアプリの画面側のつなぎ（立ち寄り先の差し込み・区間ごとの楽しい道・原因の道の見つけ方・案の名前…）を移したもの。
  // ⚠️ `geo` は TSSFun.geometry（navGeometry.js）・`fun` は TSSFun.appFun。点は [経度, 緯度]

  /** これ未満のつまみは「最短」（NavRoutePreference.minimumFunWeight） */
  var MIN_FUN_WEIGHT = 0.01;
  /** つまみ全開の寄り道の倍率（NavRoutePreference.maxDetourRatio）。刈り込みの上限にも使う */
  var MAX_DETOUR_RATIO = 3.0;
  /** 予算を超えた案を減らして作り直す回数（RouteCandidatesView.maxFunRouteTrimAttempts） */
  var MAX_FUN_TRIM_ATTEMPTS = 2;
  /** 原因の道を探す範囲: Uターンの指示・往復の先端は 500m（FunRouteBuilder.segment(nearestTo:)）・輪の出入口は 2km（NavFunLoopBlame） */
  var BLAME_NEAR_METERS = 500, LOOP_BLAME_METERS = 2000;
  var SIDE_LABELS = { north: "北", east: "東", south: "南", west: "西" };
  var KIND_LABELS = { generous: "たっぷり", modest: "ひかえめ", alternate: "別ルート", wide: "もっと寄り道" };

  function pair(p) { return [p.lng, p.lat]; }
  function latLng(a) { return { lat: a[1], lng: a[0] }; }

  /** つまみの表示（NavRoutePreference.funWeightLabel） */
  function funWeightLabel(w) {
    if (!((w || 0) >= MIN_FUN_WEIGHT)) return "最短";
    return w < 0.34 ? "少し寄り道" : w < 0.67 ? "ほどよく" : "たっぷり";
  }

  /** 中心から半径の範囲に掛かる県（EnjoyableRoadsService.prefecturesWithin）。楽しい道の候補を読む県 */
  function prefecturesWithin(center, radiusKm, prefectures) {
    var latDelta = radiusKm / 111.0, lonDelta = radiusKm / (111.0 * Math.cos(center.lat * Math.PI / 180));
    var latMin = center.lat - latDelta, latMax = center.lat + latDelta;
    var lonMin = center.lng - lonDelta, lonMax = center.lng + lonDelta;
    return prefectures.filter(function (pf) {
      var b = pf.bounds;
      return b.latMin <= latMax && b.latMax >= latMin && b.lngMin <= lonMax && b.lngMax >= lonMin;
    }).map(function (pf) { return pf.name; });
  }

  /** 行き先を、経由地の並びの「止まる場所」にする（RouteCandidatesView.destinationStops）。道の中継点は止まらない */
  function destinationStops(dests) {
    var out = [];
    dests.forEach(function (d) {
      d.approach.forEach(function (p) { out.push({ point: p, isUserStop: false, isRoadCourseEnd: false }); });
      out.push({ point: { lat: d.lat, lng: d.lng }, isUserStop: true, isRoadCourseEnd: d.kind === "road" });
    });
    return out;
  }

  /**
   * 楽しい道の経由地を「どの行き先の手前で通るか」で振り分け、止まる場所と合わせて並べる
   * （NavDrawnRouteBuilder.viaSequence / distribute）。⚠️ 道の中継点は振り分けの基準にしない
   * @returns {{vias: Array<{lat,lng}>, stopAt: number[], throughStopAt: number[]}}
   */
  function viaSequence(origin, drawn, stops, geo) {
    if (!stops.length) return { vias: [], stopAt: [], throughStopAt: [] };
    var buckets = stops.map(function () { return []; });
    var goals = stops.map(function (s, i) { return s.isUserStop ? i : -1; }).filter(function (i) { return i >= 0; });
    var progress = {};
    if (drawn.length) {
      if (!goals.length) {
        buckets[stops.length - 1] = drawn.map(function (_, i) { return i; });
      } else {
        var starts = [origin].concat(goals.slice(0, -1).map(function (g) { return stops[g].point; }));
        drawn.forEach(function (p, di) {
          var bestLeg = goals.length - 1, best = Infinity, bestAlong = 0;
          goals.forEach(function (g, leg) {
            var pr = geo.project(pair(p), [pair(starts[leg]), pair(stops[g].point)]);
            if (pr && pr.lateralDistance < best) { best = pr.lateralDistance; bestLeg = leg; bestAlong = pr.along; }
          });
          buckets[goals[bestLeg]].push(di);
          progress[di] = bestAlong;
        });
        buckets.forEach(function (b) { b.sort(function (x, y) { return (progress[x] || 0) - (progress[y] || 0); }); });
      }
    }
    var vias = [], stopAt = [], throughStopAt = [];
    for (var si = 0; si < stops.length; si++) {
      buckets[si].forEach(function (di) { vias.push(drawn[di]); });
      // ⚠️ 最後の行き先は経由地ではない（行き先そのもの）
      if (si === stops.length - 1) break;
      if (stops[si].isUserStop) {
        stopAt.push(vias.length);
        if (stops[si].isRoadCourseEnd) throughStopAt.push(vias.length);
      }
      vias.push(stops[si].point);
    }
    return { vias: vias, stopAt: stopAt, throughStopAt: throughStopAt };
  }

  /**
   * 楽しい道の並び（経由地 viaCount 個・その中の立ち寄り先の番号 stopAt）で、地点のあいだごとの条件
   * （NavLegSettings.gapConditions(viaCount:stopAt:)）。立ち寄り先を1つ過ぎるごとに次の区間
   */
  function funGapConditions(viaCount, stopAt, dests, defaults, forceAvoid) {
    var stops = {}; stopAt.forEach(function (i) { stops[i] = true; });
    var leg = 0, out = [];
    for (var g = 0; g <= viaCount; g++) {
      if (g >= 1 && stops[g - 1]) leg++;
      var d = dests[leg] || dests[dests.length - 1];
      var e = d ? effectiveLeg(d.legSetting, defaults) : { avoidTolls: defaults.avoidTolls, avoidHighways: defaults.avoidHighways };
      out.push({ avoidTolls: e.avoidTolls || !!forceAvoid, avoidHighways: e.avoidHighways || !!forceAvoid });
    }
    return out;
  }

  /** 楽しい道を使う区間の番号（NavLegSettings.funLegs） */
  function funLegs(dests, defaults) {
    return dests.map(function (d, i) { return effectiveLeg(d.legSetting, defaults).funRoads ? i : -1; })
      .filter(function (i) { return i >= 0; });
  }

  /** 経路の線を行き先ごとの区間（点の番号の範囲 [始, 終]）に分ける（NavLegSettings.legRanges）。⚠️ 前から順に探す */
  function legRanges(route, goals, geo) {
    if (route.length < 2 || !goals.length) return [];
    var ranges = [], start = 0;
    for (var i = 0; i < goals.length; i++) {
      if (i === goals.length - 1) { ranges.push([start, route.length - 1]); break; }
      var end = start, best = Infinity;
      for (var k = start; k < route.length; k++) {
        var m = geo.distance(pair(route[k]), pair(goals[i]));
        if (m < best) { best = m; end = k; }
      }
      ranges.push([start, Math.max(start, end)]);
      start = Math.max(start, end);
    }
    return ranges;
  }

  /**
   * 楽しい道の候補を、楽しい道を使う区間の上にあるものだけにする（NavLegSettings.filterFunSegments）。
   * 道の真ん中の点を経路の線（間引いて400点まで）に当て、いちばん近い点が入っている区間で決める
   */
  function filterFunSegments(segments, route, goals, allowed, geo, fun) {
    var ranges = legRanges(route, goals, geo);
    if (!ranges.length || allowed.length >= ranges.length) return allowed.length ? segments : [];
    var step = Math.max(1, Math.floor(route.length / 400)), probes = [];
    for (var i = 0; i < route.length; i += step) probes.push(i);
    return segments.filter(function (seg) {
      var line = fun.polylineOf(seg);
      if (!line.length) return false;
      var mid = line[Math.floor(line.length / 2)], nearest = -1, best = Infinity;
      probes.forEach(function (pi) { var m = geo.distance(pair(route[pi]), mid); if (m < best) { best = m; nearest = pi; } });
      for (var leg = 0; leg < ranges.length; leg++) {
        if (nearest >= ranges[leg][0] && nearest <= ranges[leg][1]) return allowed.indexOf(leg) >= 0;
      }
      return false;
    });
  }

  /**
   * 楽しい道の案を引くときの体（RouteCandidatesView.requestDrawnRouteCandidatesWithOwnEngine）。
   * ⚠️ 楽しい道の経由地は立ち寄り先のあいだに挟む。区間ごとの有料・高速は、決めた区間があるときだけ
   */
  function buildFunBody(origin, dests, waypoints, cond, geo) {
    var stops = destinationStops(dests);
    var last = stops[stops.length - 1].point;
    var seq = viaSequence(origin, waypoints.map(latLng), stops, geo);
    var defaults = legDefaults(cond);
    var hasOverrides = dests.some(function (d) { var s = d.legSetting || {}; return s.avoidTolls != null || s.avoidHighways != null; });
    var lc = hasOverrides ? mixedOrNil(funGapConditions(seq.vias.length, seq.stopAt, dests,
      { avoidTolls: defaults.avoidTolls, avoidHighways: defaults.avoidHighways, highwaysForbidden: defaults.highwaysForbidden, funRoads: true })) : null;
    var strict = lc ? strictest(lc) : { avoidTolls: defaults.avoidTolls, avoidHighways: defaults.avoidHighways };
    var body = { from: pair(origin), to: pair(last), vias: seq.vias.map(pair), displacement: cond.displacement,
                 avoidTolls: strict.avoidTolls, avoidHighways: strict.avoidHighways, avoidFerries: cond.avoidFerries,
                 alternates: 0, arriveOnNearSide: true, guidance: false, variant: "fun",
                 stopAt: seq.stopAt, throughStopAt: seq.throughStopAt };
    if (lc) body.legConditions = lc;
    if (cond.etc === false) body.etc = false;
    if (cond.rideAt instanceof Date && isFinite(cond.rideAt.getTime())) { body.at = isoSeconds(cond.rideAt); body.isHoliday = !!cond.isHoliday; }
    return body;
  }

  /** いちばん近い楽しい道（その線から maxMeters 以内。FunRouteBuilder.segment(nearestTo:)） */
  function segmentNearestTo(point, segments, maxMeters, geo, fun) {
    var best = null, bestM = Infinity;
    segments.forEach(function (seg) {
      var line = fun.polylineOf(seg), m;
      if (line.length >= 2) { var pr = geo.project(point, line); m = pr ? pr.lateralDistance : Infinity; }
      else if (seg.start && seg.end) m = Math.min(geo.distance(point, [seg.start[1], seg.start[0]]), geo.distance(point, [seg.end[1], seg.end[0]]));
      else return;
      if (m < bestM) { bestM = m; best = seg; }
    });
    return best && bestM <= maxMeters ? best : null;
  }

  /**
   * 引いた経路を見て、余計に走らせている原因の楽しい道を見つける（RouteCandidatesView.funRouteCulprits）。
   *   0. Uターンの指示から 500m 以内（覚えない）  1. 往復の先端から 500m 以内（覚える）
   *   1-b. サーバが確かめた無駄な輪の出入口から 2km 以内（覚えない）  2. ゴールを通り過ぎた先の道（覚えない）
   * @param route 経路サーバの応答の route（app の形）。points は [経度, 緯度] に読んだ線
   * @returns {{banned: Array, forever: Array}}
   */
  function funCulprits(route, points, segments, destination, geo, fun) {
    var banned = [], forever = [];
    function ban(seg, keep) {
      if (!seg) return;
      if (keep && !forever.some(function (s) { return s.id === seg.id; })) forever.push(seg);
      if (!banned.some(function (s) { return s.id === seg.id; })) banned.push(seg);
    }
    if (points.length < 2) return { banned: banned, forever: forever };
    (route.steps || []).forEach(function (st) {
      if (typeof st.maneuver !== "string" || st.maneuver.indexOf("uturn") !== 0) return;
      ban(segmentNearestTo(points[Math.min(points.length - 1, st.beginIndex || 0)], segments, BLAME_NEAR_METERS, geo, fun), false);
    });
    geo.backtracks(points).forEach(function (b) { ban(segmentNearestTo(b.apex, segments, BLAME_NEAR_METERS, geo, fun), true); });
    (route.wastefulLoopSpans || []).forEach(function (loop) {
      [loop.begin, loop.end].forEach(function (i) {
        if (i >= 0 && i < points.length) ban(segmentNearestTo(points[i], segments, LOOP_BLAME_METERS, geo, fun), false);
      });
    });
    var passed = geo.alongWherePassedDestination(points, pair(destination));
    if (passed !== null && passed !== undefined) {
      segments.forEach(function (seg) {
        if (!seg.start || !seg.end) return;
        var mid = [(seg.start[1] + seg.end[1]) / 2, (seg.start[0] + seg.end[0]) / 2];
        var pr = geo.project(mid, points);
        if (pr && pr.along > passed) ban(seg, false);
      });
    }
    return { banned: banned, forever: forever };
  }

  /** 案の名前（RouteCandidatesView.label(for:)）。広げて作った案は「（広め）」 */
  function variantLabel(v) {
    if (v.sides && v.sides.length) {
      return v.sides.map(function (s) { return SIDE_LABELS[s]; }).join("・") + "まわり" +
        ((v.recipe && v.recipe.corridorScale > 1) ? "（広め）" : "");
    }
    return KIND_LABELS[v.kind] || KIND_LABELS.generous;
  }

  /** 遠回りの書き方（NavRoutePreference.detourDisplay）。上限までは上限に対する割合、超えたら「+○km（約○倍）」 */
  function detourText(routeMeters, baselineMeters, maxDetourRatio) {
    if (!(baselineMeters > 0)) return "";
    var raw = Math.floor((routeMeters / baselineMeters - 1) * 100);
    if (!(raw > 0)) return "";
    var ratio = 1 + raw / 100, limit = maxDetourRatio || MAX_DETOUR_RATIO;
    if (ratio > limit) {
      var extra = routeMeters - routeMeters / ratio;
      return "+" + Math.round(extra / 1000) + "km（約" + (Math.round(ratio * 10) / 10).toFixed(1) + "倍）";
    }
    return "遠回り " + Math.min(100, Math.max(0, Math.round(raw / Math.max(1, (limit - 1) * 100) * 100))) + "%";
  }

  /** 通る有料・高速の距離（重複の見分けに使う。NavRoute.tollOrExpresswayDistanceMeters） */
  function tollOrExpresswayMeters(route) { return kindMeters(route, "toll") + kindMeters(route, "expressway"); }

  /** a の点（100m おき）のうち、b の線から 30m 以内の割合（NavCandidateDedup.overlapRatio） */
  function shapeOverlap(a, b, geo) {
    if (!a.length || b.length < 2) return 0;
    var cell = 0.002, grid = {};
    function key(x, y) { return x + ":" + y; }
    for (var i = 1; i < b.length; i++) {
      var x0 = Math.floor(Math.min(b[i - 1][0], b[i][0]) / cell), x1 = Math.floor(Math.max(b[i - 1][0], b[i][0]) / cell);
      var y0 = Math.floor(Math.min(b[i - 1][1], b[i][1]) / cell), y1 = Math.floor(Math.max(b[i - 1][1], b[i][1]) / cell);
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) (grid[key(x, y)] = grid[key(x, y)] || []).push(i);
    }
    var samples = 0, near = 0, walked = 0;
    for (var k = 0; k < a.length; k++) {
      if (k > 0) walked += geo.distance(a[k - 1], a[k]);
      var isEnd = k === 0 || k === a.length - 1;
      if (!isEnd && walked < 100) continue;
      walked = 0; samples++;
      var cx = Math.floor(a[k][0] / cell), cy = Math.floor(a[k][1] / cell), hit = false;
      for (var dx = -1; dx <= 1 && !hit; dx++) for (var dy = -1; dy <= 1 && !hit; dy++) {
        (grid[key(cx + dx, cy + dy)] || []).forEach(function (j) {
          if (!hit && distanceToSegment(latLng(a[k]), latLng(b[j - 1]), latLng(b[j])) <= 30) hit = true;
        });
      }
      if (hit) near++;
    }
    return samples ? near / samples : 0;
  }

  /**
   * 候補を重ねて、同じ道になったものを畳む（NavCandidateDedup.merged）。先に来たものを残す。
   * 候補は { route, points }（points は [経度, 緯度]）
   */
  function mergeCandidates(lists, geo) {
    var out = [];
    lists.forEach(function (list) {
      (list || []).forEach(function (c) {
        var dup = out.some(function (o) {
          return Math.abs(tollOrExpresswayMeters(o.route) - tollOrExpresswayMeters(c.route)) < 1000
            && Math.abs(o.route.totalDistanceMeters - c.route.totalDistanceMeters) < 2000
            && (o.points.length < 2 || c.points.length < 2
                || (shapeOverlap(o.points, c.points, geo) >= 0.9 && shapeOverlap(c.points, o.points, geo) >= 0.9));
        });
        if (!dup) out.push(c);
      });
    });
    return out;
  }

  /**
   * 選んだ記録（user_taste/{uid}）から、楽しい道の好みの度合い（区間 → 0〜1）を作る
   * （RiderSignals.evidence(fromChoices:) → RiderChoiceTaste.make → roadAffinity(segmentFeatures)）。
   * ⚠️ アプリは投稿・いいね・口コミ・プランも材料にするが、Web は選んだ記録だけ。道の記録が無ければ null（好みを使わない）
   */
  function tasteFromChoices(doc, rider) {
    var roads = (doc && doc.roads) || {};
    var evidence = Object.keys(roads).map(function (k) {
      var it = roads[k] || {};
      return it.key ? { kind: "road", key: it.key, features: it.features || [], weight: Math.max(1, Number(it.count) || 1), source: "choice" } : null;
    }).filter(Boolean);
    if (!evidence.length) return null;
    var weights = rider.tasteFromEvidence(evidence).roads;
    return function (seg) {
      var f = rider.roadFeatures(seg.tags || [], seg.highway, seg.curviness);
      return f.length ? f.reduce(function (a, k) { return a + (weights[k] || 0); }, 0) / f.length : 0;
    };
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
              ROAD_KINDS: ROAD_KINDS, RECOMMENDED_EDGE_COLOR: RECOMMENDED_EDGE_COLOR, CANDIDATE_PALETTE: CANDIDATE_PALETTE,
              candidateColor: candidateColor, kindInfo: kindInfo,
              toDestinations: toDestinations, fitted: fitted, buildBody: buildBody, decodePolyline: decodePolyline,
              highwaysForbidden: highwaysForbidden, legDefaults: legDefaults, effectiveLeg: effectiveLeg, toggledLeg: toggledLeg,
              gapConditions: gapConditions, mixedOrNil: mixedOrNil, strictest: strictest,
              kindSegments: kindSegments, kindMeters: kindMeters, presentKinds: presentKinds,
              compositionSummary: compositionSummary, legBreakdown: legBreakdown,
              MAX_ROUTE_BYTES: MAX_ROUTE_BYTES, routeForApp: routeForApp,
              recommendedSpans: recommendedSpans, prefecturesFor: prefecturesFor,
              MIN_FUN_WEIGHT: MIN_FUN_WEIGHT, MAX_DETOUR_RATIO: MAX_DETOUR_RATIO, MAX_FUN_TRIM_ATTEMPTS: MAX_FUN_TRIM_ATTEMPTS,
              funWeightLabel: funWeightLabel, prefecturesWithin: prefecturesWithin, destinationStops: destinationStops,
              viaSequence: viaSequence, funGapConditions: funGapConditions, funLegs: funLegs, legRanges: legRanges,
              filterFunSegments: filterFunSegments, buildFunBody: buildFunBody, segmentNearestTo: segmentNearestTo,
              funCulprits: funCulprits, variantLabel: variantLabel, detourText: detourText,
              mergeCandidates: mergeCandidates, shapeOverlap: shapeOverlap, tasteFromChoices: tasteFromChoices };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSRouteMaker = api;
})(typeof window !== "undefined" ? window : this);
