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
import { loadTraces, classifyTraceStreaming, scoreTrace, splitOnDrawOps } from '../test/helpers/corpus.js';

const fixed =
  (n: number) =>
  (raw: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < raw.length; i += n) out.push(raw.slice(i, i + n));
    return out;
  };

const chunkers: Array<[string, (raw: string) => string[]]> = [
  ['drawOps', splitOnDrawOps],
  ['fixed64', fixed(64)],
  ['fixed256', fixed(256)],
  ['whole', (raw) => [raw]],
];

const traces = loadTraces('direct');

for (const [label, chunker] of chunkers) {
  const fails: string[] = [];
  for (const trace of traces) {
    const segments = await classifyTraceStreaming(trace, chunker);
    if (!scoreTrace(trace, segments).pass) fails.push(trace.id);
  }
  const pass = traces.length - fails.length;
  console.log(`${label.padEnd(9)} ${pass}/${traces.length}  failing: ${fails.join(', ')}`);
}
