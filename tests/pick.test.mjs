// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickEven, hashString } from '../tools/lib/pick.mjs';

const pool = scores => scores.map((score, i) => ({ name: `p${i}`, score }));

test('picks are spread evenly over the score range, easiest first', () => {
  const cands = pool(Array.from({ length: 1000 }, (_, i) => i));        // scores 0..999
  const { picks, lo, hi, short } = pickEven(cands, { count: 10, low: 0, high: 1, seed: 1 });
  assert.equal(picks.length, 10);
  assert.equal(short, 0);
  assert.equal(new Set(picks.map(p => p.name)).size, 10, 'no puzzle picked twice');
  for (let i = 0; i < 10; i++) {
    const centre = lo + (i + 0.5) * (hi - lo) / 10;
    assert.ok(Math.abs(picks[i].score - centre) <= 1, `pick ${i}: ${picks[i].score} vs centre ${centre}`);
  }
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i - 1].score <= picks[i].score);
});

test('a skewed pool still gives distinct picks covering the range as well as it can', () => {
  // 95% of puzzles easy (0..99), a thin tail of hard ones
  const scores = [...Array.from({ length: 380 }, (_, i) => i % 100), ...Array.from({ length: 20 }, (_, i) => 200 + i * 40)];
  const { picks } = pickEven(pool(scores), { count: 30, low: 0, high: 1 });
  assert.equal(picks.length, 30);
  assert.equal(new Set(picks.map(p => p.name)).size, 30);
  assert.ok(picks[picks.length - 1].score >= 600, 'reaches into the hard tail');
  assert.ok(picks[0].score <= 25, 'starts at the easy end');
});

test('a pool smaller than the book returns everything and reports the shortfall', () => {
  const { picks, short } = pickEven(pool([5, 1, 3]), { count: 5 });
  assert.deepEqual(picks.map(p => p.score), [1, 3, 5]);
  assert.equal(short, 2);
  assert.deepEqual(pickEven([], { count: 3 }), { picks: [], lo: 0, hi: 0, short: 3 });
});

test('ties are broken deterministically by seed', () => {
  const cands = pool(Array.from({ length: 100 }, () => 7));              // every score equal
  const a = pickEven(cands, { count: 10, seed: 1 }).picks.map(p => p.name);
  const b = pickEven(cands, { count: 10, seed: 1 }).picks.map(p => p.name);
  const c = pickEven(cands, { count: 10, seed: 2 }).picks.map(p => p.name);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(new Set(a).size, 10);
  // shuffling the pool does not change the choice
  const shuffled = [...cands].reverse();
  assert.deepEqual(pickEven(shuffled, { count: 10, seed: 1 }).picks.map(p => p.name), a);
});

test('percentile bounds ignore outliers; an absolute range overrides them', () => {
  const cands = pool([...Array.from({ length: 98 }, (_, i) => i), 5000, 9000]);
  const trimmed = pickEven(cands, { count: 5, low: 0.02, high: 0.98 });
  assert.ok(trimmed.hi < 200, `outliers trimmed: hi=${trimmed.hi}`);
  const abs = pickEven(cands, { count: 5, range: [0, 50] });
  assert.equal(abs.lo, 0); assert.equal(abs.hi, 50);
  assert.ok(abs.picks.every(p => p.score <= 60));
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
