// Service worker for offline play (opt-in: Settings -> "Offline play"; see index.html and js/main.js).
//
// Same design as multiverse star battle's, two kinds of content:
//  - App shell (HTML/CSS/JS): served instantly from cache. Whenever the page is opened with a
//    connection, the WHOLE shell is re-fetched in the background and written to the cache only
//    if every file succeeded, so the cache never holds a mix of old and new files that call into
//    each other. A fresh deploy therefore shows up on the visit after the one that fetched it.
//    Bump SHELL_CACHE only to force a hard reset (e.g. when the list of files changes).
//  - Puzzle data (data/manifest.json, data/*.csv): independent files, so plain per-file
//    stale-while-revalidate: serve the cached copy, refresh it in the background.
const SHELL_CACHE = 'pp-shell-v1';
const DATA_CACHE = 'pp-data-v1';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './js/main.js',
  './js/logic.js',
  './js/topology.js',
  './js/hex_shapes.js',
  './js/tri_shapes.js',
  './js/rating.js',
  './js/board.js',
  './js/tile-view.js',
  './js/print.js',
];

const isDataRequest = url => url.pathname.includes('/data/') && !url.pathname.endsWith('/data/tmp.csv');   // tmp.csv: local scratch book, never cached
const SHELL_PATHS = new Set(APP_SHELL.map(u => new URL(u, self.location.href).pathname));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.all(APP_SHELL.map(url => cache.add(url).catch(err => console.warn('[sw] precache failed:', url, err)))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      // only old *shell* caches are removed: an app update never wipes the cached puzzle books
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pp-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

let shellUpdate = null;
function updateShellAtomically() {
  if (shellUpdate) return shellUpdate;
  shellUpdate = (async () => {
    try {
      const fetched = await Promise.all(APP_SHELL.map(url =>
        fetch(url, { cache: 'no-store' }).then(res => {
          if (!res.ok) throw new Error(`Bad response (${res.status}) for ${url}`);
          return [url, res];
        })));
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(fetched.map(([url, res]) => cache.put(url, res)));
    } catch (err) {
      console.warn('[sw] shell refresh skipped (staying on the cached version):', err);
    } finally {
      shellUpdate = null;
    }
  })();
  return shellUpdate;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // only our own files

  if (isDataRequest(url)) {
    event.respondWith(caches.open(DATA_CACHE).then(async cache => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      const res = await network;
      if (res) return res;
      throw new Error(`Offline and no cached copy of ${req.url}`);
    }));
    return;
  }

  // Every URL of the app (whatever its ?book=...&puzzle=... query) is the same page, and routing
  // happens in the browser, so a navigation always resolves to the one cached index.html. That
  // also lets a link to a never-visited puzzle open offline.
  if (req.mode === 'navigate') {
    event.waitUntil(updateShellAtomically());
    event.respondWith(caches.match('./index.html').then(cached => cached || fetch(req)));
    return;
  }

  event.respondWith(caches.match(req, { ignoreSearch: true }).then(cached => cached || fetch(req).then(res => {
    // only the app's own files are kept; stray requests (favicon, ?v= variants) pass through uncached
    if (res && res.ok && SHELL_PATHS.has(url.pathname)) { const copy = res.clone(); caches.open(SHELL_CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
