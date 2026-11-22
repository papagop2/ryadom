const CACHE = "ryadom-61694d412beeaffd9ef3";
const BASE = "/ryadom/";
const FILES = ["/ryadom/index.html","/ryadom/manifest.webmanifest","/ryadom/icon-192.png","/ryadom/icon-512.png","/ryadom/icon-maskable.png","/ryadom/assets/index-BU1j1haK.css","/ryadom/assets/index-Z1u3czbj.js"];
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

// Web Push: показываем системное уведомление и открываем нужный раздел.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || '' }; }
  const title = data.title || 'Рядом';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: `${BASE}icon-192.png`,
    badge: `${BASE}icon-192.png`,
    tag: data.kind || 'ryadom',
    data: { url: data.url || './', kind: data.kind || 'ryadom', notificationId: data.notificationId || null },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      if ('navigate' in existing) void existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});
