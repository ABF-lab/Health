/*
 * sw.js — Sehat Ledger service worker
 *
 * Cache-first for the app shell, so a volunteer in a basement prayer hall
 * with no signal opens the app and it simply works. That is the whole point:
 * the screening must never depend on connectivity, because in the field
 * there usually isn't any.
 *
 * The only network-dependent feature is the Gemini vision call. Everything
 * else — intake, scoring, records, the ledger — runs entirely on device.
 */

const CACHE = 'sehat-ledger-v25';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './fonts/inter.woff2',
  './app.js',
  './clinical.js',
  './ledger.js',
  './ai.js',
  './sync.js',
  './icon.svg',
  './manifest.webmanifest',
  './assets/abf-logo.png',
  './assets/bg.jpg',
  './assets/bg-mobile.jpg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache model calls. A stale vital sign is worse than no vital sign.
  if (url.hostname.includes('generativelanguage.googleapis.com')) return;
  if (url.hostname.endsWith('.supabase.co')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) {
        // Refresh in the background so the next launch is current
        fetch(e.request)
          .then(res => { if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone())); })
          .catch(() => {});
        return hit;
      }
      return fetch(e.request)
        .then(res => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
