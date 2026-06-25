/*
 * share.js — 共有ボタン（X/LINE/ネイティブ/コピー）＋ アプリDL CTA バナー。
 * 各ページで <script src="/share.js" defer></script> を読み込むだけで有効化。
 * Vue とは独立に body へ要素を注入する。
 */
(function () {
  if (window.__tssShareInjected) return;
  window.__tssShareInjected = true;

  var APP_URL = "https://apps.apple.com/jp/app/id1466607921";
  var TEAL = "#00A8C6";
  var TAGS = "#ツーリング #バイク好きと繋がりたい";

  function title() {
    return (document.title || "ツーリングスポットシェア").replace(/\s*\|.*$/, "").trim();
  }
  function shareText() { return title() + " ｜ ツーリングスポットシェア"; }
  // 動的OGP用の共有URL（detail/user は /s/:id・/u/:id に変換してリッチプレビュー化）
  function shareUrl() {
    try {
      var id = new URLSearchParams(location.search).get("id");
      if (id) {
        if (/\/detail\.html$/.test(location.pathname)) return location.origin + "/s/" + encodeURIComponent(id);
        if (/\/user\.html$/.test(location.pathname)) return location.origin + "/u/" + encodeURIComponent(id);
      }
    } catch (_) {}
    return location.href;
  }

  // ---- 共有 ----
  function nativeOrMenu() {
    var url = shareUrl();
    if (navigator.share) {
      navigator.share({ title: title(), text: shareText() + " " + TAGS, url: url }).catch(function () {});
    } else {
      toggleMenu(true);
    }
  }
  function openX() {
    var u = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(shareText() + " " + TAGS) + "&url=" + encodeURIComponent(shareUrl());
    window.open(u, "_blank", "noopener");
  }
  function openLine() {
    var u = "https://line.me/R/msg/text/?" + encodeURIComponent(shareText() + " " + shareUrl());
    window.open(u, "_blank", "noopener");
  }
  function copyLink() {
    (navigator.clipboard ? navigator.clipboard.writeText(shareUrl()) : Promise.reject()).then(
      function () { flash("リンクをコピーしました"); },
      function () { window.prompt("リンクをコピー", shareUrl()); }
    );
    toggleMenu(false);
  }
  function flash(msg) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;bottom:88px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:100000;opacity:0;transition:opacity .2s";
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = "1"; });
    setTimeout(function () { t.style.opacity = "0"; setTimeout(function () { t.remove(); }, 250); }, 1600);
  }

  // ---- 共有メニュー（デスクトップ等 navigator.share 非対応時） ----
  var menu;
  function toggleMenu(show) {
    if (!menu) {
      menu = document.createElement("div");
      menu.style.cssText = "position:fixed;right:18px;bottom:84px;background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:6px;z-index:99999;display:none;min-width:160px";
      [["𝕏 でポスト", openX], ["LINE で送る", openLine], ["リンクをコピー", copyLink]].forEach(function (it) {
        var b = document.createElement("button");
        b.textContent = it[0];
        b.style.cssText = "display:block;width:100%;text-align:left;border:none;background:none;padding:10px 12px;font-size:14px;cursor:pointer;border-radius:8px";
        b.onmouseenter = function () { b.style.background = "#f2f6f8"; };
        b.onmouseleave = function () { b.style.background = "none"; };
        b.onclick = it[1];
        menu.appendChild(b);
      });
      document.body.appendChild(menu);
      document.addEventListener("click", function (e) {
        if (menu && !menu.contains(e.target) && e.target.id !== "tss-share-fab") toggleMenu(false);
      });
    }
    menu.style.display = show ? "block" : "none";
  }

  // ---- 共有FAB ----
  function buildFab() {
    var fab = document.createElement("button");
    fab.id = "tss-share-fab";
    fab.title = "このページを共有";
    fab.innerHTML = "🔗";
    fab.style.cssText = "position:fixed;right:18px;bottom:18px;width:52px;height:52px;border-radius:50%;border:none;background:" + TEAL + ";color:#fff;font-size:20px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;z-index:99999";
    fab.onclick = function (e) { e.stopPropagation(); nativeOrMenu(); };
    document.body.appendChild(fab);
  }

  // ---- アプリDL CTA バナー（下部・1回×24hで自動再表示） ----
  function buildBanner() {
    try {
      var until = Number(localStorage.getItem("tssAppCtaHide") || 0);
      if (until && Date.now() < until) return;
    } catch (_) {}
    var bar = document.createElement("div");
    bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;background:linear-gradient(90deg," + TEAL + ",#0bbed6);color:#fff;display:flex;align-items:center;gap:10px;padding:10px 14px;z-index:99998;font-size:14px;box-shadow:0 -2px 10px rgba(0,0,0,.15)";
    bar.innerHTML =
      '<span style="font-size:20px">🏍️</span>' +
      '<span style="flex:1;line-height:1.3">アプリで記録・投稿・スタンプラリー。<b>無料で始める</b></span>';
    var dl = document.createElement("a");
    dl.href = APP_URL; dl.target = "_blank"; dl.rel = "noopener";
    dl.textContent = "App Storeで開く";
    dl.style.cssText = "background:#fff;color:" + TEAL + ";font-weight:700;padding:8px 12px;border-radius:8px;text-decoration:none;white-space:nowrap";
    var close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText = "background:none;border:none;color:#fff;font-size:16px;cursor:pointer;padding:4px 6px";
    close.onclick = function () {
      bar.remove();
      try { localStorage.setItem("tssAppCtaHide", String(Date.now() + 24 * 3600 * 1000)); } catch (_) {}
    };
    bar.appendChild(dl);
    bar.appendChild(close);
    document.body.appendChild(bar);
    // FAB をバナー分持ち上げる
    var fab = document.getElementById("tss-share-fab");
    if (fab) fab.style.bottom = "70px";
  }

  function init() { buildFab(); buildBanner(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
