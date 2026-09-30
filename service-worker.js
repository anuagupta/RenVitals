'use strict';
/* Vitals service worker — offline app-shell caching + notification taps.
   All data logic lives in app.js/localStorage; this file only makes the
   app load without a network connection and handles notification clicks. */

// Bump this together with the ?v= query strings in index.html on every
// deploy that touches app.js/drive.js/styles.css — mismatched versions
// (fresh markup, stale cached script) is how a new button can appear but
// silently do nothing.
const CACHE_NAME = 'vitals-cache-v31';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=20',
  './app.js?v=32',
  './drive.js?v=8',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-192.png?v=5',
  './icons/icon-512.png',
  './icons/icon-512.png?v=5',
  './icons/icon-192-maskable.png',
  './icons/icon-192-maskable.png?v=5',
  './icons/icon-512-maskable.png',
  './icons/icon-512-maskable.png?v=5',
  './icons/apple-touch-icon.png',
  './icons/apple-touch-icon.png?v=5',
  './icons/favicon-32.png',
  './icons/favicon-32.png?v=5',
  './icons/favicon-16.png?v=5',
  './icons/favicon-16.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for same-origin navigations/assets, falling back to cache
// when offline; anything cross-origin (Google APIs, fonts) just passes
// through untouched.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then(res => {
      if(res.ok){
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(()=>{}));
      }
      return res;
    }).catch(async () => {
      const cached = await caches.match(req);
      if(cached) return cached;
      if(req.mode === 'navigate' && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'))){
        return await caches.match('./index.html') || Response.error();
      }
      return Response.error();
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientsArr => {
      for(const client of clientsArr){
        if('focus' in client) return client.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
