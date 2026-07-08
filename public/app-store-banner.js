/*
 * app-store-banner.js — 全ページ共通 App Store 誘導バナー（単一ソース / フレームワーク非依存）
 * 各ページに <script src="/app-store-banner.js?v=1" defer></script> を1行入れるだけで
 * 画面下部にApp Storeへの誘導バナーが表示される。
 * index.html の Vue 製バナーと同じ localStorage キー(appBannerDismissed)で閉じた状態を共有する。
 */
(function () {
  if (window.__sharedAppStoreBanner) return;
  window.__sharedAppStoreBanner = true;

  var DISMISS_KEY = 'appBannerDismissed';
  var APP_STORE_URL = 'https://apps.apple.com/jp/app/id1466607921';

  function track(name, params) {
    if (typeof window.smTrack === 'function') window.smTrack(name, params || {});
  }

  function mount() {
    if (localStorage.getItem(DISMISS_KEY) === 'true') return;
    // index.html は自前の Vue 製バナーを持つため二重表示しない
    if (document.querySelector('.app-store-banner')) return;

    var style = document.createElement('style');
    style.textContent = [
      '#sab-banner{position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#fff;',
      'border-top:1px solid rgba(0,168,198,0.2);box-shadow:0 -4px 20px rgba(0,0,0,0.12);',
      'padding:12px 16px;animation:sabSlideUp .3s ease-out;}',
      '@keyframes sabSlideUp{from{transform:translateY(100%);opacity:0;}to{transform:translateY(0);opacity:1;}}',
      '#sab-banner .sab-inner{max-width:480px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;}',
      '#sab-banner .sab-text{display:flex;align-items:center;gap:10px;flex:1;min-width:0;}',
      '#sab-banner .sab-icon{font-size:28px;flex-shrink:0;}',
      '#sab-banner .sab-title{font-size:13px;font-weight:600;color:#1a1a1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '#sab-banner .sab-sub{font-size:11px;color:#666;}',
      '#sab-banner .sab-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}',
      '#sab-banner .sab-badge-link{display:block;line-height:0;}',
      '#sab-banner .sab-badge{height:36px;width:auto;}',
      '#sab-banner .sab-close{background:none;border:none;color:#999;font-size:16px;cursor:pointer;padding:4px 8px;border-radius:50%;line-height:1;}',
      '#sab-banner .sab-close:hover{background:rgba(0,0,0,.08);}',
      '@media (prefers-color-scheme: dark){#sab-banner{background:#1e1e1e;border-top-color:rgba(0,168,198,.3);}#sab-banner .sab-title{color:#f0f0f0;}}'
    ].join('');
    document.head.appendChild(style);

    var banner = document.createElement('div');
    banner.id = 'sab-banner';
    banner.innerHTML =
      '<div class="sab-inner">' +
        '<div class="sab-text">' +
          '<span class="sab-icon">🏍️</span>' +
          '<div>' +
            '<div class="sab-title">ツーリングスポットシェア</div>' +
            '<div class="sab-sub">アプリでもっと便利に</div>' +
          '</div>' +
        '</div>' +
        '<div class="sab-actions">' +
          '<a href="' + APP_STORE_URL + '" target="_blank" rel="noopener noreferrer" class="sab-badge-link" id="sab-cta">' +
            '<img src="https://developer.apple.com/app-store/marketing/guidelines/images/badge-download-on-the-app-store.svg" alt="App Store からダウンロード" class="sab-badge">' +
          '</a>' +
          '<button class="sab-close" id="sab-close" aria-label="閉じる">✕</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);

    document.getElementById('sab-cta').addEventListener('click', function () {
      track('app_store_cta_click', { placement: location.pathname });
      localStorage.setItem(DISMISS_KEY, 'true');
    });
    document.getElementById('sab-close').addEventListener('click', function () {
      localStorage.setItem(DISMISS_KEY, 'true');
      banner.remove();
    });
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
