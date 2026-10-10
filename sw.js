/**
 * Service Worker — Shape Rotator
 * Strategi:
 *   - Navigasi (mode === 'navigate')   → network-first, fallback ke cache / index.html
 *   - Aset statis (same-origin GET)    → stale-while-revalidate
 *   - CDN pihak ketiga (esm.run dll)   → network-only (tidak di-cache)
 */

const CACHE_VERSION = 'v5'; // [FIX] bump versi
const STATIC_CACHE = `shape-rotator-static-${CACHE_VERSION}`;
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './mp4-muxer.min.js', // [FIX] muxer lokal ikut di-precache
];

// ---------------------------------------------------------------
// Install
// ---------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            cache
              .add(url)
              .catch((err) => console.warn('[SW] Precache gagal:', url, err))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------
// Activate
// ---------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin → langsung jaringan
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

// ---------------------------------------------------------------
// network-first
// ---------------------------------------------------------------
async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch {
    // [FIX] coba request persis dulu, lalu fallbackUrl, lalu index.html
    const cached =
      (await caches.match(request)) ||
      (await caches.match(fallbackUrl)) ||
      (await caches.match('./index.html'));

    if (cached) return cached;

    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// ---------------------------------------------------------------
// stale-while-revalidate
// ---------------------------------------------------------------
async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null); // [FIX] null, bukan cached (yang mungkin undefined)

  // [FIX] jamin selalu ada Response valid
  const result = cached || (await networkPromise);
  return (
    result ||
    new Response('Offline', { status: 503, statusText: 'Offline' })
  );
}

// ---------------------------------------------------------------
// Message
// ---------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
