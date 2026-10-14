/**
 * Service worker: makes the site installable as an app (PWA) and lets it open
 * without a connection. Always tries the network first, so a push to GitHub
 * shows up right away; the saved copy is only used when offline. The database
 * (Supabase) is never cached: requests to other sites pass straight through.
 */
const CACHE = 'sg-orders-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' && (await caches.match('./'))) || Response.error())
  );
});
