/*
 * analytics.js — 全ページ共通 Firebase Analytics 初期化 + カスタムイベント計測ヘルパー
 * 各ページに <script src="/analytics.js?v=1" defer></script> を1行入れるだけで
 * page_view が自動計測され、window.smTrack(name, params) でカスタムイベントを送れる。
 * firebase-analytics-compat.js / init.js は各ページ側で読み込まれている前提（未読み込みなら何もしない）。
 */
(function () {
  if (window.__sharedAnalytics) return;
  window.__sharedAnalytics = true;

  var ready = false;
  var queue = [];

  function flush() {
    if (!ready) return;
    while (queue.length) {
      var item = queue.shift();
      try { firebase.analytics().logEvent(item.name, item.params); } catch (e) {}
    }
  }

  window.smTrack = function (name, params) {
    queue.push({ name: name, params: params || {} });
    flush();
  };

  function tryInit() {
    if (ready) return true;
    if (window.firebase && firebase.apps && firebase.apps.length && firebase.analytics) {
      ready = true;
      try {
        firebase.analytics().logEvent('page_view', {
          page_title: document.title,
          page_path: location.pathname,
          page_location: location.href
        });
      } catch (e) {}
      flush();
      return true;
    }
    return false;
  }

  if (!tryInit()) {
    var tries = 0;
    var t = setInterval(function () { if (tryInit() || ++tries > 60) clearInterval(t); }, 100);
  }
})();
