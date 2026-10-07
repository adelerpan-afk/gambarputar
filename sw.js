const CACHE_NAME = 'shape-rotator-v2';
const ASSETS_TO_CACHE = [
  './index.html',
  './manifest.json'
];

// Pasang & simpan file inti
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Menyimpan file inti ke cache');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Hapus cache lama saat ada versi baru
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Ambil dari cache dulu, jika tidak ada ambil dari jaringan
self.addEventListener('fetch', event => {
  // Lewati permintaan yang butuh data dinamis / pustaka eksternal
  const url = event.request.url;
  if (url.includes('cdn.jsdelivr.net') || url.includes('blob:') || url.includes('data:')) {
    return; // lewati, ambil langsung dari jaringan
  }

  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request)
          .then(networkResponse => {
            // Simpan salinan ke cache untuk kunjungan berikutnya
            return caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, networkResponse.clone());
              return networkResponse;
            });
          });
      })
  );
});
