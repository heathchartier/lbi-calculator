const CACHE = 'lbiiq-v34';
const STATIC = [
  '/lbi-calculator/icon-192.png',
  '/lbi-calculator/icon-512.png',
  '/lbi-calculator/apple-touch-icon.png',
  '/lbi-calculator/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for HTML and JS so every deploy reaches all devices immediately.
// Cache-first only for static assets (icons, manifest) that never change.
self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Don't intercept cross-origin requests (e.g. Cloudflare Worker calls)
  if (!url.startsWith(self.location.origin)) return;
  const isStatic = STATIC.some(a => url.includes(a.replace('/lbi-calculator','')));

  if(isStatic){
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
  } else {
    // Network-first: HTML, app.js, pricing.json, everything else
    e.respondWith(
      fetch(e.request).then(res => {
        if(res.ok){
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
  }
});
