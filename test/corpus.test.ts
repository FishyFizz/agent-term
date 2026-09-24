/**
 * The classifier measured against the corpus.
 *
 * This is the regression suite L0.1 was supposed to have before the classifier
 * existed (CLASSIFIER.md §10). It does not assert a perfect score: it asserts
 * the current score, so a regression fails loudly and an improvement has to be
 * recorded deliberately.
 *
 * Replay granularity is the honest problem here. A classifier call sees a
 * *before* and an *after*, so what it can detect depends on where deliveries
 * begin. Under `splitOnDrawOps` -- one delivery per drawing op, i.e. best
 * case -- the score is high. Under fixed-size chunks, which is what a real pty
 * actually delivers, it is materially lower. Both numbers are pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTraces, classifyTraceStreaming, scoreTrace, fixedChunks, jobChunks } from './helpers/corpus.js';
import type { Trace } from './helpers/corpus.js';

/**
 * The gap that closes a job when replaying at job granularity.
 *
 * Sits between the two things the corpus's pacing produces: output within one
 * act is 6ms apart, one act to the next is 80-120ms. Anything from about 20
 * to 70 separates them, and the measured score is identical across that range.
 */
const JOB_GAP_MS = 50;

/** Scores are pinned so a change is visible; raise them when the classifier improves. */
const EXPECTED = {
  /** One delivery per drawing op: the classifier's best case. */
  drawOps: 21,
  /** Fixed 64-byte chunks, closer to what a pty delivers. */
  pty64: 15,
  /**
   * Deliveries grouped at the boundaries the programme drew.
   *
   * Level with `drawOps`, and that took two changes rather than tuning.
   * A job boundary at every alt-screen switch, so a repaint is not merged
   * with the exit that destroys it -- worth +2, but only once `classify`
   * stopped reporting the home-cursor `CUP` that follows entering a
   * full-screen program as a repaint of its own; before that the switch and
   * the home disagreed over the same bytes and the boundary cost more than
   * it recovered.
   *
   * The two that remain are not granularity problems: one the screen cannot
   * settle at any window (a blank row gaining text is an append by every
   * structural test), and one where a resize reflows existing content and the
   * next job's diff inherits the change.
   */
  jobs: 21,
};

async function run(
  chunker?: (raw: string) => string[],
): Promise<{ pass: number; total: number; fails: string[] }> {
  const traces = loadTraces('direct');
  let pass = 0;
  const fails: string[] = [];
  for (const trace of traces) {
    const segments = await classifyTraceStreaming(trace, chunker);
    if (scoreTrace(trace, segments).pass) pass++;
    else fails.push(trace.id);
  }
  return { pass, total: traces.length, fails };
}

test('corpus is present and well-formed', () => {
  const traces = loadTraces('direct');
  assert.ok(traces.length >= 23, `expected the full corpus, got ${traces.length}`);
  for (const t of traces as Trace[]) {
    assert.ok(t.expectations.length > 0, `${t.id} has expectations`);
    assert.ok(t.raw.length > 0, `${t.id} has raw bytes`);
    for (const e of t.expectations) {
      assert.ok(e.to > e.from, `${t.id} expectation range is well-formed`);
      assert.ok(e.why.length > 0, `${t.id} expectation says why it exists`);
    }
  }
});

/**
 * Score at job granularity, which needs the trace and not just its bytes.
 *
 * The boundary comes from when each delivery arrived, which `raw` does not
 * carry; see `jobChunks`.
 */
async function runJobs(gapMs: number): Promise<{ pass: number; total: number; fails: string[] }> {
  const traces = loadTraces('direct');
  let pass = 0;
  const fails: string[] = [];
  for (const trace of traces) {
    const segments = await classifyTraceStreaming(trace, () => jobChunks(trace, gapMs));
    if (scoreTrace(trace, segments).pass) pass++;
    else fails.push(trace.id);
  }
  return { pass, total: traces.length, fails };
}

test('classifier scores at least the pinned rate under op-aligned replay', async () => {
  const { pass, total, fails } = await run();
  assert.ok(
    pass >= EXPECTED.drawOps,
    `expected >= ${EXPECTED.drawOps}/${total}, got ${pass}/${total}. Failing: ${fails.join(', ')}`,
  );
});

test('classifier scores at least the pinned rate under pty-like replay', async () => {
  const { pass, total, fails } = await run(fixedChunks(64));
  assert.ok(
    pass >= EXPECTED.pty64,
    `expected >= ${EXPECTED.pty64}/${total} under 64-byte chunks, got ${pass}/${total}. ` +
      `Failing: ${fails.join(', ')}`,
  );
});

test('op-aligned replay beats pty-like replay, or the gap is a real finding', async () => {
  // Not a requirement -- a measurement. If delivery granularity stops mattering
  // the two should converge, and this test tells us when that happens.
  const best = await run();
  const realistic = await run(fixedChunks(64));
  console.log(
    `      corpus: ${best.pass}/${best.total} op-aligned, ${realistic.pass}/${realistic.total} at 64-byte chunks`,
  );
  assert.ok(best.pass >= realistic.pass, 'finer deliveries should not be worse');
});

test('classifier scores at least the pinned rate under job-aligned replay', async () => {
  const { pass, total, fails } = await runJobs(JOB_GAP_MS);
  console.log(`      corpus: ${pass}/${total} at job granularity (${JOB_GAP_MS}ms gap)`);
  assert.ok(
    pass >= EXPECTED.jobs,
    `expected >= ${EXPECTED.jobs}/${total} at job granularity, got ${pass}/${total}. ` +
      `Failing: ${fails.join(', ')}`,
  );
});
