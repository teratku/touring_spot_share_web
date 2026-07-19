/*
 * analytics.js — 公開Web用：GA4(Firebase Analytics)計測の共通ユーティリティ。
 *
 * 前提: ページで Firebase（compat, firebase-analytics-compat.js 込み）を初期化済みであること。
 *
 * 使い方:
 *   <script src="/analytics.js" defer></script>   ← Firebase各scriptの後、末尾に配置
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

  function boot() {
    if (bootAttempted) return;
    bootAttempted = true;
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
