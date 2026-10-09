'use strict';

// Offline shell. The app's own files (fonts included) are served stale-while-revalidate so it opens
// instantly and offline. API calls (/api/) and other sites are never touched here, and saved MP3s
// live in IndexedDB, not in this cache.

const CACHE = 'audioshop-shell-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
    'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
    'fonts/manrope-latin.woff2', 'fonts/dm-mono-400.woff2', 'fonts/dm-mono-500.woff2'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    const sameOrigin = url.origin === self.location.origin;
    if (!sameOrigin || url.pathname.includes('/api/')) return;

    if (request.mode === 'navigate') {
        if (url.search) {
            // A shared link (?url=... or ?text=...): answer from the cache, or fetch the bare page, so
            // what you shared never reaches the web host's logs. The page reads it from the address bar.
            event.respondWith(caches.match('index.html')
                .then(cached => cached || fetch(new URL(url.pathname, url.origin))));
            return;
        }
        // Network first for the page itself, cached shell when offline.
        event.respondWith(fetch(request).catch(() => caches.match('index.html')));
        return;
    }
    event.respondWith(caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request, { ignoreSearch: true });
        const network = fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
        }).catch(() => cached);
        return cached || network;
    }));
});
