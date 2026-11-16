/* ProxiTalk application-shell cache only. Auth, API, and message requests are never cached. */
const CACHE = 'proxitalk-shell-v6';
const ASSETS = [
  './', './index.html', './manifest.json', './assets/icon.svg',
  './css/style.css', './js/config.js', './js/storage.js', './js/crypto.js',
  './js/auth.js', './js/cloud.js', './js/mesh.js', './js/app.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try { return await fetch(request); }
    catch (error) {
      if (request.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
