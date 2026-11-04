// Re-rate every puzzle in the pools in tools/library/ with the current rules and
// weights (js/rating.js), in parallel. Run this after adding a deduction rule or
// changing the scoring, then rebuild the books with tools/build_books.mjs.
//
//   node tools/rescore_library.mjs [--jobs 8] [--only L_8x8,P5_*]
//
// Only the `rules` and `score` columns change; the puzzles themselves (and so any
// player's saved progress) are untouched.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { parseCsv, toCsv } from '../js/logic.js';
import { ratePuzzle, TIERS } from '../js/rating.js';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const libDir = new URL('./library/', import.meta.url);

// Worker mode: rescore one pool file and print a one-line summary.
if (opt('worker')) {
  const file = new URL(opt('worker'), libDir);
  const puzzles = parseCsv(readFileSync(file, 'utf8'));
  let changed = 0;
  const lv = Object.fromEntries(TIERS.map(t => [t, 0]));
  for (const p of puzzles) {
    const r = ratePuzzle(p);
    if (p.rules !== r.rules || p.tier !== r.tier || p.score !== r.score) changed++;
    p.rules = r.rules; p.tier = r.tier; p.score = r.score; lv[r.tier]++;
  }
  writeFileSync(file, '# pool: generated, scored puzzles (not published). See tools/fill_library.mjs\n' + toCsv(puzzles));
  console.log(`${opt('worker').replace('.csv', '')}: ${puzzles.length} puzzles, ${changed} changed; tiers ${TIERS.map(t => lv[t]).join('/')}`);
  process.exit(0);
}

const only = opt('only') ? opt('only').split(',').map(g => new RegExp('^' + g.replace(/\*/g, '.*') + '$')) : null;
const files = readdirSync(libDir).filter(f => /^[A-Z0-9]+_\d+x\d+\.csv$/.test(f))
  .filter(f => !only || only.some(re => re.test(f.replace('.csv', ''))));
const jobs = Number(opt('jobs') ?? Math.max(1, os.cpus().length - 1));
let next = 0, running = 0, done = 0;
const t0 = Date.now();
function launch() {
  while (running < jobs && next < files.length) {
    const f = files[next++];
    running++;
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--worker', f], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => {
      running--; done++;
      console.log(`[${done}/${files.length}] ${out.trim() || `${f}: exited ${code}`}`);
      if (done === files.length) console.log(`rescored ${files.length} pool(s) in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      launch();
    });
  }
}
if (!files.length) console.log('no pools found'); else launch();
