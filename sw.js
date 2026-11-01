'use strict';
// 離線時也能打開 App。只處理這個網站自己的檔案，Google 的回應和權杖一律不經過快取。
const CACHE = 'wiznote-my-shell';
const SHELL = [
  './', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  'vendor/marked.umd.js', 'vendor/purify.min.js', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// 有網路就拿最新版並更新快取，沒網路才用快取，所以改版不必換快取名稱
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    } catch (err) {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      if (e.request.mode === 'navigate') return caches.match('./');
      throw err;
    }
  })());
});
