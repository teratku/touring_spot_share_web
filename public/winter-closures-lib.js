/*
 * winter-closures-lib.js — 冬季閉鎖の一覧（winter-closures.html・dev/winter-closures.html）の計算。
 *
 * 利用者の要望（2026-10-25）:「webにも表示できるようにしたい」「開発用webでも追加できるようにしたい」。
 * 写した元: アプリの WinterClosureList（閉鎖中／まもなく／通れる・日数・開通日）と RoadRestriction.ActivePeriod、
 *           調整ツールの admin/lib/restrictionTime.js（normalizePeriod・monthsOfPeriod・describePeriod）。
 * ⚠️ **アプリ・調整ツールの決まりを変えたら、ここも直すこと。** service/test/winterClosuresLib.test.js がアプリと同じ例で見ている
 * 配信データは Firestore の road_restrictions/<romaji>（アプリと同じ・誰でも読める）。冬季閉鎖は kind "winterClosure"
 * ブラウザでは window.TSSWinter、テスト（node）では module.exports
 */
(function (root) {
  "use strict";

  /** 県名 → 配信のドキュメント名（admin/lib/prefectureRomaji.js と同じ綴り） */
  var ROMAJI = {
    北海道: "hokkaido", 青森県: "aomori", 岩手県: "iwate", 宮城県: "miyagi", 秋田県: "akita",
    山形県: "yamagata", 福島県: "fukushima", 茨城県: "ibaraki", 栃木県: "tochigi", 群馬県: "gunma",
    埼玉県: "saitama", 千葉県: "chiba", 東京都: "tokyo", 神奈川県: "kanagawa", 新潟県: "niigata",
    富山県: "toyama", 石川県: "ishikawa", 福井県: "fukui", 山梨県: "yamanashi", 長野県: "nagano",
    岐阜県: "gifu", 静岡県: "shizuoka", 愛知県: "aichi", 三重県: "mie", 滋賀県: "shiga",
    京都府: "kyoto", 大阪府: "osaka", 兵庫県: "hyogo", 奈良県: "nara", 和歌山県: "wakayama",
    鳥取県: "tottori", 島根県: "shimane", 岡山県: "okayama", 広島県: "hiroshima", 山口県: "yamaguchi",
    徳島県: "tokushima", 香川県: "kagawa", 愛媛県: "ehime", 高知県: "kochi", 福岡県: "fukuoka",
    佐賀県: "saga", 長崎県: "nagasaki", 熊本県: "kumamoto", 大分県: "oita", 宮崎県: "miyazaki",
    鹿児島県: "kagoshima", 沖縄県: "okinawa",
  };

  /** 「まもなく」に入れる日数（WinterClosureList.soonDays） */
  var SOON_DAYS = 30;
  var STATUS = { closed: 0, soon: 1, open: 2 };
  var LAST_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // ---- 期間（restrictionTime.js と同じ） ----

  /** "11-15"・"11/15" → 1115。読めなければ null */
  function parseMonthDay(text) {
    if (typeof text !== "string") return null;
    var m = text.trim().match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (!m) return null;
    var month = Number(m[1]), day = Number(m[2]);
    if (!(month >= 1 && month <= 12)) return null;
    if (!(day >= 1 && day <= LAST_DAY[month - 1])) return null;
    return month * 100 + day;
  }
  function formatMonthDay(v) {
    return String(Math.floor(v / 100)).padStart(2, "0") + "-" + String(v % 100).padStart(2, "0");
  }
  /** 保存できる形 { from: "11-15", to: "04-24" }。片方だけ・読めないものは null */
  function normalizePeriod(period) {
    if (!period) return null;
    var from = parseMonthDay(period.from), to = parseMonthDay(period.to);
    if (from === null || to === null) return null;
    return { from: formatMonthDay(from), to: formatMonthDay(to) };
  }
  /** 期間がかかる月（古いアプリ向けの activeMonths） */
  function monthsOfPeriod(period) {
    var p = normalizePeriod(period);
    if (!p) return null;
    var from = parseMonthDay(p.from), to = parseMonthDay(p.to);
    var first = Math.floor(from / 100), last = Math.floor(to / 100), months = [];
    if (first === last && from > to) {
      for (var i = 0; i < 12; i++) months.push(((first - 1 + i) % 12) + 1);
      return months;
    }
    for (var m = first; ; m = (m % 12) + 1) { months.push(m); if (m === last) break; }
    return months;
  }
  /** 「11/15〜4/24」 */
  function describePeriod(period) {
    var p = normalizePeriod(period);
    if (!p) return "";
    var t = function (v) { return Math.floor(v / 100) + "/" + (v % 100); };
    return t(parseMonthDay(p.from)) + "〜" + t(parseMonthDay(p.to));
  }
  /** 入力欄の形（"11/15"） */
  function periodText(value) {
    var v = parseMonthDay(value || "");
    return v === null ? "" : Math.floor(v / 100) + "/" + (v % 100);
  }
  function periodContains(period, monthDay) {
    var p = normalizePeriod(period);
    if (!p) return true;
    var from = parseMonthDay(p.from), to = parseMonthDay(p.to);
    return from <= to ? (monthDay >= from && monthDay <= to) : (monthDay >= from || monthDay <= to);
  }

  // ---- 一覧（WinterClosureList と同じ） ----

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 86400000); }
  /** その月日が今日以降で次に来る日（今日なら今日） */
  function nextDate(monthDay, today) {
    var start = startOfDay(today);
    for (var y = today.getFullYear(); y <= today.getFullYear() + 1; y++) {
      var d = new Date(y, Math.floor(monthDay / 100) - 1, monthDay % 100);
      if (d >= start) return d;
    }
    return start;
  }
  /** 月の指定（期間が無い古い登録）でいま閉まっているか */
  function closedByMonths(r, today) {
    var months = Array.isArray(r.activeMonths) ? r.activeMonths : [];
    return !months.length || months.indexOf(today.getMonth() + 1) >= 0;
  }
  /** 「11/15〜4/24」か「12・1・2・3月」 */
  function scheduleOf(r) {
    var period = describePeriod(r.activePeriod);
    if (period) return period;
    var months = Array.isArray(r.activeMonths) ? r.activeMonths : [];
    return months.length && months.length < 12 ? months.join("・") + "月" : "";
  }

  function entryOf(r, today) {
    var base = { name: r.name, prefecture: r.prefecture || "", schedule: scheduleOf(r), note: r.note || "",
                 checkedAt: r.checkedAt || "", id: r.id, days: null, reopens: null };
    var p = normalizePeriod(r.activePeriod);
    if (!p) {
      base.status = closedByMonths(r, today) ? "closed" : "open";
      return base;
    }
    var start = parseMonthDay(p.from), end = parseMonthDay(p.to);
    var monthDay = (today.getMonth() + 1) * 100 + today.getDate();
    if (periodContains(p, monthDay)) {
      // 開通は終わりの翌日
      var last = nextDate(end, today);
      var reopen = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
      base.status = "closed";
      base.days = daysBetween(today, reopen);
      base.reopens = (reopen.getMonth() + 1) + "/" + reopen.getDate();
      return base;
    }
    var days = daysBetween(today, nextDate(start, today));
    base.status = days <= SOON_DAYS ? "soon" : "open";
    base.days = days;
    return base;
  }

  /**
   * 冬季閉鎖の行。閉鎖中 → まもなく → 通れる、同じ並びの中は日数の近い順（日数の無いものは後ろ）→ 名前。
   * ⚠️ 同じ道が区間ごとに登録されていても、県・名前・期間が同じなら1行（アプリと同じ）
   */
  function entries(restrictions, today) {
    today = today || new Date();
    var seen = {}, out = [];
    (restrictions || []).forEach(function (r) {
      if (!r || r.kind !== "winterClosure") return;
      var e = entryOf(r, today);
      var key = e.prefecture + "|" + e.name + "|" + e.schedule;
      if (seen[key]) return;
      seen[key] = true;
      out.push(e);
    });
    return out.sort(function (a, b) {
      if (a.status !== b.status) return STATUS[a.status] - STATUS[b.status];
      if (a.days !== null && b.days !== null && a.days !== b.days) return a.days - b.days;
      if (a.days !== null && b.days === null) return -1;
      if (a.days === null && b.days !== null) return 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }

  /** 右に出す文言（「4/25 開通予定（あと1日）」「あと13日で閉鎖」） */
  function statusText(e) {
    if (e.days === null) return "";
    if (e.status === "closed") return e.reopens ? e.reopens + " 開通予定（あと" + e.days + "日）" : "";
    return e.days === 0 ? "今日から閉鎖" : "あと" + e.days + "日で閉鎖";
  }

  /** 位置からいちばん当てはまる県（囲みが重なるときは小さい囲み。アプリと同じ） */
  function prefectureAt(lat, lng, prefectures) {
    var best = null, bestArea = Infinity;
    (prefectures || []).forEach(function (p) {
      var b = p.bounds;
      if (lat < b.latMin || lat > b.latMax || lng < b.lngMin || lng > b.lngMax) return;
      var area = (b.latMax - b.latMin) * (b.lngMax - b.lngMin);
      if (area < bestArea) { best = p.name; bestArea = area; }
    });
    return best;
  }

  var api = {
    ROMAJI: ROMAJI, SOON_DAYS: SOON_DAYS,
    parseMonthDay: parseMonthDay, normalizePeriod: normalizePeriod, monthsOfPeriod: monthsOfPeriod,
    describePeriod: describePeriod, periodText: periodText, periodContains: periodContains,
    entries: entries, statusText: statusText, prefectureAt: prefectureAt,
  };
  root.TSSWinter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
