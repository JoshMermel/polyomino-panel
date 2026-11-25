// The page head and the install / link-preview files it points at: everything referenced exists, with the size it claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { SITE_URL } from '../js/print.js';

const root = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');
const html = read('index.html');
const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
const tags = re => [...html.matchAll(re)].map(m => m[0]);

// width and height of a PNG, from its header
function pngSize(file) {
  const b = readFileSync(new URL(file, root));
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('site: every file the page head links to exists', () => {
  const links = tags(/<link [^>]*href="[^"]*"[^>]*>/g).map(t => attr(t, 'href')).filter(h => !/^https?:/.test(h));
  assert.ok(links.includes('favicon.svg') && links.includes('manifest.webmanifest') && links.includes('icons/apple-touch-icon.png'));
  for (const href of links) assert.ok(existsSync(new URL(href, root)), `${href} exists`);
  for (const t of tags(/<script [^>]*src="[^"]*"[^>]*>/g)) assert.ok(existsSync(new URL(attr(t, 'src'), root)), `${attr(t, 'src')} exists`);
});

test('site: the link-preview image is a 1200x630 PNG at an absolute address on the site', () => {
  const og = tags(/<meta property="og:image"[^>]*>/g).map(t => attr(t, 'content'))[0];
  assert.ok(og.startsWith(SITE_URL), `og:image ${og} is under ${SITE_URL}`);
  assert.deepEqual(pngSize(og.slice(SITE_URL.length)), [1200, 630]);
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta property="og:image:height" content="630">/);
  assert.equal(attr(tags(/<meta property="og:url"[^>]*>/g)[0], 'content'), SITE_URL);
  for (const p of ['og:title', 'og:description']) assert.ok(tags(new RegExp(`<meta property="${p}"[^>]*>`, 'g')).length === 1, `${p} is set once`);
});

test('site: the Home Screen icons are the sizes they say', () => {
  assert.deepEqual(pngSize('icons/apple-touch-icon.png'), [180, 180]);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.name && manifest.short_name && manifest.start_url && manifest.display === 'standalone');
  assert.ok(manifest.icons.some(i => i.sizes === '192x192') && manifest.icons.some(i => i.sizes === '512x512'));
  for (const i of manifest.icons) assert.deepEqual(pngSize(i.src), i.sizes.split('x').map(Number), `${i.src} is ${i.sizes}`);
});

test('site: the theme color is set in the head, and by both scripts that change the theme', () => {
  assert.ok(tags(/<meta name="theme-color"[^>]*>/g).length === 1);
  assert.match(html, /meta\[name="theme-color"\]/);                       // the head script, before first paint
  assert.match(read('js/main.js'), /meta\[name="theme-color"\]/);          // the dark-mode switch
  // the colors it uses are the page backgrounds of the two themes
  const css = read('style.css');
  const dark = /:root\[data-theme="dark"\] \{[^}]*--bg-white: (#[0-9a-f]+)/i.exec(css)?.[1];
  const light = /--bg-white: (#[0-9a-f]+)/i.exec(css)?.[1];
  assert.ok(html.includes(`'${dark}'`) && html.includes(`'#ffffff'`) && light === '#fff', 'theme-color matches --bg-white in both themes');
});
