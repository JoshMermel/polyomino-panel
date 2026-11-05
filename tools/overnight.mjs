// Batch driver for big generation runs: fills pools for ALL pairs of shapes, in passes, resumable.
//
//   node tools/overnight.mjs --hours 9                 the real run (use: caffeinate -i node tools/overnight.mjs --hours 9)
//   node tools/overnight.mjs --smoke                   a ~10 minute trial on 18 combinations, separate progress file
//   options: --jobs N (default: cores - 1)  --size 8,10  --only L+T_8x8,P5+*  --progress FILE  --seed N
//
// Combinations: every unordered pair of the single shapes in tools/books/recipes.json (the pairs already
// listed there keep their names), at every size in recipes.json. They are added to recipes.json (so
// the builder, rescoring and hunter see them) and each gets a pool file tools/library/<A+B>_<n>x<n>.csv.
//
// Passes (each combination is one child process; a crash costs only that combination):
//   1  survey   tools/fill_library.mjs, target 20, 2 minutes: which combinations can be generated at all
//   2  fill     the viable ones (pool >= 5), target 200, 8 minutes: puzzles spread over blocked-cell counts
//   3  easy     the viable ones with fewer than 60 Beginner puzzles: tools/hunt_library.mjs --want Beginner,Medium
//               (fresh puzzles only), 8 minutes
// Progress is written to tools/library/overnight.json after every combination, so rerunning the command
// resumes where it stopped (finished combinations of a pass are skipped). Stops launching at the deadline.
// Afterwards: node tools/prune_library.mjs --apply, then rebuild the books.
import { readFileSync, writeFileSync, existsSync, renameSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { parseCsv } from '../js/logic.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']);
  return acc;
}, []));
const smoke = 'smoke' in args;
const hours = Number(args.hours ?? (smoke ? 0.25 : 9));
const jobs = Number(args.jobs ?? Math.max(1, os.cpus().length - 1));
const seed = Number(args.seed ?? 20261104);
const root = new URL('./', import.meta.url);
const recipesFile = new URL('books/recipes.json', root);
const libDir = new URL('library/', root);
const progressFile = new URL(args.progress ?? (smoke ? 'library/overnight_smoke.json' : 'library/overnight.json'), root);
const logFile = new URL(smoke ? 'library/overnight_smoke.log' : 'library/overnight.log', root);
const until = Date.now() + hours * 3600000;
const say = line => { const l = `${new Date().toISOString().slice(11, 19)} ${line}`; console.log(l); appendFileSync(logFile, l + '\n'); };

// --- the combinations ---------------------------------------------------------------------------
const recipes = JSON.parse(readFileSync(recipesFile, 'utf8'));
const singles = recipes.shapes.filter(s => !s.includes('+'));
const setKey = spec => spec.split('+').sort().join('+');
const have = new Set(recipes.shapes.filter(s => s.includes('+')).map(setKey));
let added = 0;
for (let i = 0; i < singles.length; i++) for (let j = i + 1; j < singles.length; j++) {
  const spec = `${singles[i]}+${singles[j]}`;
  if (!have.has(setKey(spec))) { recipes.shapes.push(spec); have.add(setKey(spec)); added++; }
}
if (added) { writeFileSync(recipesFile, JSON.stringify(recipes, null, 2) + '\n'); say(`recipes.json: added ${added} pairs`); }

let combos = [];
for (const size of recipes.sizes) for (const tile of recipes.shapes) {
  if (!tile.includes('+') || tile.split('+').length !== 2) continue;
  combos.push({ tile, size, id: `${tile}_${size}x${size}` });
}
const sizes = args.size ? args.size.split(',').map(Number) : null;
if (sizes) combos = combos.filter(c => sizes.includes(c.size));
if (args.only) {
  const res = args.only.split(',').map(g => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
  combos = combos.filter(c => res.some(re => re.test(c.id)));
}
if (smoke) {                                           // 6 per size, spread over the list (deterministic)
  combos = recipes.sizes.flatMap(size => { const cs = combos.filter(c => c.size === size); return [0, 1, 2, 3, 4, 5].map(k => cs[Math.floor((k + 0.5) * cs.length / 6)]); });
}

// --- progress ------------------------------------------------------------------------------------
const progress = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, 'utf8')) : {};
const save = () => { const tmp = new URL(progressFile.pathname + '.tmp', 'file:'); writeFileSync(tmp, JSON.stringify(progress)); renameSync(tmp, progressFile); };
const get = (pass, id) => progress[pass]?.[id];
const put = (pass, id, v) => { (progress[pass] ??= {})[id] = v; save(); };

