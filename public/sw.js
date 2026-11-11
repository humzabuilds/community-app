// Minimal service worker: makes the app installable and shows an offline page.
const CACHE = 'community-v1';
const SHELL = ['/styles.css', '/app.js', '/offline.html', '/icons/icon-192.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  const url = new URL(req.url);
  if (url.origin === location.origin && SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
});
