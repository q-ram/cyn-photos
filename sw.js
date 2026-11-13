// 앱 파일만 저장해 둔다 (사진은 저장하지 않음). 고친 뒤에는 VERSION 과 index.html 의 ?v= 를 올린다.
const VERSION = 'cyn-v6';
const SHELL = [
  './', 'index.html', 'css/style.css?v=6', 'js/app.js?v=6', 'js/core.js?v=6', 'js/pungnap.js?v=6',
  'js/collection.js?v=6', 'js/vendor/exifr.full.umd.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 인터넷이 되면 항상 서버에 새 파일이 있는지 확인하고(브라우저 임시 저장 무시), 안 되면 저장해 둔 파일
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match(req, { ignoreSearch: true })).then(r => r || caches.match('index.html'))),
  );
});
