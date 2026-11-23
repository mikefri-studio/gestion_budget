/* Service worker — cache de l’application (fonctionnement hors-ligne) */
const CACHE = 'budget-v2'; // incrémente (budget-v3…) à chaque mise à jour des fichiers
const SHELL = ['./', './index.html', './styles.css', './app.js', './firebase-config.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.origin === location.origin) {
    // fichiers de l’app : cache d’abord, réseau en secours
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('./index.html'))));
  } else if (/gstatic\.com|googleapis\.com|fonts\.gstatic/.test(url.hostname)) {
    // polices + SDK Firebase : mis en cache pour le hors-ligne
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      c.put(e.request, copy);
      return res;
    }))));
  }
  // les appels Firestore/Auth passent toujours par le réseau (données fraîches)
});
