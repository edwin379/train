/* ============================================================
   TOEI LIVE — Service Worker
   Makes the app installable (PWA) and loads the shell instantly.
   IMPORTANT: live train data (/api/*) is NEVER cached — it must
   always be fetched fresh. Only the static "app shell" is cached.
   ============================================================ */

const CACHE = "toei-live-v1";

// The static files that make up the app shell.
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Install: pre-cache the shell.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// Activate: clean up old caches.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//  - API calls (/api/...) and map tiles → always go to the network (live data)
//  - everything else (the shell) → cache first, fall back to network
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache live data or third-party tiles/fonts — always network.
  const isApi   = url.pathname.startsWith("/api/");
  const isTile  = url.hostname.includes("basemaps.cartocdn.com") ||
                  url.hostname.includes("cartocdn") ||
                  url.hostname.includes("demotiles.maplibre.org");
  const isOther = url.origin !== self.location.origin;

  if (isApi || isTile || isOther) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // App shell: cache-first for speed, update cache in the background.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((resp) => {
        // Update the cache with the fresh copy.
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
