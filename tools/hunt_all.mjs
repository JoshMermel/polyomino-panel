// Run the hard-puzzle hunter (tools/hunt_library.mjs) on every combination in
// tools/books/recipes.json, several at a time, most-needy combinations first.
//
//   node tools/hunt_all.mjs [--hours 3] [--minutes 30] [--jobs 8]
//        [--want chain,unsolved] [--targets chain=300,unsolved=150] [--only L_8x8,P5_*]
//
// --want Beginner,Medium hunts easy puzzles instead (for books whose pools are thin there).
//
// --hours is a hard overall deadline (children stop then); --minutes is each
// combination's own budget. Combinations whose pool has nothing above Medium get a
// short probe (the hunter gives up if nothing hard turns up). A one-line summary per
// combination is printed as it finishes and appended to tools/library/hunt.log.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { parseCsv } from '../js/logic.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const recipes = JSON.parse(readFileSync(new URL('./books/recipes.json', import.meta.url), 'utf8'));
const hours = Number(args.hours ?? 3);
const minutes = args.minutes ?? '30';
const jobs = Number(args.jobs ?? Math.max(1, os.cpus().length - 1));
const want = args.want ?? 'chain,unsolved';
const wanted = want.split(',');
const targets = args.targets ?? (want.includes('Beginner') ? 'Beginner=300,Medium=300' : 'chain=300,unsolved=150');
const only = args.only ? args.only.split(',').map(g => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')) : null;
const until = Date.now() + hours * 3600000;
const logFile = new URL('./library/hunt.log', import.meta.url);
const say = line => { console.log(line); appendFileSync(logFile, line + '\n'); };

// How much each combination already has of what we want (needier = fewer).
const combos = [];
for (const size of recipes.sizes) for (const tile of recipes.shapes) {
  const id = `${tile}_${size}x${size}`;
  if (only && !only.some(re => re.test(id))) continue;
  const f = new URL(`./library/${id}.csv`, import.meta.url);
  if (!existsSync(f)) continue;
  const pool = parseCsv(readFileSync(f, 'utf8'));
  if (pool.length < 10) continue;
  const isFind = p => wanted.includes(p.rules) || wanted.includes(p.tier);
  const top = pool.filter(isFind).length;                       // what the pool already has of what we want
  const anyHard = pool.some(isFind);
  combos.push({ tile, size, id, top, anyHard });
}
combos.sort((a, b) => (b.anyHard - a.anyHard) || (a.top - b.top) || (b.size - a.size));   // flexible & needy first, hopeless last

say(`=== hunt started ${new Date().toISOString()}: ${combos.length} combinations, ${jobs} jobs, ${hours}h deadline, want ${want}, targets ${targets}`);
let next = 0, running = 0, done = 0;
const t0 = Date.now();
function launch() {
  while (running < jobs && next < combos.length && Date.now() < until - 60000) {
    const c = combos[next++];
    running++;
    const budget = c.anyHard ? minutes : '4';                  // rigid shapes: a short probe
    const child = spawn(process.execPath, [new URL('./hunt_library.mjs', import.meta.url).pathname,
      '--tile', c.tile, '--size', String(c.size), '--minutes', budget, '--want', want, '--targets', targets,
      '--probe-minutes', c.anyHard ? '3' : '2', '--stall-minutes', '8', '--until', String(until), '--quiet', '1'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => {
      running--; done++;
      say(`[${done}/${combos.length}] ${out.trim() || `${c.id}: exited ${code} with no output`}`);
      if (running === 0 && (next >= combos.length || Date.now() >= until - 60000)) {
        say(`=== hunt finished ${new Date().toISOString()} after ${((Date.now() - t0) / 60000).toFixed(0)} min (${done}/${combos.length} combinations)`);
      }
      launch();
    });
  }
}
launch();
