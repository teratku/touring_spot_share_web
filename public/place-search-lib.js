/*
 * place-search-lib.js — Web で場所を入力して探す（住所・施設名・座標）ときの計算部分（純ロジック）。
 *
 * 利用者の要望（2026-10-15）:「アプリ/web のルート生成画面で「目的地を決める」と同じように入力して位置を決めれるようにしたい。
 * 検索の履歴も「目的地を決める」と共通化したい」。判断: Web は Google の場所検索。履歴は Web の中（この端末のブラウザ）で共通。
 *
 * ⚠️ アプリと同じ決めごとにすること（片方だけ変えない）:
 *    - 座標の読み方: CoordinateParser.parse（"35.68,139.76"・"N35.68 E139.76"・度分秒・全角・読点）
 *    - 探し方: DestinationSearchService.search（座標なら通信しない → 場所の候補 → 0件のときだけ住所として探す）
 *    - 履歴: DestinationHistoryStore（同じ場所は先頭へ動かすだけ・20件まで）
 *    - 地図で選んだ所の名前: DestinationSearchService.describe（「日本、」と郵便番号を落とす）
 *    - プランに入れる形: TouringSpot.toDict（場所はカスタムピン isCustomPin: true）
 * ⚠️ ブラウザでは window.TSSPlaceSearch、テスト（node）では module.exports
 */
