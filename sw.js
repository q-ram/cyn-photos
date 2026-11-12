// 앱 파일만 저장해 둔다 (사진은 저장하지 않음). 고친 뒤에는 VERSION 을 올린다.
const VERSION = 'cyn-v3';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/core.js', 'js/pungnap.js',
  'js/collection.js', 'js/vendor/exifr.full.umd.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 인터넷이 되면 새 파일, 안 되면 저장해 둔 파일
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
  );
});
