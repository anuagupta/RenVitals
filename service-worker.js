'use strict';
/* Vitals service worker — offline app-shell caching + notification taps.
   All data logic lives in app.js/localStorage; this file only makes the
   app load without a network connection and handles notification clicks. */

// Bump this together with the ?v= query strings in index.html on every
// deploy that touches app.js/drive.js/styles.css — mismatched versions
// (fresh markup, stale cached script) is how a new button can appear but
// silently do nothing.
const CACHE_NAME = 'vitals-cache-v33';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=21',
  './app.js?v=33',
  './drive.js?v=8',
  './manifest.json',
  './manifest.json?v=6',
  './release-check.js?v=1',
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
      .then(cache => Promise.all(APP_SHELL.map(async path => {
        const response = await fetchFresh(new URL(path, self.location.href));
        if(!response.ok) throw new Error('App shell download failed: ' + path);
        await cache.put(path, response);
      })))
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
function fetchFresh(url){
  // Unique URLs also bypass GitHub Pages' short-lived CDN cache. Cache
  // entries retain the original URLs, so offline visits still find them.
  const fresh = new URL(url);
  fresh.searchParams.set('__vitals_fresh', Date.now().toString());
  return fetch(fresh.href, {cache:'no-store', credentials:'same-origin'});
}
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;
  // Version probes must never be satisfied from offline cache or saved as
  // an unbounded series of timestamped HTML entries.
  if(url.searchParams.has('__vitals_check')){
    event.respondWith(fetchFresh(url));
    return;
  }
  const cacheKey = new URL(url);
  cacheKey.searchParams.delete('__vitals_release');
  cacheKey.searchParams.delete('__vitals_fresh');

  event.respondWith(
    fetchFresh(url).then(res => {
      if(res.ok){
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(cacheKey.href, copy)).catch(()=>{}));
      }
      return res;
    }).catch(async () => {
      const cached = await caches.match(cacheKey.href);
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
