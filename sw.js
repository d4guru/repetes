// Service worker de l'app Répètes
// - Permet l'installation sur les anciennes versions de Chrome Android
// - Garde une copie de l'app pour l'ouvrir même avec un réseau faible
// - Les données (Supabase) ne sont jamais mises en cache : toujours en direct

const CACHE = 'repetes-v26';
const FILES = ['./', './index.html', './installer.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './badge-96.png'];

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

// Notification reçue (même app fermée)
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Répètes', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { link: d.link || '', nid: d.nid || '' },
  }));
});

// Appui sur une notification : ouvre l'app sur la bonne page
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { link, nid } = event.notification.data || {};
  const url = new URL('./' + (nid ? '?nid=' + encodeURIComponent(nid) : '') + (link || '#/notifications'), self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        w.postMessage({ type: 'open', link, nid });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
