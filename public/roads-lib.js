/*
 * roads-lib.js — Web のおすすめ道路の一覧（roads.html）の計算。アプリの発見タブの「道」と同じ決まり。
 *
 * 利用者の要望（2026-10-12）:「web にもアプリと同じようにおすすめ道路のリストを表示するようにしたい。サブスクの内容も含む」。
 * 写した元（アプリ）: EnjoyableRoadsService（grouped・limited・listRoads・mapRoads・visibleForTier・fetchLimit・
 *   prefecturesWithin）、RoadFilter・RoadKindGroup、RoadSort、RoadTag、RoadToll、ScoredRoad.windingStars、EnjoyableRoadRow.highwayLabel。
 * ⚠️ **アプリの決まりを変えたら、ここも直すこと。** service/test/roadsLib.test.js がアプリと同じ例で見ている
 * ⚠️ 走行済み（RoadDex）・あなた向け（好み）は Web に無いので入れていない
 * ブラウザでは window.TSSRoads、テスト（node）では module.exports
 */
(function (root) {
  "use strict";

  /** 範囲のつまみ（km）。最後は全国（EnjoyableRoadsService.nationwideRadiusKm） */
  var NATIONWIDE_KM = 4000;
  var RADIUS_PRESETS = [30, 50, 100, NATIONWIDE_KM];
  /** 無料の人に一覧で見せる本数（残りは「Plusで残り○件を見る」） */
  var FREE_VISIBLE_COUNT = 3;
  /** 全国のときに地図へ一度に描く上限（見えている範囲の点数の高い順） */
  var NATIONWIDE_MAP_CAP = 400;
  /** 人気に載せる下限（PopularityBoard.minUsers） */
  var MIN_POPULAR_USERS = 3;

  // ---- 札（RoadTag）・道の種類（RoadKindGroup）・有料（RoadToll） ----

  var TAG_LABELS = { scenic: "絶景", winding: "ワインディング", flowing: "快走", forest: "林道ぎみ",
                     caution: "要注意", gravel: "砂利道", deadend: "行き止まり", toll: "有料道路" };
  var LEGACY_JA = {};
  Object.keys(TAG_LABELS).forEach(function (k) { LEGACY_JA[TAG_LABELS[k]] = k; });
  /** 絞り込みに出す札（走る楽しさで選ぶ順） */
  var FILTERABLE_TAGS = ["scenic", "winding", "flowing", "forest"];

  /** 札を鍵に直す（古い配信データの日本語も）。知らないものはそのまま */
  function tagKey(raw) { var t = String(raw == null ? "" : raw).trim(); return LEGACY_JA[t] || t; }
  /** 札の表示名。知らないものはそのまま */
  function tagLabel(raw) { var k = tagKey(raw); return TAG_LABELS[k] || k; }

  var KINDS = [{ key: "national", label: "国道" }, { key: "prefectural", label: "県道" }, { key: "other", label: "その他の道" }];
  /** 道の種類（trunk＝一般国道、primary/secondary＝都道府県道、ほか） */
  function kindGroup(highway) {
    if (highway === "trunk") return "national";
    if (highway === "primary" || highway === "secondary") return "prefectural";
    return "other";
  }
  /** 一覧の行に添える種類の名前（EnjoyableRoadRow.highwayLabel） */
  function highwayLabel(highway) {
    return { trunk: "国道", primary: "主要道", secondary: "県道級", tertiary: "生活道" }[highway] || highway;
  }

  /** 区間が有料か（RoadToll.of）。古い札「有料道路」も有料 */
  function tollKind(seg) {
    if (seg && (seg.toll === "full" || seg.toll === "partial")) return seg.toll;
    return ((seg && seg.tags) || []).some(function (t) { return tagKey(t) === "toll"; }) ? "full" : null;
  }
  /** まとめた道（RoadToll.merged）。全部が有料なら有料、どれかが有料なら一部有料 */
  function mergedToll(kinds) {
    if (!kinds.some(function (k) { return !!k; })) return null;
    return kinds.every(function (k) { return k === "full"; }) ? "full" : "partial";
  }

  /** 曲がり具合の星（ScoredRoad.windingStars） */
  function windingStars(curviness) {
    if (curviness < 40) return 1;
    if (curviness < 90) return 2;
    if (curviness < 160) return 3;
    if (curviness < 260) return 4;
    return 5;
  }

  // ---- 範囲 ----

  function isNationwide(radiusKm) { return radiusKm >= NATIONWIDE_KM; }
  function radiusLabel(radiusKm) { return isNationwide(radiusKm) ? "全国" : Math.round(radiusKm) + "km"; }
  /** 一覧に出す本数。全国では増やす（近場で埋まって遠くの道が出ないため） */
  function fetchLimit(radiusKm, base) { return isNationwide(radiusKm) ? Math.max(base, 120) : base; }

  /** 2点の距離（m・球面）。点は {lat, lng} */
  function distance(a, b) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** 半径に重なる都道府県（配信は県ごと）。prefectures は prefecture-data.js の PREFECTURES */
  function prefecturesWithin(center, radiusKm, prefectures) {
    var latDelta = radiusKm / 111.0, lonDelta = radiusKm / (111.0 * Math.cos(center.lat * Math.PI / 180));
    return (prefectures || []).filter(function (pf) {
      var b = pf.bounds;
      return b.latMin <= center.lat + latDelta && b.latMax >= center.lat - latDelta
        && b.lngMin <= center.lng + lonDelta && b.lngMax >= center.lng - lonDelta;
    }).map(function (pf) { return pf.name; });
  }

  /** 始点が半径の中にある区間だけ（EnjoyableRoadsService.convert） */
  function withinRadius(segments, center, radiusKm) {
    var limit = radiusKm * 1000;
    return (segments || []).filter(function (s) {
      return Array.isArray(s.start) && s.start.length === 2 && distance(center, { lat: s.start[0], lng: s.start[1] }) <= limit;
    });
  }

  // ---- 同じ道路をまとめる（EnjoyableRoadsService.grouped） ----

  /** まとめる鍵。⚠️ 県と道の種類まで入れる（番号は国道と県道・県どうしで重複する） */
  function groupKey(prefecture, ref, name, highway) {
    var number = String(ref || "").trim();
    return number ? "r:" + prefecture + "|" + number + "|" + highway : "n:" + prefecture + "|" + name + "|" + highway;
  }
  /** 人が手を入れた区間か（手直しした区間は1本の道として独立させる） */
  function isAdjusted(seg) { return seg.reshaped === true || (Number(seg.boost) || 0) !== 0; }
  function displayName(seg) { return seg.title || seg.name; }
  function prefectureOf(seg) { return String(seg.id || "").split(":")[0]; }

  /** 見出し: 表示名 → 路線番号を含む名前 → いちばん長い区間の名前（番号から道路名を組み立てない） */
  function headlineName(parts, longest) {
    var titled = parts.filter(function (p) { return p.title; })[0];
    if (titled) return displayName(titled);
    var number = String(longest.ref || "").trim();
    if (number) {
      var numbered = parts.filter(function (p) { return String(p.name || "").indexOf(number) >= 0; })
        .sort(function (a, b) { return b.lengthKm - a.lengthKm; })[0];
      if (numbered) return displayName(numbered);
    }
    return displayName(longest);
  }

  function grouped(segments) {
    var order = [], buckets = {};
    (segments || []).forEach(function (s) {
      if (!s.polyline) return;
      var key = isAdjusted(s) ? "s:" + s.id : groupKey(prefectureOf(s), s.ref, s.name, s.highway);
      if (!buckets[key]) { buckets[key] = []; order.push(key); }
      buckets[key].push(s);
    });
    var out = [];
    order.forEach(function (key) {
      var parts = buckets[key];
      var longest = parts.slice().sort(function (a, b) { return b.lengthKm - a.lengthKm; })[0];
      if (!longest || !Array.isArray(longest.start)) return;
      var total = parts.reduce(function (a, p) { return a + (Number(p.lengthKm) || 0); }, 0);
      if (!(total > 0)) return;
      // ⚠️ 曲がり具合と点数は長さで重み付けして平均する（短い峠1本で長い幹線が上に来ないように）
      var weighted = function (f) { return parts.reduce(function (a, p) { return a + f(p) * p.lengthKm; }, 0) / total; };
      var tags = [];
      parts.forEach(function (p) { (p.tags || []).forEach(function (t) { if (tags.indexOf(t) < 0) tags.push(t); }); });
      tags.sort();
      var tollKms = parts.map(function (p) {
        var k = tollKind(p);
        return !k ? null : p.tollKm != null ? Number(p.tollKm) : k === "full" ? Number(p.lengthKm) : null;
      }).filter(function (v) { return v != null; });
      out.push({
        id: key,
        name: headlineName(parts, longest),
        highway: longest.highway,
        lengthKm: total,
        curvinessDegPerKm: weighted(function (p) { return Number(p.curviness) || 0; }),
        score: weighted(function (p) { return Number(p.score) || 0; }),
        polylines: parts.map(function (p) { return p.polyline; }),
        representative: { lat: longest.start[0], lng: longest.start[1] },
        note: (parts.filter(function (p) { return p.note; })[0] || {}).note || null,
        tags: tags,
        ref: String(longest.ref || "").trim(),
        toll: mergedToll(parts.map(tollKind)),
        tollKm: tollKms.length ? tollKms.reduce(function (a, b) { return a + b; }, 0) : null,
        isAdjusted: parts.some(isAdjusted),
        parts: parts.slice().sort(function (a, b) { return b.lengthKm - a.lengthKm; })
          .map(function (p) { return { id: p.id, name: displayName(p), lengthKm: p.lengthKm }; }),
      });
    });
    return out.sort(function (a, b) { return b.score - a.score; });
  }

  // ---- 一覧と地図に出す道（発見タブ・ルート作成の「道」・プランの「道」と同じ決まり） ----

  /** 上位 limit 本。⚠️ 人が手を入れた道は順位で切り落とさない（下げた手直しを確かめられなくなる） */
  function limited(roads, limit) {
    if (roads.length <= limit) return roads;
    var kept = {};
    roads.slice(0, limit).forEach(function (r) { kept[r.id] = true; });
    roads.slice(limit).forEach(function (r) { if (r.isAdjusted) kept[r.id] = true; });
    return roads.filter(function (r) { return kept[r.id]; });
  }

  /** 絞り込み（RoadFilter）。同じ種類の中は「どれか」、種類どうしは「かつ」。何も選ばなければ絞らない */
  function isFilterActive(filter) { return !!filter && ((filter.tags || []).length > 0 || (filter.kinds || []).length > 0); }
  function applyFilter(roads, filter) {
    if (!isFilterActive(filter)) return roads;
    return roads.filter(function (r) {
      if ((filter.kinds || []).length && filter.kinds.indexOf(kindGroup(r.highway)) < 0) return false;
      if ((filter.tags || []).length && !r.tags.some(function (t) { return filter.tags.indexOf(tagKey(t)) >= 0; })) return false;
      return true;
    });
  }

  /** 一覧の道。⚠️ 絞り込むときは範囲の道全部から絞ってから上位を取る（切ってから絞ると数本しか残らない） */
  function listRoads(roads, all, filter, limit) {
    if (!isFilterActive(filter)) return roads;
    return limited(applyFilter(all, filter), limit);
  }

  /** 無料の人に見せる道（上位3本）。課金している人は全部 */
  function visibleForTier(roads, unlimited) { return unlimited ? roads : roads.slice(0, FREE_VISIBLE_COUNT); }

  /** 地図に描く道。課金している人は範囲の道を全部（絞り込みは掛ける）、無料の人は一覧と同じ */
  function mapRoads(all, visible, filter, unlimited) {
    if (!unlimited || !all.length) return visible;
    return applyFilter(all, filter);
  }

  // ---- 並べ替え（RoadSort）。⚠️ 同点は点数 → id で必ず決める（開き直すたびに並びが変わらないように） ----

  var SORTS = [{ key: "score", label: "おすすめ順" }, { key: "popular", label: "人気順" }, { key: "curviness", label: "曲がりの多い順" },
               { key: "length", label: "長い順" }, { key: "distance", label: "近い順" }, { key: "name", label: "名前順" }];

  function sortRoads(roads, sort, origin, popularity) {
    var tie = function (a, b) { return a.score !== b.score ? b.score - a.score : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); };
    var by = function (f) { return roads.slice().sort(function (a, b) { var d = f(a, b); return d !== 0 ? d : tie(a, b); }); };
    switch (sort) {
      case "popular": return by(function (a, b) { return ((popularity || {})[b.id] || 0) - ((popularity || {})[a.id] || 0); });
      case "curviness": return by(function (a, b) { return b.curvinessDegPerKm - a.curvinessDegPerKm; });
      case "length": return by(function (a, b) { return b.lengthKm - a.lengthKm; });
      case "name": return by(function (a, b) { return a.name.localeCompare(b.name, "ja"); });
      case "distance":
        // ⚠️ 場所が分からなければ黙って別の順にしない。おすすめ順
        if (!origin) return by(function () { return 0; });
        return by(function (a, b) { return distance(origin, a.representative) - distance(origin, b.representative); });
      default: return by(function () { return 0; });
    }
  }

  /** popularity/roads の文書 → 道のまとめキー → 選んだ人数（3人未満は載せない。PopularityBoard.roadUsers） */
  function popularRoadUsers(doc) {
    var out = {};
    ((doc && doc.items) || []).forEach(function (it) {
      var users = Number(it && it.users);
      if (it && it.key && users >= MIN_POPULAR_USERS) out[it.key] = Math.max(out[it.key] || 0, users);
    });
    return out;
  }

  /** Google Encoded Polyline → [{lat, lng}] */
  function decodePolyline(str) {
    var idx = 0, lat = 0, lng = 0, out = [];
    str = String(str || "");
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

  var api = {
    decodePolyline: decodePolyline,
    NATIONWIDE_KM: NATIONWIDE_KM, RADIUS_PRESETS: RADIUS_PRESETS, FREE_VISIBLE_COUNT: FREE_VISIBLE_COUNT,
    NATIONWIDE_MAP_CAP: NATIONWIDE_MAP_CAP, FILTERABLE_TAGS: FILTERABLE_TAGS, KINDS: KINDS, SORTS: SORTS,
    tagKey: tagKey, tagLabel: tagLabel, kindGroup: kindGroup, highwayLabel: highwayLabel, tollKind: tollKind, mergedToll: mergedToll,
    windingStars: windingStars, isNationwide: isNationwide, radiusLabel: radiusLabel, fetchLimit: fetchLimit, distance: distance,
    prefecturesWithin: prefecturesWithin, withinRadius: withinRadius, groupKey: groupKey, grouped: grouped, limited: limited,
    isFilterActive: isFilterActive, applyFilter: applyFilter, listRoads: listRoads, visibleForTier: visibleForTier,
    mapRoads: mapRoads, sortRoads: sortRoads, popularRoadUsers: popularRoadUsers,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSRoads = api;
})(typeof window !== "undefined" ? window : this);
