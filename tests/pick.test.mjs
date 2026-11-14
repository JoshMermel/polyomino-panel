// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickQuantiles, pickStable, hashString, weightedAllocation, evenAllocation, spreadOut, spreadByTier, SPREAD_WINDOW } from '../tools/lib/pick.mjs';

const pool = scores => scores.map((score, i) => ({ name: `p${i}`, score }));

test('picks sit at evenly spaced ranks from the easiest to the hardest, easiest first', () => {
  const cands = pool(Array.from({ length: 1000 }, (_, i) => i));        // scores 0..999
  const { picks, short } = pickQuantiles(cands, { count: 10, seed: 1 });
  assert.equal(short, 0);
  assert.deepEqual(picks.map(p => p.score), [0, 111, 222, 333, 444, 555, 666, 777, 888, 999]);
  assert.deepEqual(pickQuantiles(cands, { count: 1 }).picks.map(p => p.score), [500], 'a single pick is the median');
  assert.equal(new Set(picks.map(p => p.name)).size, 10, 'no puzzle picked twice');
});

test('picks follow the pool: a skewed pool gives mostly easy picks but still reaches the hard tail', () => {
  // 95% easy (0..99), a thin tail of hard ones up to 960
  const scores = [...Array.from({ length: 380 }, (_, i) => i % 100), ...Array.from({ length: 20 }, (_, i) => 200 + i * 40)];
  const { picks } = pickQuantiles(pool(scores), { count: 40 });
  assert.equal(picks.length, 40);
  assert.equal(new Set(picks.map(p => p.name)).size, 40);
  assert.ok(picks.filter(p => p.score < 100).length >= 36, 'the easy 95% gets about 95% of the picks');
  assert.equal(picks[picks.length - 1].score, 960, 'the top pick is the hardest puzzle');
  assert.equal(picks[0].score, 0, 'the first pick is the easiest puzzle');
});

test('a pool smaller than the request returns everything and reports the shortfall', () => {
  const { picks, short } = pickQuantiles(pool([5, 1, 3]), { count: 5 });
  assert.deepEqual(picks.map(p => p.score), [1, 3, 5]);
  assert.equal(short, 2);
  assert.deepEqual(pickQuantiles([], { count: 3 }), { picks: [], short: 3 });
});

test('ties are broken deterministically by seed, whatever the pool order', () => {
  const cands = pool(Array.from({ length: 100 }, () => 7));              // every score equal
  const a = pickQuantiles(cands, { count: 10, seed: 1 }).picks.map(p => p.name);
  const b = pickQuantiles(cands, { count: 10, seed: 1 }).picks.map(p => p.name);
  const c = pickQuantiles(cands, { count: 10, seed: 2 }).picks.map(p => p.name);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(new Set(a).size, 10);
  assert.deepEqual(pickQuantiles([...cands].reverse(), { count: 10, seed: 1 }).picks.map(p => p.name), a);
});

test('ties are broken by the puzzle\'s content (the key), not its name or the pool order', () => {
  const mk = (prefix, ids) => ids.map(i => ({ name: `${prefix}${i}`, content: `grid-${i}`, score: 7 }));
  const key = c => c.content;
  const ids = Array.from({ length: 100 }, (_, i) => i);
  const a = pickQuantiles(mk('a', ids), { count: 10, seed: 1, key }).picks.map(p => p.content);
  const renamed = pickQuantiles(mk('zz_', [...ids].reverse()), { count: 10, seed: 1, key }).picks.map(p => p.content);
  assert.deepEqual(a, renamed, 'renaming or reordering the same puzzles does not change the choice');
  assert.equal(new Set(a).size, 10);
  const other = pickQuantiles(mk('a', ids), { count: 10, seed: 2, key }).picks.map(p => p.content);
  assert.notDeepEqual(a, other, 'the seed still changes the choice');
  // with no key the name is used, as before
  assert.deepEqual(pickQuantiles(mk('a', ids), { count: 10, seed: 1 }).picks.map(p => p.name),
    pickQuantiles(mk('a', ids).reverse(), { count: 10, seed: 1 }).picks.map(p => p.name));
});

