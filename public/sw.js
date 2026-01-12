const CACHE_NAME = 'touring-spot-share-v2';
const RUNTIME_CACHE = 'touring-runtime-v2';
const EXTERNAL_CACHE = 'touring-external-v2';
const IMAGE_CACHE = 'touring-images-v2';

// 静的アセットのキャッシュ
const urlsToCache = [
  '/',
  '/index.html',
  '/detail.html',
  '/user.html',
  '/404.html'
];

// 外部リソースのキャッシュ設定
const EXTERNAL_RESOURCES = [
  'https://maps.googleapis.com',
  'https://unpkg.com'
];

// Firebase Storage のドメイン
const FIREBASE_STORAGE_DOMAINS = [
  'firebasestorage.googleapis.com'
];

// インストール
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// フェッチ（キャッシュ戦略）
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Google Ads系は通常通り（キャッシュなし）
  if (url.hostname.includes('googlesyndication.com') || 
      url.hostname.includes('googletagmanager.com')) {
    event.respondWith(fetch(request));
    return;
  }

  // Firebase Storage画像の特別処理（CORB対策）
  if (FIREBASE_STORAGE_DOMAINS.some(domain => url.hostname.includes(domain))) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(cache => {
        return cache.match(request).then(cachedResponse => {
          // キャッシュがあり、7日以内なら使用
          if (cachedResponse) {
            const cachedDate = new Date(cachedResponse.headers.get('date') || 0);
            const now = new Date();
            const ageInDays = (now - cachedDate) / (1000 * 60 * 60 * 24);
            
            if (ageInDays < 7) {
              return cachedResponse;
            }
          }

          // キャッシュがないか古い場合はネットワークから取得
          // CORB対策: mode と credentials を明示的に設定
          return fetch(request, {
            mode: 'cors',
            credentials: 'omit',
            cache: 'force-cache'
          }).then(response => {
            // レスポンスが正常な場合のみキャッシュ
            if (response && response.status === 200 && response.type !== 'error') {
              // opaque responseの場合はキャッシュしない
              if (response.type === 'opaque') {
                console.warn('Opaque response, not caching:', request.url);
                return response;
              }
              cache.put(request, response.clone());
            }
            return response;
          }).catch(error => {
            console.error('Firebase Storage fetch error:', error);
            // エラー時はキャッシュから返す
            return cachedResponse || new Response('画像の読み込みに失敗しました', { 
              status: 503,
              statusText: 'Service Unavailable'
            });
          });
        });
      })
    );
    return;
  }

  // 外部リソース（Google Maps API, unpkg）
  if (EXTERNAL_RESOURCES.some(domain => url.href.startsWith(domain))) {
    event.respondWith(
      caches.open(EXTERNAL_CACHE).then(cache => {
        return cache.match(request).then(cachedResponse => {
          if (cachedResponse) {
            const cachedDate = new Date(cachedResponse.headers.get('date'));
            const now = new Date();
            const ageInDays = (now - cachedDate) / (1000 * 60 * 60 * 24);
            
            if (ageInDays < 7) {
              // バックグラウンドで更新
              fetch(request).then(response => {
                if (response && response.status === 200) {
                  cache.put(request, response.clone());
                }
              }).catch(() => {});
              
              return cachedResponse;
            }
          }

          return fetch(request).then(response => {
            if (response && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          }).catch(() => {
            return cachedResponse || new Response('オフライン', { status: 503 });
          });
        });
      })
    );
    return;
  }

  // 静的アセット（ネットワーク優先、キャッシュフォールバック）
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && request.method === 'GET') {
          const responseToCache = response.clone();
          caches.open(RUNTIME_CACHE)
            .then((cache) => cache.put(request, responseToCache));
        }
        return response;
      })
      .catch(() => {
        return caches.match(request).then(cachedResponse => {
          if (cachedResponse) {
            return cachedResponse;
          }
          
          if (request.destination === 'document') {
            return caches.match('/404.html');
          }
          
          return new Response('オフライン', { status: 503 });
        });
      })
  );
});

// アクティベート（古いキャッシュの削除）
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME, RUNTIME_CACHE, EXTERNAL_CACHE, IMAGE_CACHE];
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheWhitelist.includes(cacheName)) {
            console.log('古いキャッシュを削除:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// メッセージハンドラー
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => caches.delete(cacheName))
        );
      }).then(() => {
        event.ports[0].postMessage({ success: true });
      })
    );
  }
});