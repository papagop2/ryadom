self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ryadom-') && key !== CACHE)
    .map(key => caches.delete(key)))));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(caches.open(CACHE).then(cache => cache.match('/index.html')).then(hit => hit || fetch(request)));
  } else if (FILES.includes(url.pathname) && url.pathname !== '/index.html' && !url.search) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(request)).then(hit => hit || fetch(request)));
  }
});
