/**
 * Service Worker — Shape Rotator
 * Strategi:
 *   - Navigasi (mode === 'navigate')   → network-first, fallback ke cache / index.html
 *   - Aset statis (same-origin GET)    → stale-while-revalidate
 *   - CDN pihak ketiga (esm.run dll)   → network-only (tidak di-cache)
 */

const CACHE_VERSION = 'v4';
const STATIC_CACHE = `shape-rotator-static-${CACHE_VERSION}`;
const PRECACHE_URLS = ['./', './index.html', './app.js', './style.css', './manifest.json'];

// ---------------------------------------------------------------
// Install: precache aset inti (toleran jika satu URL gagal)
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
// Activate: hapus cache versi lama
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
// Fetch: routing strategi
// ---------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Hanya tangani GET
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (CDN library esm.run, dsb.) → langsung jaringan, jangan di-cache
  if (url.origin !== self.location.origin) return;

  // Navigasi → network-first
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  // Aset statis same-origin → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request));
});

// ---------------------------------------------------------------
// Strategi: network-first (untuk navigasi / HTML)
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
    const cached = await caches.match(request);
    if (cached) return cached;

    const fallback = await caches.match(fallbackUrl);
    if (fallback) return fallback;

    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// ---------------------------------------------------------------
// Strategi: stale-while-revalidate (untuk aset statis)
// ---------------------------------------------------------------
async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);

  return cached || networkPromise;
}

// ---------------------------------------------------------------
// Message: izinkan UI memicu skipWaiting (untuk auto-update)
// ---------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});