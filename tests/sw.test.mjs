// Exercises sw.js (offline play) without a browser: the worker's code runs in a sandbox with an
// in-memory Cache API and a fake network that can be switched off.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:8765/';
const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const abs = u => new URL(typeof u === 'string' ? u : u.url, BASE).href;
const noSearch = href => { const u = new URL(href); u.search = ''; return u.href; };

// A tiny Cache API: stores cloned responses by absolute URL.
function makeCaches() {
  const stores = new Map();
  const open = async name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async match(req, opts = {}) {
        const k = abs(req);
        for (const [key, res] of m) if (opts.ignoreSearch ? noSearch(key) === noSearch(k) : key === k) return res.clone();
        return undefined;
      },
      async add(req) {
        const res = await network.fetch(abs(req));
        if (!res.ok) throw new Error(`bad response ${res.status}`);
        m.set(abs(req), res.clone());
      },
      async put(req, res) { m.set(abs(req), res.clone()); },
      async keys() { return [...m.keys()].map(k => new Request(k)); },
    };
  };
  return {
    stores, open,
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    async match(req, opts) {
      for (const name of stores.keys()) { const hit = await (await open(name)).match(req, opts); if (hit) return hit; }
      return undefined;
    },
  };
}

// The fake network: `files` maps absolute URL -> body; `online` switches it off.
const network = {
  online: true, files: new Map(), failing: new Set(),
  async fetch(input) {
    const href = abs(input);
    if (!network.online) throw new TypeError('Failed to fetch');
    if (network.failing.has(href) || !network.files.has(href.split('?')[0])) return new Response('nope', { status: 404 });
    return new Response(network.files.get(href.split('?')[0]), { status: 200 });
  },
};

