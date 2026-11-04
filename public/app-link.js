/*
 * app-link.js — App Store へのリンクを、どこから来た人がどこで押したか分かるようにする。
 *
 * 利用者の要望（2026-11-04）「X からアプリを繋ぐ」。4週間で X（t.co）から18人来たが1人1.1回で帰り、
 * アプリを入れたかは追えなかった。
 *
 *   ・App Store へのリンク（apps.apple.com の id1466607921）を押したら GA4 に app_store_click を送る
 *     （page・placement・landing_source）。X → Web → App Store の数がこれで分かる
 *   ・App Store Connect のキャンペーン（pt＝提供元トークン・ct＝キャンペーン名）を押したときに付ける。
 *     ⚠️ PROVIDER_TOKEN が空のうちは付けない（pt の無い ct はストアで数えられない）
 *   ・`data-app-cta` を付けた要素に、アプリの案内（App Store のバッジつき）を入れる
 *
 * 使い方: <script defer src="/app-link.js?v=1"></script>（analytics.js の後。⚠️ JS は1年キャッシュ。変えたら全ページの ?v= を上げる）
 */
(function (root) {
  "use strict";

  var APP_ID = "1466607921";
  /** App Store Connect →「アプリ分析」→「キャンペーンリンクを生成」の pt= の数字。空なら ct を付けない */
  var PROVIDER_TOKEN = "";
  var LANDING_KEY = "tss.landingSource";

  /** 最初に来たときの経路。utm_source が先、なければ参照元のホスト（X は "x" にまとめる）、どちらも無ければ direct */
  function landingSource(search, referrer, ownHost) {
    try {
      var utm = new URLSearchParams(search || "").get("utm_source");
      if (utm) return clean(utm);
    } catch (e) { /* 読めなければ参照元で決める */ }
    var host = "";
    try { host = referrer ? new URL(referrer).hostname : ""; } catch (e) { host = ""; }
    if (!host || host === ownHost) return "direct";
    if (host === "t.co" || host === "x.com" || host === "twitter.com" || /\.(x|twitter)\.com$/.test(host)) return "x";
    return clean(host.replace(/^www\./, ""));
  }

  /** 英数字とハイフンだけにする（GA4 の値・ストアのキャンペーン名に使う） */
  function clean(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "unknown";
  }

  /** ページの名前（/winter-closures.html → winter-closures、/ と /index.html → top） */
  function pageName(pathname) {
    var name = String(pathname || "").split("/").pop().replace(/\.html$/, "");
    return name && name !== "index" ? clean(name) : "top";
  }

  /** ストアのキャンペーン名。⚠️ ストアは40文字まで */
  function campaignToken(page, source) {
    return ("web-" + page + "-" + source).slice(0, 40);
  }

  function isAppStoreUrl(href) {
    return /^https:\/\/apps\.apple\.com\//.test(String(href || "")) && String(href).indexOf("id" + APP_ID) >= 0;
  }

  /** キャンペーンを付けた App Store の URL。pt が空なら元のまま */
  function withCampaign(href, pt, ct) {
    if (!pt || !isAppStoreUrl(href)) return href;
    var url = new URL(href);
    url.searchParams.set("pt", pt);
    url.searchParams.set("ct", ct);
    url.searchParams.set("mt", "8");
    return url.toString();
  }

  var api = {
    APP_ID: APP_ID, landingSource: landingSource, pageName: pageName, campaignToken: campaignToken,
    isAppStoreUrl: isAppStoreUrl, withCampaign: withCampaign,
  };
  root.TSSAppLink = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ---- ここから下はブラウザだけ ----

  /** その回（タブ）で最初に来たページの経路を覚える。サイトの中を移っても上書きしない */
  function rememberedSource() {
    try {
      var saved = sessionStorage.getItem(LANDING_KEY);
      if (saved) return saved;
      var src = landingSource(location.search, document.referrer, location.hostname);
      sessionStorage.setItem(LANDING_KEY, src);
      return src;
    } catch (e) {
      return landingSource(location.search, document.referrer, location.hostname);
    }
  }
  var source = rememberedSource();
  var page = pageName(location.pathname);

  /** どこのリンクか（data-placement を持つ近くの要素。無ければ link） */
  function placementOf(a) {
    var host = a.closest("[data-placement]");
    return host ? clean(host.getAttribute("data-placement")) : "link";
  }

  // ⚠️ 押した瞬間に付ける（あとから足されるリンク＝share.js のバナー・Vue の画面にも効く）
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || !isAppStoreUrl(a.href)) return;
    var placement = placementOf(a);
    a.href = withCampaign(a.href, PROVIDER_TOKEN, campaignToken(page, source));
    if (root.TSSAnalytics) root.TSSAnalytics.logEvent("app_store_click", { page: page, placement: placement, landing_source: source });
  }, true);

  /** アプリの案内。文は data-app-cta の値（無ければ決まった文） */
  function fillCta(box) {
    var text = box.getAttribute("data-app-cta") || "アプリなら、走る道を探してそのままナビできます。";
    if (!box.hasAttribute("data-placement")) box.setAttribute("data-placement", "cta");
    box.innerHTML =
      '<p style="font-weight:700;font-size:16px;margin:0 0 6px">📱 アプリでもっと便利に</p>' +
      '<p style="margin:0 0 12px;line-height:1.6"></p>' +
      '<a href="https://apps.apple.com/jp/app/id' + APP_ID + '" target="_blank" rel="noopener" style="display:inline-block">' +
      '<img src="https://developer.apple.com/app-store/marketing/guidelines/images/badge-download-on-the-app-store.svg" ' +
      'alt="App Store からダウンロード" style="height:44px;display:block"></a>';
    box.querySelectorAll("p")[1].textContent = text;
  }
  function init() {
    var boxes = document.querySelectorAll("[data-app-cta]");
    for (var i = 0; i < boxes.length; i++) fillCta(boxes[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof window !== "undefined" ? window : globalThis);
