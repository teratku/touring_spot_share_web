/*
 * analytics.js — 公開Web用：GA4(Firebase Analytics)計測の共通ユーティリティ。
 *
 * 前提: ページで Firebase（compat, firebase-analytics-compat.js 込み）を初期化済みであること。
 *
 * 使い方:
 *   <script src="/analytics.js?v=2" defer></script>   ← Firebase各scriptの後、末尾に配置（⚠️ JS は1年キャッシュ。変えたら全ページの ?v= を上げる）
 *   TSSAnalytics.logEvent('view_spot', { item_id: spotId });
 *
 * subscription.js とは異なり、読込時に即座に firebase.analytics() を初期化する（＝自動計測の
 * page_view/session_start/first_visit をこの1回のみ発火させる）。ページ側から
 * logEvent('page_view', ...) を手動で呼ばないこと（二重計上になる）。
 *
 * 広告ブロッカー等で analytics-compat.js が読み込まれない場合、logEvent は黙って何もしない
 * （ページの動作を壊さない）。
 */
window.TSSAnalytics = (function () {
  let instance = null;
  let ready = false;
  let bootAttempted = false;

  /**
   * 開発分は計測しない（利用者の判断 2026-10-24。アプリの `AnalyticsPolicy` と同じ考え）。
   *   ・手元のサーバ（localhost・127.0.0.1・*.localhost）
   *   ・開発者のブラウザ: 一度 `?noanalytics=1` を付けて開くと、そのブラウザでは以後計測しない（`?noanalytics=0` で戻す）
   * ⚠️ `firebase.analytics()` を呼ばなければ自動の計測（page_view・first_visit など）も出ない。止めるのはここ1か所
   */
  function excluded() {
    const host = location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")) return true;
    try {
      const flag = new URLSearchParams(location.search).get("noanalytics");
      if (flag === "1") localStorage.setItem("tss.noAnalytics", "1");
      if (flag === "0") localStorage.removeItem("tss.noAnalytics");
      return localStorage.getItem("tss.noAnalytics") === "1";
    } catch (e) {
      return false;
    }
  }

  function boot() {
    if (bootAttempted) return;
    bootAttempted = true;
    if (excluded()) return;
    (function check() {
      if (typeof firebase !== "undefined" && firebase.apps && firebase.apps.length &&
          typeof firebase.analytics === "function") {
        try {
          instance = firebase.analytics();  // この呼び出しが自動計測のトリガー
          ready = true;
        } catch (e) {
          console.error("[TSSAnalytics] init failed", e);
        }
      } else {
        setTimeout(check, 100);
      }
    })();
  }
  boot();

  function logEvent(name, params) {
    if (!ready || !instance) return;
    try {
      instance.logEvent(name, params || {});
    } catch (e) {
      console.error("[TSSAnalytics]", e);
    }
  }

  function setUserId(uid) {
    if (!ready || !instance) return;
    try {
      instance.setUserId(uid || null);
    } catch (e) {
      console.error("[TSSAnalytics]", e);
    }
  }

  return { logEvent: logEvent, setUserId: setUserId, isReady: function () { return ready; } };
})();
