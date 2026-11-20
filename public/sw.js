// Service worker: keeps the display pages and their scripts/styles available when the network drops.
// API calls are NOT cached here; the display keeps its own copy of the schedule in localStorage.
const CACHE = 'roomflow-shell-v2';
const SHELL = ['display.html', 'css/style.css', 'css/components.css', 'js/api-client.js', 'js/display.js', '/socket.io/socket.io.js'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // API and uploaded media are never cached here (videos are large; the display keeps its own schedule)
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  // network first (always fresh when online), cached copy when offline
  event.respondWith(
    fetch(event.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); }
      return res;
    }).catch(() => caches.match(event.request, { ignoreSearch: true }).then(r => r || caches.match('display.html')))
  );
});
