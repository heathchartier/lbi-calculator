const CACHE = 'lbiiq-v7';
const ASSETS = [
  '/lbi-calculator/',
  '/lbi-calculator/index.html',
  '/lbi-calculator/app.js',
  '/lbi-calculator/manifest.json',
  '/lbi-calculator/icon-192.png',
  '/lbi-calculator/icon-512.png',
  '/lbi-calculator/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Cache-first for app assets, network-first for everything else
  if(ASSETS.some(a => e.request.url.includes(a.replace('/lbi-calculator','')))){
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
  } else {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  }
});
