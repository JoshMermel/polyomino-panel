// Draws the PNGs the page head points at (icons/): the Home Screen / install icons and the link-preview image.
//
//   node tools/make_icons.mjs        (needs Google Chrome; macOS path below, or set CHROME=/path/to/chrome)
//
// icons/apple-touch-icon.png (180), icons/icon-192.png, icons/icon-512.png: the favicon's mosaic, full-bleed square (the phone
// rounds the corners; the mosaic stays inside the middle 80%, so the same art serves as a maskable icon).
// icons/og.png (1200x630): a solved puzzle (the first Medium L puzzle of one-6 with 4 to 6 blocked cells) next to the title.
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parseCsv } from '../js/logic.js';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = new URL('..', import.meta.url).pathname;
mkdirSync(`${root}icons`, { recursive: true });
const work = `${tmpdir()}/pp-icons`;
mkdirSync(work, { recursive: true });

const BLUE = '#1976d2', PALETTE = ['#bbdefb', '#ffe082', '#b2dfdb', '#ffffff'];
const shot = (name, w, h, html) => {
  const page = `${work}/${name}.html`;
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}</style>${html}`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${w},${h}`, `--screenshot=${root}icons/${name}.png`, `file://${page}`], { stdio: 'ignore' });
};

// the favicon's mosaic on a full-bleed square
const favicon = readFileSync(`${root}favicon.svg`, 'utf8');
const square = favicon.replace(/<title>.*?<\/title>/, '').replace(/ rx="7"/, '').replace('<svg ', '<svg width="100%" height="100%" ');
for (const [name, size] of [['apple-touch-icon', 180], ['icon-192', 192], ['icon-512', 512]]) shot(name, size, size, `<div style="width:${size}px;height:${size}px">${square}</div>`);

// a solved puzzle: cells coloured by tile, a gap between tiles, blocked cells dark
const puzzle = parseCsv(readFileSync(`${root}data/one-6.csv`, 'utf8')).find(p => p.tile === 'L' && p.tier === 'Medium' && [...p.grid].filter(c => c === '#').length >= 4 && [...p.grid].filter(c => c === '#').length <= 6);
const { rows, cols, solution } = puzzle, at = (r, c) => (r < 0 || c < 0 || r >= rows || c >= cols ? '#' : solution[r * cols + c]);
const labels = [...new Set([...solution].filter(c => c !== '#'))];
const colour = new Map();
for (const l of labels) {                                     // greedy colouring: a tile never shares a colour with a neighbour
  const near = new Set();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (at(r, c) === l) for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) { const n = at(r + dr, c + dc); if (n !== '#' && n !== l && colour.has(n)) near.add(colour.get(n)); }
  colour.set(l, PALETTE.find(p => !near.has(p)) ?? PALETTE[0]);
}
const CELL = 74, GAP = 4, R = 9, X0 = 88, Y0 = (630 - rows * CELL) / 2;
let board = `<rect x="${X0 - 22}" y="${Y0 - 22}" width="${cols * CELL + 44}" height="${rows * CELL + 44}" rx="26" fill="#0d47a1" opacity=".55"/>`;
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const x = X0 + c * CELL, y = Y0 + r * CELL, l = at(r, c);
  if (l === '#') { board += `<rect x="${x + 6}" y="${y + 6}" width="${CELL - 12}" height="${CELL - 12}" rx="${R}" fill="#10294d"/>`; continue; }
  // extend a cell towards a neighbour of the same tile so the tile reads as one piece
  const e = { l: at(r, c - 1) === l, r: at(r, c + 1) === l, t: at(r - 1, c) === l, b: at(r + 1, c) === l };
  const x1 = x + (e.l ? 0 : GAP), x2 = x + CELL - (e.r ? 0 : GAP), y1 = y + (e.t ? 0 : GAP), y2 = y + CELL - (e.b ? 0 : GAP);
  board += `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" rx="${R}" fill="${colour.get(l)}"/>`;
}
shot('og', 1200, 630, `<div style="position:relative;width:1200px;height:630px;background:${BLUE};font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:#fff">
  <svg width="1200" height="630" style="position:absolute;left:0;top:0">${board}</svg>
  <div style="position:absolute;left:660px;top:190px;width:480px">
    <div style="font-size:78px;font-weight:700;line-height:1.05;letter-spacing:-1px">Polyomino Panel</div>
    <div style="font-size:34px;line-height:1.3;margin-top:26px;opacity:.92">A logic puzzle: cut the board into tiles of the shape shown.</div>
  </div></div>`);
rmSync(work, { recursive: true, force: true });
console.log('wrote icons/ (apple-touch-icon, icon-192, icon-512, og) from', puzzle.name);
