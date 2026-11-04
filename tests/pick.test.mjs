// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickQuantiles, hashString } from '../tools/lib/pick.mjs';

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

test('hashString is stable', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});

import { evenAllocation } from '../tools/lib/pick.mjs';

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