function loadWorker() {
  const listeners = {};
  const caches = makeCaches();
  const self = {
    location: { origin: new URL(BASE).origin, href: BASE + 'sw.js' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  vm.runInNewContext(source, { self, caches, fetch: network.fetch, URL, Request, Response, Promise, console: { warn() {}, log() {} } });
  // dispatch an event and collect what the worker waited on / responded with
  const dispatch = async (type, props = {}) => {
    const waits = [];
    let response;
    const event = { ...props, waitUntil: p => waits.push(p), respondWith: p => { response = Promise.resolve(p); } };
    listeners[type](event);
    await Promise.all(waits);
    return { response, handled: response !== undefined };
  };
  const get = (url, mode = 'cors') => dispatch('fetch', { request: { url: abs(url), method: 'GET', mode } });
  return { caches, dispatch, get };
}

const SHELL = ['', 'index.html', 'style.css', 'js/main.js', 'js/logic.js', 'js/rating.js', 'js/board.js', 'js/tile-view.js', 'js/print.js'];
function resetNetwork(version = 'v1') {
  network.online = true; network.failing.clear(); network.files.clear();
  for (const f of SHELL) network.files.set(BASE + f, `${f || 'index.html'} ${version}`);
  network.files.set(BASE + 'data/manifest.json', '{"books":[]}');
  network.files.set(BASE + 'data/L_6x6.csv', 'L_6x6 puzzles');
  network.files.set(BASE + 'data/T_8x8.csv', 'T_8x8 puzzles');
}
const body = async r => (await (await r).text());

test('sw: install precaches the whole app shell', async () => {
  resetNetwork();
  const sw = loadWorker();
  await sw.dispatch('install');
  const keys = (await (await sw.caches.open('pp-shell-v1')).keys()).map(r => r.url);
  for (const f of SHELL.filter(Boolean)) assert.ok(keys.includes(BASE + f), `${f} cached`);
});

test('sw: the app opens offline, whatever the ?book=&puzzle= query', async () => {
  resetNetwork();
  const sw = loadWorker();
  await sw.dispatch('install');
  network.online = false;
  const nav = await sw.get('index.html?book=T_8x8&puzzle=12', 'navigate');
  assert.ok(nav.handled);
  assert.equal(await body(nav.response), 'index.html v1');
  const root = await sw.get('', 'navigate');
  assert.equal(await body(root.response), 'index.html v1');
  const script = await sw.get('js/main.js');                 // a module the page imports
  assert.equal(await body(script.response), 'js/main.js v1');
});

test('sw: puzzle books are served from cache offline once seen (stale-while-revalidate)', async () => {
  resetNetwork();
  const sw = loadWorker();
  await sw.dispatch('install');
  const first = await sw.get('data/L_6x6.csv');                // online: fetched and cached
  assert.equal(await body(first.response), 'L_6x6 puzzles');
  network.files.set(BASE + 'data/L_6x6.csv', 'L_6x6 puzzles, updated');
  const second = await sw.get('data/L_6x6.csv');               // online again: cached copy now, refresh behind it
  assert.equal(await body(second.response), 'L_6x6 puzzles');
  const third = await sw.get('data/L_6x6.csv');                // the refresh has landed
  assert.equal(await body(third.response), 'L_6x6 puzzles, updated');
  network.online = false;
  const offline = await sw.get('data/L_6x6.csv');
  assert.equal(await body(offline.response), 'L_6x6 puzzles, updated');
  const unseen = await sw.get('data/T_8x8.csv');               // never fetched: an honest failure
  await assert.rejects(unseen.response, /Offline and no cached copy/);
});

test('sw: a shell refresh is all-or-nothing', async () => {
  resetNetwork('v1');
  const sw = loadWorker();
  await sw.dispatch('install');
  // deploy v2, but one file is broken: the cached shell must stay entirely v1
  resetNetwork('v2');
  network.failing.add(BASE + 'js/board.js');
  await sw.get('index.html', 'navigate');
  let page = await sw.get('index.html', 'navigate');
  assert.equal(await body(page.response), 'index.html v1');
  assert.equal(await body((await sw.get('js/main.js')).response), 'js/main.js v1');
  // the broken file is fixed: the whole shell moves to v2 together
  network.failing.clear();
  await sw.get('index.html', 'navigate');
  page = await sw.get('index.html', 'navigate');
  assert.equal(await body(page.response), 'index.html v2');
  assert.equal(await body((await sw.get('js/board.js')).response), 'js/board.js v2');
});

test('sw: activate drops old shell caches but keeps puzzle books; foreign and non-GET requests pass through', async () => {
  resetNetwork();
  const sw = loadWorker();
  await sw.caches.open('pp-shell-v0');
  await sw.caches.open('pp-data-v1');
  await sw.caches.open('some-other-app');
  await sw.dispatch('install');
  await sw.dispatch('activate');
  const names = await sw.caches.keys();
  assert.ok(!names.includes('pp-shell-v0'));
  assert.ok(names.includes('pp-data-v1') && names.includes('pp-shell-v1') && names.includes('some-other-app'));
  const post = await sw.dispatch('fetch', { request: { url: BASE + 'x', method: 'POST', mode: 'cors' } });
  assert.equal(post.handled, false);
  const foreign = await sw.dispatch('fetch', { request: { url: 'https://example.com/data/x.csv', method: 'GET', mode: 'cors' } });
  assert.equal(foreign.handled, false);
});

test('sw: stray same-origin requests pass through without being cached', async () => {
  resetNetwork();
  network.files.set(BASE + 'favicon.ico', 'icon');
  const sw = loadWorker();
  await sw.dispatch('install');
  const before = (await (await sw.caches.open('pp-shell-v1')).keys()).length;
  const icon = await sw.get('favicon.ico');
  assert.equal(await body(icon.response), 'icon');
  const withQuery = await sw.get('js/main.js?v=99');           // a known file with a query string: served from cache
  assert.equal(await body(withQuery.response), 'js/main.js v1');
  await new Promise(r => setTimeout(r, 10));                    // let any background cache.put land
  assert.equal((await (await sw.caches.open('pp-shell-v1')).keys()).length, before);
});

test('sw: the app shell lists every module the page imports', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const listed = new Set([...source.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'\.\/([^']*)'/g)].map(m => m[1]));
  // walk the ES-module graph from js/main.js
  const seen = new Set(), queue = ['js/main.js'];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(root + file, 'utf8');
    for (const m of code.matchAll(/from\s+'(\.[^']+)'/g)) queue.push(new URL(m[1], 'file:///' + file).pathname.slice(1));
  }
  for (const f of [...seen, 'index.html', 'style.css']) assert.ok(listed.has(f), `${f} is missing from APP_SHELL in sw.js`);
});
