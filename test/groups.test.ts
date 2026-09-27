/**
 * Job boundaries — the unit of program intent the classifier is asked about.
 *
 * These test the grouping rule and the live detector. Nothing here needs a
 * pty: the clock is injected, so a quiet period is *advanced* rather than
 * slept through. A boundary that only sometimes opens is the worst thing this
 * could get wrong, and a test that races a real timer cannot tell the
 * difference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByGap, GroupDetector, FakeClock, type Arrival, type Job } from '../src/groups.js';
import type { GroupPolicy } from '../src/types.js';

const POLICY: GroupPolicy = { gapMs: 20 };

function arrivals(spec: Array<[string, number]>): Arrival[] {
  return spec.map(([text, at]) => ({ bytes: Buffer.from(text, 'utf8'), at }));
}

function texts(groups: Job[]): string[] {
  return groups.map((j) => j.bytes.toString('utf8'));
}

test('groupByGap merges arrivals closer together than the gap', () => {
  const groups = groupByGap(arrivals([['a', 0], ['b', 5], ['c', 10]]), POLICY);
  assert.equal(groups.length, 1);
  assert.equal(texts(groups)[0], 'abc');
  assert.equal(groups[0]!.chunks, 3);
});

test('groupByGap splits where the pty went quiet', () => {
  // a -> b is 20ms (a boundary); b -> c is 5ms, so they are one group.
  const groups = groupByGap(arrivals([['a', 0], ['b', 20], ['c', 25]]), POLICY);
  assert.deepEqual(texts(groups), ['a', 'bc']);
  // The tail is closed by the arrivals running out, not by silence.
  assert.deepEqual(groups.map((j) => j.reason), ['gap', 'flush']);
});

test('a gap exactly at the policy closes the group', () => {
  // Half-open comparison would make the boundary depend on a millisecond of
  // luck. `>=` is the rule, and this pins it.
  const groups = groupByGap(arrivals([['a', 0], ['b', 20]]), POLICY);
  assert.equal(groups.length, 2);
});

test('groupByGap reports the span each group covers', () => {
  const groups = groupByGap(arrivals([['a', 1000], ['b', 1005], ['c', 2000]]), POLICY);
  assert.deepEqual(groups.map((j) => [j.startedAt, j.closedAt]), [[1000, 1005], [2000, 2000]]);
});

test('a byte cap closes a group that never goes quiet', () => {
  const groups = groupByGap(arrivals([['12345', 0], ['67890', 1], ['abcde', 2]]), {
    gapMs: 20,
    maxBytes: 10,
  });
  assert.deepEqual(texts(groups), ['1234567890', 'abcde']);
  assert.equal(groups[0]!.reason, 'bytes');
});

test('one delivery larger than the cap is not split', () => {
  // Splitting a delivery would invent a boundary the program never drew --
  // the same sin as a 64-byte chunk landing mid-escape.
  const groups = groupByGap(arrivals([['aaaaaaaaaa', 0]]), { gapMs: 20, maxBytes: 4 });
  assert.deepEqual(texts(groups), ['aaaaaaaaaa']);
  assert.equal(groups[0]!.chunks, 1);
});

test('a delivery cap closes a group made of many small arrivals', () => {
  const groups = groupByGap(arrivals([['a', 0], ['b', 1], ['c', 2], ['d', 3]]), {
    gapMs: 20,
    maxChunks: 2,
  });
  assert.deepEqual(texts(groups), ['ab', 'cd']);
  assert.deepEqual(groups.map((j) => j.reason), ['chunks', 'chunks']);
});

test('no arrivals means no groups', () => {
  assert.deepEqual(groupByGap([], POLICY), []);
});

// --- the live detector ----------------------------------------------------

function detector(policy: GroupPolicy = POLICY): { groups: Job[]; push: (s: string) => void; clock: FakeClock; d: GroupDetector } {
  const clock = new FakeClock();
  const groups: Job[] = [];
  const d = new GroupDetector(policy, (j) => groups.push(j), clock);
  return { groups, clock, d, push: (s: string) => d.push(Buffer.from(s, 'utf8')) };
}

test('the detector holds a group open until the pty goes quiet', () => {
  const { groups, clock, push } = detector();
  push('a');
  push('b');
  assert.equal(groups.length, 0, 'not emitted while output is still arriving');
  clock.advance(19);
  assert.equal(groups.length, 0);
  clock.advance(1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.bytes.toString('utf8'), 'ab');
  assert.equal(groups[0]!.chunks, 2);
  assert.equal(groups[0]!.reason, 'gap');
});

test('the timer measures the gap since the last byte, not since the group opened', () => {
  // Otherwise a slow but continuous program is chopped at arbitrary intervals,
  // which is the chunk-boundary problem again with extra steps.
  const { groups, clock, push } = detector();
  for (let i = 0; i < 5; i++) {
    push(String(i));
    clock.advance(15);
  }
  assert.equal(groups.length, 0, '15ms apart with a 20ms gap is one group');
  clock.advance(5);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.chunks, 5);
});

test('a cap closes the group without waiting for silence', () => {
  const { groups, clock, push } = detector({ gapMs: 20, maxBytes: 4 });
  push('ab');
  push('cd');
  push('ef');
  assert.equal(groups.length, 1, 'closed on the cap, the timer never fired');
  assert.equal(groups[0]!.reason, 'bytes');
  clock.advance(100);
  assert.equal(groups.length, 2);
  assert.equal(groups[1]!.bytes.toString('utf8'), 'ef');
});

test('flush closes a pending group immediately', () => {
  const { groups, push, d } = detector();
  push('a');
  d.flush();
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.reason, 'flush');
});

test('flush with nothing pending emits nothing', () => {
  const { groups, d } = detector();
  d.flush();
  assert.equal(groups.length, 0);
});

test('dispose flushes what arrived and then stops accepting', () => {
  // Those bytes arrived; dropping them would leave the classifier's byte
  // offsets short of what the pty actually produced.
  const { groups, push, d } = detector();
  push('a');
  d.dispose();
  push('b');
  assert.deepEqual(texts(groups), ['a']);
});

test('a pending group is visible before it closes', () => {
  const { push, d } = detector();
  assert.equal(d.pendingChunks, 0);
  push('abc');
  assert.equal(d.pendingChunks, 1);
  assert.equal(d.pendingBytes, 3);
  d.flush();
  assert.equal(d.pendingChunks, 0);
});
