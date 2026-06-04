/*
 * menu.js — 全ページ共通ハンバーガーメニュー（単一ソース / フレームワーク非依存）
 * 各ページに <script src="/menu.js" defer></script> を1行入れるだけで、
 * どのページでも同じメニューが表示される。項目を変えたいときはこのファイルだけ編集する。
 */
(function () {
  if (window.__sharedMenu) return;
  window.__sharedMenu = true;

  var FB_VERSION = '12.4.0';

  // auth: 'in' = ログイン時のみ表示 / 'out' = 未ログイン時のみ / 省略 = 常時表示
  var ITEMS = [
    { icon: '🏠', label: 'ホーム', href: '/' },
    { icon: '🛣️', label: 'ルートを探す', href: '/routes.html' },
    { icon: '🏍️', label: 'ツーリングプラン', href: '/touring-plan.html' },
    { icon: '📝', label: 'ブログ', href: '/blog/blog.html' },
    { sep: true },
    { icon: '📊', label: 'マイダッシュボード', href: '/dashboard/dashboard.html' },
    { icon: '🗾', label: '都道府県制覇マップ', href: '/conquest/conquest.html' },
    { icon: '🏅', label: 'バッジ', href: '/badges/badges.html' },
    { icon: '🛤️', label: '道路コンプリート率', href: '/completion/completion.html' },
    { icon: '👤', label: 'マイページ', href: '#mypage', auth: 'in', mypage: true },
    { sep: true },
    { icon: '🔒', label: 'プライバシーポリシー', href: '/privacypolicy/privacypolicy.html' },
    { icon: '📋', label: '利用規約', href: '/termsofservice/termsofservice.html' },
    { sep: true },
    { icon: '🔑', label: 'ログイン', href: '/login.html', auth: 'out' },
    { icon: '🚪', label: 'ログアウト', href: '#logout', auth: 'in', logout: true }
  ];

  var CSS = [
    '#sm-btn{position:fixed;top:9px;right:12px;z-index:100000;width:46px;height:46px;border:2px solid rgba(255,255,255,.9);border-radius:14px;',
    'background:linear-gradient(135deg,#00A8C6,#228B22);color:#fff;font-size:22px;line-height:1;cursor:pointer;',
    'box-shadow:0 2px 10px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .15s,opacity .15s;}',
    '#sm-btn:hover{opacity:.9;transform:translateY(-1px);}',
    '#sm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100001;opacity:0;pointer-events:none;transition:opacity .25s;}',
    '#sm-overlay.sm-open{opacity:1;pointer-events:auto;}',
    '#sm-panel{position:fixed;top:0;right:0;height:100%;width:288px;max-width:84vw;background:#fff;z-index:100002;',
    'box-shadow:-4px 0 16px rgba(0,0,0,.2);transform:translateX(100%);transition:transform .28s ease;display:flex;flex-direction:column;',
    'font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;}',
    '#sm-panel.sm-open{transform:translateX(0);}',
    '.sm-head{display:flex;align-items:center;justify-content:space-between;padding:18px 18px 14px;',
    'background:linear-gradient(135deg,#00A8C6,#228B22);color:#fff;}',
    '.sm-head h2{margin:0;font-size:17px;font-weight:bold;display:flex;align-items:center;gap:8px;}',
    '.sm-close{background:rgba(255,255,255,.2);border:none;color:#fff;width:34px;height:34px;border-radius:10px;font-size:18px;cursor:pointer;}',
    '.sm-nav{flex:1;overflow-y:auto;padding:8px 0;}',
    '.sm-item{display:flex;align-items:center;gap:12px;padding:14px 20px;color:#333;text-decoration:none;',
    'border-left:4px solid transparent;transition:background .15s,color .15s;font-size:15px;cursor:pointer;}',
    '.sm-item:hover{background:#f2fafc;}',
    '.sm-item.sm-active{background:rgba(0,168,198,.12);color:#00A8C6;border-left-color:#00A8C6;font-weight:bold;}',
    '.sm-ic{font-size:18px;width:22px;text-align:center;flex-shrink:0;}',
    '.sm-sep{height:1px;background:#eee;margin:8px 18px;}',
    '@media (prefers-color-scheme:dark){',
    '#sm-panel{background:#2C2C2E;}',
    '.sm-item{color:#F2F2F7;}',
    '.sm-item:hover{background:#3A3A3C;}',
    '.sm-item.sm-active{background:rgba(0,212,255,.18);color:#00D4FF;border-left-color:#00D4FF;}',
    '.sm-sep{background:#3A3A3C;}}',
    /* 旧・ページ個別メニュー（.menu-btn ハンバーガー / .hamburger-menu パネル）を隠して統一メニューに置換 */
    '.menu-btn,.hamburger-menu{display:none!important;}'
  ].join('');

  function norm(p) {
    p = (p || '/').split('?')[0].split('#')[0];
    p = p.replace(/\/index\.html$/, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p || '/';
  }

  function build() {
    var here = norm(location.pathname);

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.id = 'sm-btn';
    btn.setAttribute('aria-label', 'メニュー');
    btn.innerHTML = '☰';

    var overlay = document.createElement('div');
    overlay.id = 'sm-overlay';

    var panel = document.createElement('nav');
    panel.id = 'sm-panel';

    var head = document.createElement('div');
    head.className = 'sm-head';
    head.innerHTML = '<h2>🏍️ メニュー</h2>';
    var close = document.createElement('button');
    close.className = 'sm-close';
    close.innerHTML = '✕';
    close.setAttribute('aria-label', '閉じる');
    head.appendChild(close);
    panel.appendChild(head);

    var nav = document.createElement('div');
    nav.className = 'sm-nav';
    ITEMS.forEach(function (it) {
      if (it.sep) {
        var s = document.createElement('div');
        s.className = 'sm-sep';
        if (it.auth) s.setAttribute('data-auth', it.auth);
        nav.appendChild(s);
        return;
      }
      var a = document.createElement('a');
      a.className = 'sm-item';
      a.href = it.href;
      a.innerHTML = '<span class="sm-ic">' + it.icon + '</span><span>' + it.label + '</span>';
      if (it.auth) a.setAttribute('data-auth', it.auth);
      if (it.mypage) a.setAttribute('data-mypage', '1');
      if (it.logout) a.setAttribute('data-logout', '1');
      if (!it.auth && it.href.indexOf('#') !== 0 && norm(it.href) === here) a.classList.add('sm-active');
      nav.appendChild(a);
    });
    panel.appendChild(nav);

    document.body.appendChild(btn);
    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    function open() { overlay.classList.add('sm-open'); panel.classList.add('sm-open'); }
    function closeMenu() { overlay.classList.remove('sm-open'); panel.classList.remove('sm-open'); }
    btn.addEventListener('click', open);
    close.addEventListener('click', closeMenu);
    overlay.addEventListener('click', closeMenu);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

    // ログアウト / マイページ未ログイン時の動作
    panel.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a.sm-item') : null;
      if (!a) return;
      if (a.getAttribute('data-logout')) {
        e.preventDefault();
        if (window.firebase && firebase.auth) {
          firebase.auth().signOut().then(function () { location.href = '/'; }).catch(function () { location.href = '/'; });
        } else { location.href = '/'; }
      }
    });

    return { panel: panel };
  }

  function applyAuth(panel, user) {
    panel.querySelectorAll('[data-auth]').forEach(function (node) {
      var mode = node.getAttribute('data-auth');
      var show = mode === 'in' ? !!user : !user;
      node.style.display = show ? '' : 'none';
    });
    var mypage = panel.querySelector('[data-mypage]');
    if (mypage && user) mypage.setAttribute('href', '/user.html?id=' + user.uid);
  }

  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src; s.defer = true;
    s.onload = function () { cb(true); };
    s.onerror = function () { cb(false); };
    document.head.appendChild(s);
  }
  function loadSeq(list, done) {
    var i = 0;
    (function next(ok) {
      if (!ok && i > 0) return done(false);
      if (i >= list.length) return done(true);
      loadScript(list[i++], next);
    })(true);
  }

  function initAuth(panel) {
    applyAuth(panel, null); // 判明するまでは未ログイン表示
    var subscribed = false;
    function trySubscribe() {
      if (subscribed) return true;
      if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth) {
        subscribed = true;
        try { firebase.auth().onAuthStateChanged(function (u) { applyAuth(panel, u); }); } catch (e) {}
        return true;
      }
      return false;
    }
    if (trySubscribe()) return;
    // ページ側の Firebase 初期化（defer init.js）を最大6秒ポーリング
    var tries = 0;
    var t = setInterval(function () { if (trySubscribe() || ++tries > 60) clearInterval(t); }, 100);
    // Firebase が無いページ（規約等）でも認証状態を合わせるため遅延ロード（上のポーリングが拾う）
    if (!window.firebase) {
      loadSeq([
        '/__/firebase/' + FB_VERSION + '/firebase-app-compat.js',
        '/__/firebase/' + FB_VERSION + '/firebase-auth-compat.js',
        '/__/firebase/init.js'
      ], function () {});
    }
  }

  function mount() {
    var ui = build();
    initAuth(ui.panel);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
