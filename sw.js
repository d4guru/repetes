// Service worker de l'app Répètes
// - Permet l'installation sur les anciennes versions de Chrome Android
// - Garde une copie de l'app pour l'ouvrir même avec un réseau faible
// - Les données (Supabase) ne sont jamais mises en cache : toujours en direct

const CACHE = 'repetes-v10';
const FILES = ['./', './index.html', './installer.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Uniquement les fichiers de l'app elle-même (pas Supabase, pas le CDN)
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Réseau d'abord (pour toujours avoir la dernière version), copie locale si hors ligne
  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