(function (root) {
  /** 打ちながら探す文字数（「目的地を決める」と同じ。Enter なら1文字でも探す） */
  var MIN_QUERY_LENGTH = 2;
  /** 履歴の件数（DestinationHistoryStore.historyLimit） */
  var HISTORY_LIMIT = 20;
  /** 履歴の置き場（この端末のブラウザ。Web の中で共通） */
  var HISTORY_KEY = "tss.placeSearch.history";
  /** 1つのプランに入れられる数（サブスク。TouringPlanLimits.subscribedSpotsPerPlan・roads-lib.js の spotsPerPlan と同じ） */
  var SPOTS_PER_PLAN = 10;

  function searchable(query) { return String(query || "").trim().length >= MIN_QUERY_LENGTH; }

  function validated(lat, lng) {
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) return null;
    return { lat: lat, lng: lng };
  }

  /** 度分秒（35°40'54"N 139°46'1"E） */
  function parseDMS(s) {
    var re = /(\d+)[°度]\s*(\d+)['′分]\s*([\d.]+)["″秒]?\s*([NSEW])/gi, m, lat = null, lng = null, count = 0;
    while ((m = re.exec(s))) {
      count++;
      var v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600, h = m[4].toUpperCase();
      if (h === "S" || h === "W") v = -v;
      if (h === "N" || h === "S") lat = v; else lng = v;
    }
    if (count !== 2 || lat == null || lng == null) return null;
    return validated(lat, lng);
  }

  /** 十進（N/S/E/W は符号として先に読む） */
  function parseDecimal(s) {
    var text = s.toUpperCase(), latSign = 1, lngSign = 1, hemisphere = false;
    if (text.indexOf("S") >= 0) { latSign = -1; hemisphere = true; }
    if (text.indexOf("W") >= 0) { lngSign = -1; hemisphere = true; }
    if (text.indexOf("N") >= 0 || text.indexOf("E") >= 0) hemisphere = true;
    text = text.replace(/[NSEW]/g, " ").replace(/,/g, " ");
    var parts = text.split(/[ \t]+/).filter(function (x) { return x !== ""; });
    if (parts.length !== 2) return null;
    var nums = parts.map(function (x) { return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(x) ? Number(x) : NaN; });
    if (!isFinite(nums[0]) || !isFinite(nums[1])) return null;
    var lat = nums[0], lng = nums[1];
    if (hemisphere) { lat = Math.abs(lat) * latSign; lng = Math.abs(lng) * lngSign; }
    return validated(lat, lng);
  }

  /** 座標として読めれば {lat, lng}、読めなければ null（CoordinateParser.parse と同じ） */
  function parseCoordinate(raw) {
    var s = String(raw == null ? "" : raw).normalize("NFKC");
    s = s.replace(/[、，､]/g, ",").trim();
    if (!s) return null;
    return parseDMS(s) || parseDecimal(s);
  }

  /** 座標で打ったときの候補（通信しない） */
  function coordinateCandidate(c) {
    return { id: "coord:" + c.lat + "," + c.lng, name: c.lat.toFixed(5) + ", " + c.lng.toFixed(5), address: "座標で指定",
             lat: c.lat, lng: c.lng, kind: "coordinate" };
  }

  /** 住所の書き方を読みやすくする（「日本、」と郵便番号を落とす。DestinationSearchService.describe と同じ） */
  function cleanAddress(formatted) {
    return String(formatted || "").replace("日本、", "").replace(/^〒\d{3}-\d{4}\s*/, "").trim();
  }

  // ---- 履歴（DestinationHistoryStore と同じ） ----

  /** 場所を履歴の先頭に積んだもの。同じ場所（id）は先頭へ動かすだけで重ねない。座標の無いものは積まない */
  function recordedHistory(list, place, now) {
    if (!place || !isFinite(place.lat) || !isFinite(place.lng) || !String(place.name || "").trim()) return (list || []).slice();
    var entry = { id: String(place.id || "coord:" + place.lat + "," + place.lng), name: String(place.name).slice(0, 100),
                  address: place.address ? String(place.address).slice(0, 200) : null, lat: place.lat, lng: place.lng,
                  savedAt: now || Date.now() };
    var rest = (list || []).filter(function (h) { return h && h.id !== entry.id; });
    return [entry].concat(rest).slice(0, HISTORY_LIMIT);
  }

  function removedHistory(list, id) { return (list || []).filter(function (h) { return h && h.id !== id; }); }

  /** 置き場から読んだものを確かめる（壊れた値・古い形は捨てる） */
  function readHistory(text) {
    try {
      var list = JSON.parse(text || "[]");
      return Array.isArray(list) ? list.filter(function (h) { return h && h.id && h.name && isFinite(h.lat) && isFinite(h.lng); }).slice(0, HISTORY_LIMIT) : [];
    } catch (e) { return []; }
  }

  // ---- プランに入れる ----

  /** 探した場所をプランの1件にする（TouringSpot.toDict のカスタムピン。⚠️ spotId は入れない＝投稿のスポットではない） */
  function placeSpot(place) {
    var spot = { name: String(place.name || "").slice(0, 100), lat: place.lat, lng: place.lng, isCustomPin: true, order: 0 };
    // ⚠️ 座標で打った場所の「座標で指定」は住所ではないので入れない
    if (place.address && place.kind !== "coordinate") spot.address = String(place.address).slice(0, 200);
    return spot;
  }

  /**
   * 並んだプランの行き先（order 順）に場所を入れたもの。
   * mode: "goal"（最後に足す）・"waypoint"（ゴールの手前）・"start"（最初＝出発地）・"replace"（target を置き換える）
   * ⚠️ 置き換えは元の1件を探して同じ位置に置く（番号は「最初の場所から」で1つずれるので、元のスポットで探す）
   */
  function placedSpots(sorted, spot, mode, target) {
    var list = (sorted || []).slice();
    if (mode === "replace") {
      var i = list.indexOf(target);
      if (i < 0) return list;
      list[i] = spot;
      return list;
    }
    if (mode === "start") return [spot].concat(list);
    if (mode === "waypoint" && list.length) { list.splice(list.length - 1, 0, spot); return list; }
    return list.concat([spot]);
  }

  /** プランの行き先の番号で、入れた場所の番号（区間ごとの設定を同じ位置に空けるため） */
  function placedIndex(count, mode) {
    if (mode === "start") return 0;
    if (mode === "waypoint" && count) return count - 1;
    return count;
  }

  /** プランにまだ入れられるか（置き換えは数が増えない） */
  function canAdd(count, mode) { return mode === "replace" || count < SPOTS_PER_PLAN; }

  var api = {
    MIN_QUERY_LENGTH: MIN_QUERY_LENGTH, HISTORY_LIMIT: HISTORY_LIMIT, HISTORY_KEY: HISTORY_KEY, SPOTS_PER_PLAN: SPOTS_PER_PLAN,
    searchable: searchable, parseCoordinate: parseCoordinate, coordinateCandidate: coordinateCandidate, cleanAddress: cleanAddress,
    recordedHistory: recordedHistory, removedHistory: removedHistory, readHistory: readHistory,
    placeSpot: placeSpot, placedSpots: placedSpots, placedIndex: placedIndex, canAdd: canAdd,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TSSPlaceSearch = api;
})(typeof window !== "undefined" ? window : this);
