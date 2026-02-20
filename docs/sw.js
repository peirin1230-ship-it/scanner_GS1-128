/* Service Worker for LinQ VAL PWA */
const CACHE_NAME = "linqval-v5";

/* Core files to cache for offline use */
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./scan.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./data/operators.json",
  "./data/patients.json",
  "./data/procedures.json",
  "./data/doctors.json",
  "./data/billing_map.json",
  "./data/standard_builder.json",
  "./data/billing_requirements.json"
];

/* Install: cache core assets */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

/* Activate: clean old caches */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* Fetch: network-first for JSON/CSV, cache-first for static assets */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  /* Skip non-GET and cross-origin requests */
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  /* dict_jan and gtin_index CSVs: cache-first (large, rarely change) */
  if (url.pathname.includes("/dict_jan/") || url.pathname.includes("/gtin_index/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  /* Core assets: stale-while-revalidate */
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
