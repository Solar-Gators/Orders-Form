/* Orders moved to /one.solar/orders/: remove the old app's offline copy and reload into the redirect. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((tabs) => tabs.forEach((t) => t.navigate(t.url)))
  );
});
