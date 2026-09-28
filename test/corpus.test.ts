/**
 * The classifier measured against the corpus.
 *
 * This is the regression suite the classification contract was supposed to have before the classifier
 * existed. It does not assert a perfect score: it asserts
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
import { loadTraces, classifyTraceStreaming, scoreTrace, fixedChunks, groupChunks } from './helpers/corpus.js';
import type { Trace } from './helpers/corpus.js';

/**
 * The gap that closes a group when replaying at group granularity.
 *
 * Sits between the two things the corpus's pacing produces: output within one
 * act is 6ms apart, one act to the next is 80-120ms. Anything from about 20
 * to 70 separates them, and the measured score is identical across that range.
 */
const GROUP_GAP_MS = 50;

/**
 * Scores are printed so a change is visible. They are measurements of a
 * label set, not a specification: a programme's `why` records what is
 * interesting about it, and the verdict beside it is a claim about the screen
 * that a reader is free to dispute. Raising one is not automatically progress.
 */
const EXPECTED = {
  /**
   * One delivery per drawing op. Not a real delivery mode: it is a synthetic
   * splitter that exposes every op, so it resolves repaints that a real
   * coalescing window collapses. Useful as a ceiling, and its failures are
   * mostly granularity artifacts rather than defects.
   */
  drawOps: 20,
  /** Fixed 64-byte chunks, closer to what a pty delivers. */
  pty64: 17,
  /**
   * Deliveries grouped at the boundaries the programme drew -- the mode the
   * server actually delivers in, so this is the number to watch.
   *
   * Every programme passes here now. Three expectations were deleted to get
   * there, not adjusted -- `progress-bar-scroll`, `interleaved`, and
   * `progress-bar` -- each asserting a single verdict over a span the screen
   * shows two kinds on. Raising this number further is not possible without
   * either inventing expectations or making the classifier guess, and the rule
   * is not to do either.
   */
  groups: 23,
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
 * Score at group granularity, which needs the trace and not just its bytes.
 *
 * The boundary comes from when each delivery arrived, which `raw` does not
 * carry; see `groupChunks`.
 */
async function runGroups(gapMs: number): Promise<{ pass: number; total: number; fails: string[] }> {
  const traces = loadTraces('direct');
  let pass = 0;
  const fails: string[] = [];
  for (const trace of traces) {
    const segments = await classifyTraceStreaming(trace, () => groupChunks(trace, gapMs));
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

test('classifier scores at least the pinned rate under group-aligned replay', async () => {
  const { pass, total, fails } = await runGroups(GROUP_GAP_MS);
  console.log(`      corpus: ${pass}/${total} at group granularity (${GROUP_GAP_MS}ms gap)`);
  assert.ok(
    pass >= EXPECTED.groups,
    `expected >= ${EXPECTED.groups}/${total} at group granularity, got ${pass}/${total}. ` +
      `Failing: ${fails.join(', ')}`,
  );
});
