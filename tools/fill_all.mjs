// Fill the pools for every book in tools/books/recipes.json, several at a time.
//
//   node tools/fill_all.mjs [--target 400] [--jobs 8] [--only L_8x8,P5_*] [--max-minutes 15]
//
// Each combination runs tools/fill_library.mjs in its own process. Prints one
// summary line per combination as it finishes.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const recipes = JSON.parse(readFileSync(new URL('./books/recipes.json', import.meta.url), 'utf8'));
const target = args.target ?? '400';
const jobs = Number(args.jobs ?? Math.max(1, os.cpus().length - 1));
const maxMinutes = args['max-minutes'] ?? '15';
const only = args.only ? args.only.split(',').map(g => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')) : null;

const combos = [];
for (const size of recipes.sizes) for (const tile of recipes.shapes) {
  if (!only || only.some(re => re.test(`${tile}_${size}x${size}`))) combos.push({ tile, size });
}
// slowest (biggest boards) first so they overlap with the quick ones
combos.sort((a, b) => b.size - a.size);

let next = 0, running = 0, done = 0;
const t0 = Date.now();
function launch() {
  while (running < jobs && next < combos.length) {
    const { tile, size } = combos[next++];
    running++;
    const child = spawn(process.execPath, [new URL('./fill_library.mjs', import.meta.url).pathname,
      '--tile', tile, '--size', String(size), '--target', target, '--max-minutes', maxMinutes, '--quiet', '1'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => {
      running--; done++;
      console.log(`[${done}/${combos.length}] ${out.trim() || `${tile} ${size}x${size}: exited ${code} with no output`}`);
      if (done === combos.length) console.log(`all done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      launch();
    });
  }
}
launch();
