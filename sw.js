/**
 * Service Worker — Shape Image Rotator
 * Strategi:
 *   - Navigasi (mode === 'navigate') → network-first, fallback ke cache / index.html
 *   - Aset statis lain (same-origin GET) → stale-while-revalidate
 */

const CACHE_VERSION = 'v3';
const STATIC_CACHE = `shape-rotator-static-${CACHE_VERSION}`;
const PRECACHE_URLS = ['./', './index.html', './manifest.json'];

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

  // Hanya tangani GET (cache.put() akan error untuk POST/PUT, dsb.)
  if (request.method !== 'GET') return;

  // Hanya same-origin; library CDN (esm.run) langsung ke jaringan
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

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
