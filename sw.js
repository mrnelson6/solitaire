// Files are fetched fresh on every launch, so deploys don't need a version
// bump. Change VERSION only to clear out old cached files.
const VERSION = 'v1';
const CACHE = `solitaire-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/games.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first so deploys show up on the next launch; the cache is only used
// when offline or when the network is too slow to answer.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(request, { cache: 'no-cache' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      if (res.ok) cache.put(request, res.clone());
      return res;
    } catch {
      return (await cache.match(request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
