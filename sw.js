const CACHE = "ryadom-3c1c0732fcde63c173a6";
const BASE = "/ryadom/";
const FILES = ["/ryadom/index.html","/ryadom/manifest.webmanifest","/ryadom/icon-192.png","/ryadom/icon-512.png","/ryadom/icon-maskable.png","/ryadom/assets/index-BYvE6FF6.css","/ryadom/assets/index-DPuW2mP_.js"];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ryadom-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const page = `${BASE}index.html`;
  if (request.mode === 'navigate' && (url.pathname === BASE || url.pathname === page)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(page)).then(hit => hit || fetch(request)));
  } else if (FILES.includes(url.pathname) && url.pathname !== page && !url.search) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(request)).then(hit => hit || fetch(request)));
  }
});
