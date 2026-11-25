const CACHE_NAME = 'tamilflix-shell-v4';
const APP_SHELL = [
  './',
  './index.html',
  './stile.css',
  './app.js',
  './tamilflix.webmanifest',
  './tamilflix-icon.svg',
  './tamilflix-icon-192.png',
  './tamilflix-icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith('tamilflix-') && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (
    event.request.method !== 'GET'
    || requestUrl.origin !== self.location.origin
    || requestUrl.pathname.startsWith('/api/')
  ) {
    return;
  }

  event.respondWith((async () => {
    const cachedResponse = await caches.match(event.request);
    let networkResponse;

    try {
      networkResponse = await fetch(event.request, { cache: 'no-cache' });
    } catch (error) {
      if (cachedResponse) {
        return cachedResponse;
      }
      throw error;
    }

    if (networkResponse.ok) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, networkResponse.clone());
      } catch (error) {
        console.error('Could not refresh the offline app cache.', error);
      }
    }

    return networkResponse;
  })());
});
