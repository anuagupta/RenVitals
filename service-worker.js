'use strict';
/* Vitals service worker — offline app-shell caching + notification taps.
   All data logic lives in app.js/localStorage; this file only makes the
   app load without a network connection and handles notification clicks. */

const CACHE_NAME = 'vitals-cache-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './drive.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
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
      const copy = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
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
