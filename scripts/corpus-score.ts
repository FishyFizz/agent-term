/** Scratch: score the corpus under several replay granularities. */
import { loadTraces, classifyTraceStreaming, scoreTrace, splitOnDrawOps } from '../test/helpers/corpus.js';

const fixed = (n: number) => (raw: string) => {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += n) out.push(raw.slice(i, i + n));
  return out;
};

const chunkers: Array<[string, ((raw: string) => string[]) | undefined]> = [
  ['drawOps', splitOnDrawOps],
  ['fixed64', fixed(64)],
  ['fixed256', fixed(256)],
  ['whole', (raw) => [raw]],
];

for (const [label, chunker] of chunkers) {
  let pass = 0;
  const fails: string[] = [];
  for (const t of loadTraces('direct')) {
    const segs = await classifyTraceStreaming(t, chunker);
    if (scoreTrace(t, segs).pass) pass++;
    else fails.push(t.id);
  }
  console.log(`${label.padEnd(9)} ${pass}/22  failing: ${fails.join(', ')}`);
}
