/// <reference lib="webworker" />
// Service worker: keeps the app shell on the phone so it opens with no signal.
// API calls are never cached here; the app keeps its own copies in IndexedDB.

export {}; // makes this a module, so `self` can be re-typed below
declare const self: ServiceWorkerGlobalScope;

const CACHE = 'sts-shell-v1';
const STATIC = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-32.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await fetch('/', { cache: 'no-cache', redirect: 'manual' });
      if (!res.ok) throw new Error(`shell fetch failed: ${res.status}`);
      const html = await res.clone().text();
      // Vite hashes asset names; pick them out of the page so they're cached up front.
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] as string);
      await cache.put('/', res);
      await cache.addAll([...STATIC, ...assets]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  if (req.mode === 'navigate') {
    // Network first so a new deploy shows up; fall back to the saved shell with no signal.
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok && res.type === 'basic') {
            const cache = await caches.open(CACHE);
            await cache.put('/', res.clone());
          }
          return res;
        } catch {
          return (await caches.match('/')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed assets and icons: cache first.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});
