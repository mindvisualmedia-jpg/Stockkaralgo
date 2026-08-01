/* Stockkar service worker — DELIBERATELY CACHES NOTHING.
 *
 * A service worker is required for the browser to offer "Install app". The
 * usual next step is to cache the app shell, and that is exactly what this file
 * must not do: index.html carries the entire UI, and Updates > Update Stockkar
 * replaces it in place. A cached shell would keep serving yesterday's code
 * after an update — including stale trading logic — with no obvious way for the
 * trader to tell. Offline support is worthless here anyway, since every screen
 * needs the broker and the backend live.
 *
 * So: pass every request straight to the network. Installability, zero
 * staleness risk.
 */
self.addEventListener('install', (e) => {
  self.skipWaiting();                    // never leave an old worker in charge
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Drop anything a previous version of this file may have cached.
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  // Straight passthrough. Present only because installability requires a
  // fetch handler; it must never answer from a cache.
  e.respondWith(fetch(e.request));
});
