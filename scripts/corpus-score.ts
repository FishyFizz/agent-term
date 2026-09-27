/**
 * Score the classifier against the corpus at several replay granularities.
 *
 * The pinned scores live in test/corpus.test.ts; this prints the ones that
 * are not pinned, so the cost of delivery granularity is visible rather than
 * implied. Run it after touching the classifier:
 *
 *   npx tsx scripts/corpus-score.ts
 *
 * `drawOps` is the classifier's best case — one delivery per drawing op, so
 * every op is visible when it fires. The fixed-size chunkers are what a real
 * pty delivers. The gap between them is the open item in CLASSIFIER.md §9:
 * coalescing is a classification input, not merely a delivery policy.
 */
import {
  loadTraces,
  classifyTraceStreaming,
  scoreTrace,
  splitOnDrawOps,
  fixedChunks,
  groupChunks,
} from '../test/helpers/corpus.js';

const GROUP_GAP_MS = 50;

const chunkers: Array<[string, (trace: Parameters<typeof groupChunks>[0]) => string[]]> = [
  ['drawOps', (trace) => splitOnDrawOps(trace.raw)],
  ['groups50', (trace) => groupChunks(trace, GROUP_GAP_MS)],
  ['fixed64', (trace) => fixedChunks(64)(trace.raw)],
  ['fixed256', (trace) => fixedChunks(256)(trace.raw)],
  ['whole', (trace) => [trace.raw]],
];

const traces = loadTraces('direct');

for (const [label, chunker] of chunkers) {
  const fails: string[] = [];
  for (const trace of traces) {
    // Every splitter is given the trace, not just its bytes: the group one needs
    // the arrival times, which `raw` does not carry.
    const segments = await classifyTraceStreaming(trace, () => chunker(trace));
    if (!scoreTrace(trace, segments).pass) fails.push(trace.id);
  }
  const pass = traces.length - fails.length;
  console.log(`${label.padEnd(9)} ${pass}/${traces.length}  failing: ${fails.join(', ')}`);
}