const poolTiers = id => {
  const f = new URL(`${id}.csv`, libDir);
  if (!existsSync(f)) return { n: 0, B: 0, M: 0, H: 0 };
  const ps = parseCsv(readFileSync(f, 'utf8'));
  return { n: ps.length, B: ps.filter(p => p.tier === 'Beginner').length, M: ps.filter(p => p.tier === 'Medium').length, H: ps.filter(p => p.tier === 'Hard').length };
};

// --- running children ----------------------------------------------------------------------------
function runTask(passName, c, argv) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out: out.trim(), err: err.trim(), secs: Math.round((Date.now() - t0) / 1000) }));
  });
}

async function runPass(name, list, makeArgs, summarize) {
  const todo = list.filter(c => !get(name, c.id));
  say(`=== pass ${name}: ${todo.length} to do (${list.length - todo.length} already done), ${jobs} jobs`);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < until - 5 * 60000) {
      const c = todo[next++];
      const r = await runTask(name, c, makeArgs(c));
      const rec = { code: r.code, secs: r.secs, ...summarize(c, r) };
      put(name, c.id, rec);
      done++;
      say(`[${name} ${done}/${todo.length}] ${c.id}: ${r.out.split('\n').pop() || `exit ${r.code} ${r.err.split('\n').pop() ?? ''}`}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  say(`=== pass ${name} finished (${done} run now)`);
}

const bySizeDesc = (a, b) => b.size - a.size;
const node = f => new URL(f, root).pathname;

// pass 1: survey
await runPass('1', [...combos].sort(bySizeDesc),
  c => [node('fill_library.mjs'), '--tile', c.tile, '--size', String(c.size), '--target', smoke ? '10' : '20', '--max-minutes', smoke ? '1' : '2', '--seed', String(seed), '--quiet', '1'],
  (c, r) => ({ dead: /no feasible/.test(r.out), ...poolTiers(c.id) }));

// pass 2: fill the viable combinations
const viable = combos.filter(c => { const p = get('1', c.id); return p && !p.dead && poolTiers(c.id).n >= 5; });
say(`${viable.length} of ${combos.length} combinations are viable`);
await runPass('2', [...viable].sort(bySizeDesc),
  c => [node('fill_library.mjs'), '--tile', c.tile, '--size', String(c.size), '--target', smoke ? '30' : '200', '--max-minutes', smoke ? '2' : '8', '--seed', String(seed + 1), '--quiet', '1'],
  c => poolTiers(c.id));

// pass 3: easy puzzles where Beginner is scarce
const needy = viable.filter(c => poolTiers(c.id).B < 60).sort(bySizeDesc);
await runPass('3', needy,
  c => [node('hunt_library.mjs'), '--tile', c.tile, '--size', String(c.size), '--minutes', smoke ? '2' : '8', '--want', 'Beginner,Medium', '--targets', 'Beginner=100,Medium=25',
    '--probe-minutes', '3', '--stall-minutes', '5', '--until', String(until), '--seed', String(seed + 2), '--quiet', '1'],
  c => poolTiers(c.id));

const total = combos.reduce((a, c) => { const t = poolTiers(c.id); return { n: a.n + t.n, B: a.B + t.B, M: a.M + t.M, H: a.H + t.H }; }, { n: 0, B: 0, M: 0, H: 0 });
say(`=== done: ${combos.length} combinations, ${total.n} puzzles (Beginner ${total.B}, Medium ${total.M}, Hard ${total.H})`);