test('hashString is stable', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});


test('evenAllocation: equal shares, small cells give up what they cannot fill', () => {
  assert.deepEqual(evenAllocation(30, [99, 99, 99]), [10, 10, 10]);
  assert.deepEqual(evenAllocation(30, [4, 99, 99]), [4, 13, 13]);          // the small cell is exhausted, the rest share
  assert.deepEqual(evenAllocation(10, [3, 3, 3]), [3, 3, 3]);              // total capped by availability (9)
  assert.deepEqual(evenAllocation(2, [5, 5, 5]), [1, 1, 0]);               // fewer slots than cells
  assert.deepEqual(evenAllocation(5, []), []);
  assert.deepEqual(evenAllocation(0, [3, 3]), [0, 0]);
  // always sums to min(count, capacity) and never exceeds a cell
  for (const [n, caps] of [[7, [1, 2, 50]], [100, [10, 20, 30, 40]], [101, [10, 20, 30, 40]], [13, [0, 5, 0, 9]]]) {
    const a = evenAllocation(n, caps);
    assert.equal(a.reduce((x, y) => x + y, 0), Math.min(n, caps.reduce((x, y) => x + y, 0)));
    a.forEach((v, i) => assert.ok(v <= caps[i]));
  }
});

test('pickStable keeps what is already published and fills the rest at quantiles', () => {
  const cands = pool(Array.from({ length: 100 }, (_, i) => i));
  const kept = new Set(['p3', 'p50', 'p97']);
  const isKept = c => kept.has(c.name);
  // asking for more than are kept: all kept ones are in, plus quantile picks from the others
  const r = pickStable(cands, { count: 10, isKept });
  assert.equal(r.picks.length, 10);
  for (const name of kept) assert.ok(r.picks.some(p => p.name === name), `${name} kept`);
  assert.equal(new Set(r.picks.map(p => p.name)).size, 10);
  for (let i = 1; i < r.picks.length; i++) assert.ok(r.picks[i - 1].score <= r.picks[i].score);
  // asking for fewer than are kept: a quantile subset of the kept ones, or all of them with keepAll
  const few = pickStable(cands, { count: 2, isKept });
  assert.deepEqual(few.picks.map(p => p.name), ['p3', 'p97']);
  assert.deepEqual(pickStable(cands, { count: 2, isKept, keepAll: true }).picks.map(p => p.name), ['p3', 'p50', 'p97']);
  // nothing kept: identical to pickQuantiles
  assert.deepEqual(pickStable(cands, { count: 7 }).picks, pickQuantiles(cands, { count: 7 }).picks);
  // a shortfall is reported
  assert.equal(pickStable(pool([1, 2, 3]), { count: 5, isKept: () => false }).short, 2);
  // growing a book never drops a published puzzle: picks for a bigger count still contain every kept puzzle
  const grown = pickStable(cands, { count: 40, isKept });
  for (const name of kept) assert.ok(grown.picks.some(p => p.name === name));
});

test('weightedAllocation: shares follow the weights, capacities redistribute, zero weight gets nothing', () => {
  const sum = a => a.reduce((x, y) => x + y, 0);
  // proportional when nothing is capped
  assert.deepEqual(weightedAllocation(100, [999, 999, 999], [1, 1, 0.5]), [40, 40, 20]);
  assert.deepEqual(weightedAllocation(30, [999, 999], [2, 1]), [20, 10]);
  // a capped cell gives up its share; the rest keep their proportions
  const capped = weightedAllocation(100, [10, 999, 999], [1, 1, 0.5]);
  assert.equal(capped[0], 10);
  assert.equal(sum(capped), 100);
  assert.ok(Math.abs(capped[1] / capped[2] - 2) < 0.1, `rest stay 2:1, got ${capped}`);
  // zero weight: excluded entirely
  assert.deepEqual(weightedAllocation(10, [99, 99], [1, 0]), [10, 0]);
  // fewer slots than cells go to the heaviest first
  assert.deepEqual(weightedAllocation(1, [5, 5, 5], [0.5, 1, 0.5]), [0, 1, 0]);
  // totals: min(count, capacity of weighted cells), never above a cap
  for (const [n, caps, w] of [[7, [1, 2, 50], [1, 0.3, 1]], [101, [10, 20, 30, 40], [1, 0.25, 1, 0.5]], [13, [0, 5, 0, 9], [1, 1, 1, 1]]]) {
    const a = weightedAllocation(n, caps, w);
    assert.equal(sum(a), Math.min(n, sum(caps)));
    a.forEach((v, i) => assert.ok(v <= caps[i]));
  }
  // equal weights are exactly the even split (the old behaviour)
  for (const [n, caps] of [[30, [99, 99, 99]], [30, [4, 99, 99]], [10, [3, 3, 3]], [2, [5, 5, 5]], [101, [10, 20, 30, 40]]]) {
    assert.deepEqual(weightedAllocation(n, caps, caps.map(() => 1)), evenAllocation(n, caps));
  }
});

