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
import { groupByGap, JobDetector, FakeClock, type Arrival, type Job } from '../src/jobs.js';
import type { JobPolicy } from '../src/types.js';

const POLICY: JobPolicy = { gapMs: 20 };

function arrivals(spec: Array<[string, number]>): Arrival[] {
  return spec.map(([text, at]) => ({ bytes: Buffer.from(text, 'utf8'), at }));
}

function texts(jobs: Job[]): string[] {
  return jobs.map((j) => j.bytes.toString('utf8'));
}

test('groupByGap merges arrivals closer together than the gap', () => {
  const jobs = groupByGap(arrivals([['a', 0], ['b', 5], ['c', 10]]), POLICY);
  assert.equal(jobs.length, 1);
  assert.equal(texts(jobs)[0], 'abc');
  assert.equal(jobs[0]!.chunks, 3);
});

test('groupByGap splits where the pty went quiet', () => {
  // a -> b is 20ms (a boundary); b -> c is 5ms, so they are one job.
  const jobs = groupByGap(arrivals([['a', 0], ['b', 20], ['c', 25]]), POLICY);
  assert.deepEqual(texts(jobs), ['a', 'bc']);
  // The tail is closed by the arrivals running out, not by silence.
  assert.deepEqual(jobs.map((j) => j.reason), ['gap', 'flush']);
});

test('a gap exactly at the policy closes the job', () => {
  // Half-open comparison would make the boundary depend on a millisecond of
  // luck. `>=` is the rule, and this pins it.
  const jobs = groupByGap(arrivals([['a', 0], ['b', 20]]), POLICY);
  assert.equal(jobs.length, 2);
});

test('groupByGap reports the span each job covers', () => {
  const jobs = groupByGap(arrivals([['a', 1000], ['b', 1005], ['c', 2000]]), POLICY);
  assert.deepEqual(jobs.map((j) => [j.startedAt, j.closedAt]), [[1000, 1005], [2000, 2000]]);
});

test('a byte cap closes a job that never goes quiet', () => {
  const jobs = groupByGap(arrivals([['12345', 0], ['67890', 1], ['abcde', 2]]), {
    gapMs: 20,
    maxBytes: 10,
  });
  assert.deepEqual(texts(jobs), ['1234567890', 'abcde']);
  assert.equal(jobs[0]!.reason, 'bytes');
});

test('one delivery larger than the cap is not split', () => {
  // Splitting a delivery would invent a boundary the program never drew --
  // the same sin as a 64-byte chunk landing mid-escape.
  const jobs = groupByGap(arrivals([['aaaaaaaaaa', 0]]), { gapMs: 20, maxBytes: 4 });
  assert.deepEqual(texts(jobs), ['aaaaaaaaaa']);
  assert.equal(jobs[0]!.chunks, 1);
});

test('a delivery cap closes a job made of many small arrivals', () => {
  const jobs = groupByGap(arrivals([['a', 0], ['b', 1], ['c', 2], ['d', 3]]), {
    gapMs: 20,
    maxChunks: 2,
  });
  assert.deepEqual(texts(jobs), ['ab', 'cd']);
  assert.deepEqual(jobs.map((j) => j.reason), ['chunks', 'chunks']);
});

test('no arrivals means no jobs', () => {
  assert.deepEqual(groupByGap([], POLICY), []);
});

// --- the live detector ----------------------------------------------------

function detector(policy: JobPolicy = POLICY): { jobs: Job[]; push: (s: string) => void; clock: FakeClock; d: JobDetector } {
  const clock = new FakeClock();
  const jobs: Job[] = [];
  const d = new JobDetector(policy, (j) => jobs.push(j), clock);
  return { jobs, clock, d, push: (s: string) => d.push(Buffer.from(s, 'utf8')) };
}

test('the detector holds a job open until the pty goes quiet', () => {
  const { jobs, clock, push } = detector();
  push('a');
  push('b');
  assert.equal(jobs.length, 0, 'not emitted while output is still arriving');
  clock.advance(19);
  assert.equal(jobs.length, 0);
  clock.advance(1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.bytes.toString('utf8'), 'ab');
  assert.equal(jobs[0]!.chunks, 2);
  assert.equal(jobs[0]!.reason, 'gap');
});

test('the timer measures the gap since the last byte, not since the job opened', () => {
  // Otherwise a slow but continuous program is chopped at arbitrary intervals,
  // which is the chunk-boundary problem again with extra steps.
  const { jobs, clock, push } = detector();
  for (let i = 0; i < 5; i++) {
    push(String(i));
    clock.advance(15);
  }
  assert.equal(jobs.length, 0, '15ms apart with a 20ms gap is one job');
  clock.advance(5);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.chunks, 5);
});

test('a cap closes the job without waiting for silence', () => {
  const { jobs, clock, push } = detector({ gapMs: 20, maxBytes: 4 });
  push('ab');
  push('cd');
  push('ef');
  assert.equal(jobs.length, 1, 'closed on the cap, the timer never fired');
  assert.equal(jobs[0]!.reason, 'bytes');
  clock.advance(100);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1]!.bytes.toString('utf8'), 'ef');
});

test('flush closes a pending job immediately', () => {
  const { jobs, push, d } = detector();
  push('a');
  d.flush();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.reason, 'flush');
});

test('flush with nothing pending emits nothing', () => {
  const { jobs, d } = detector();
  d.flush();
  assert.equal(jobs.length, 0);
});

test('dispose flushes what arrived and then stops accepting', () => {
  // Those bytes arrived; dropping them would leave the classifier's byte
  // offsets short of what the pty actually produced.
  const { jobs, push, d } = detector();
  push('a');
  d.dispose();
  push('b');
  assert.deepEqual(texts(jobs), ['a']);
});

test('a pending job is visible before it closes', () => {
  const { push, d } = detector();
  assert.equal(d.pendingChunks, 0);
  push('abc');
  assert.equal(d.pendingChunks, 1);
  assert.equal(d.pendingBytes, 3);
  d.flush();
  assert.equal(d.pendingChunks, 0);
});
