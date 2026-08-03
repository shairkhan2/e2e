// App-shell service worker.
//
// It caches the shell so the app opens instantly and survives a flaky
// connection. It deliberately never touches /api or the WebSocket: room state
// is live, and nothing that passes through them should linger on disk.

const VERSION = 'v3';
const SHELL = `shell-${VERSION}`;

const ASSETS = [
  '/',
  '/index.html',
  '/room.html',
  '/app.css',
  '/js/home.js',
  '/js/room.js',
  '/js/crypto.js',
  '/js/rtc.js',
  '/js/names.js',
  '/js/ui.js',
  '/js/levels.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return; // always live

  // Navigations: every room URL renders the same shell, so a cached shell is
  // a correct answer even for a room this device has never opened.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(url.pathname.startsWith('/r/') ? '/room.html' : '/index.html'),
      ),
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const live = fetch(request)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || live;
    }),
  );
});