test('spreadOut: breaks up runs of one key, moves puzzles only a little, and is deterministic', () => {
  // sorted by score, but every key comes in a long block (like ties broken by name)
  const items = [];
  for (const k of 'abcdefghijklmnopqrst') for (let i = 0; i < 5; i++) items.push({ k, score: items.length });
  const out = spreadOut(items, { key: x => x.k });
  assert.equal(out.length, items.length);
  assert.deepEqual(out.map(x => x.score).sort((a, b) => a - b), items.map(x => x.score), 'same puzzles');
  let run = 1, maxRun = 1;
  for (let i = 1; i < out.length; i++) { run = out[i].k === out[i - 1].k ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
  assert.ok(maxRun <= 3, `longest run ${maxRun}`);
  out.forEach((x, i) => assert.ok(Math.abs(x.score - i) <= 3 * SPREAD_WINDOW, 'a puzzle stays near its sorted place'));
  assert.deepEqual(spreadOut(items, { key: x => x.k }), out);
  // a single key can't be spread: order is untouched
  assert.deepEqual(spreadOut(items, { key: () => 'x' }), items);
  assert.deepEqual(spreadOut([], {}), []);
});

test('spreadOut balance: a shape that is 40% of the list is not left for the end', () => {
  // by score the big shape is everywhere (two of every five puzzles, often side by side); the others come in blocks of ties
  const items = [];
  const others = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 120; i++) items.push({ k: i % 5 < 2 ? 'big' : others[Math.floor(i / 10) % 4], score: i });
  const runs = list => { let run = 1, max = 1; for (let i = 1; i < list.length; i++) { run = list[i].k === list[i - 1].k ? run + 1 : 1; max = Math.max(max, run); } return max; };
  const plain = spreadOut(items, { key: x => x.k, window: 80 });
  const out = spreadOut(items, { key: x => x.k, window: 80, balance: true });
  assert.equal(out.length, items.length);
  assert.deepEqual(out.map(x => x.score).sort((p, q) => p - q), items.map(x => x.score), 'same puzzles');
  assert.ok(runs(out) <= 2, `balanced: longest run ${runs(out)} (plain: ${runs(plain)})`);
  assert.deepEqual(spreadOut(items, { key: x => x.k, window: 80, balance: true }), out, 'deterministic');
});

test('spreadByTier keeps the tiers in order and continues from the keys before the first tier', () => {
  const mk = (tier, tile, score) => ({ tier, tile, score });
  const sorted = [mk('Beginner', 'a', 1), mk('Beginner', 'a', 2), mk('Beginner', 'b', 3), mk('Medium', 'b', 4), mk('Medium', 'b', 5), mk('Medium', 'c', 6)];
  const out = spreadByTier(sorted, { recent: ['a'] });
  assert.deepEqual(out.map(p => p.tier), sorted.map(p => p.tier));
  assert.equal(out[0].tile, 'b', 'avoids the shape the tour ended on');
  assert.notEqual(out[3].tile, out[2].tile, 'and across the tier boundary when it can');
});
