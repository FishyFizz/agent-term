/**
 * Measure the classifier against the corpus.
 *
 * The corpus (`corpus/`, in-tree) is the regression suite for L0.1: 22
 * programmes, 44 recorded traces, each with expected verdicts over byte
 * ranges. This replays each trace's `raw` bytes through the real screen model
 * and classifier and scores the result.
 *
 * Only `direct` traces are scored. On a pty feed ConPTY rewrites escape
 * sequences (corpus/OPS.md), so the same programme's expectations do not hold;
 * those traces say whether reality diverges, not whether the logic is right.
 *
 * The `Trace` shape is the corpus's own (corpus/src/types.ts): the corpus owns
 * the format it records, and this harness reads it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScreenModel } from '../../src/screen.js';
import { classify, coalesce, frameOf } from '../../src/classify.js';
import type { Trace } from '../../corpus/src/types.js';
import type { Segment } from '../../src/classify.js';

export type { Trace };

export const TRACE_DIR = join(process.cwd(), 'corpus', 'traces');

export function loadTraces(feed: 'direct' | 'pty' | 'both' = 'direct'): Trace[] {
  const out: Trace[] = [];
  for (const file of readdirSync(TRACE_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const trace = JSON.parse(readFileSync(join(TRACE_DIR, file), 'utf8')) as Trace;
    if (feed !== 'both' && trace.feed !== feed) continue;
    out.push(trace);
  }
  return out;
}

/**
 * Replay a trace as a stream of deliveries and classify every delivery.
 *
 * A classifier call sees a *before* and an *after*, so an overwrite is only
 * visible if the content being overwritten was already on screen when some
 * delivery began. Replaying a whole trace as one delivery starts from an empty
 * screen, so nothing is ever overwritten and every repaint looks like a first
 * paint -- including the bare `
` overwrite in CLASSIFIER.md §9.2, which
 * emits no control op at all.
 *
 * Chunks, not single bytes: at one byte per delivery the `
` and the text
 * after it land in different deliveries, so the CR alone looks like a
 * one-character append and the verdict flips on a replay artifact. Splitting
 * after control characters keeps a `
` with the text that follows it, which
 * is the unit a program actually emits.
 */
export async function classifyTraceStreaming(
  trace: Trace,
  chunker: (raw: string) => string[] = splitOnDrawOps,
): Promise<Segment[]> {
  const screen = new ScreenModel(trace.cols, trace.rows);
  const segments: Segment[] = [];
  let prevTo = 0;

  for (const chunk of chunker(trace.raw)) {
    const before = frameOf(screen);
    await screen.feed(chunk);
    const ops = [...screen.ops.recorded];
    const toByte = screen.ops.bytesFed;
    screen.ops.clear();
    const after = frameOf(screen);

    for (const seg of classify({ before, after, ops, fromByte: prevTo, toByte }).segments) {
      segments.push(seg);
    }
    prevTo = toByte;
  }
  return merge(segments);
}

/**
 * Split into deliveries: one per drawing op, plus the text that follows it.
 *
 * A program writes a repaint as `CUP` + erase + text, and that group is one
 * unit of intent. Splitting inside it lets the trailing text arrive as its own
 * delivery with no op, which then reads as an append; splitting *before* each
 * drawing op keeps the op and the text it governs together.
 *
 * An escape sequence itself is never split: a chunk ending mid-sequence leaves
 * the parser with an incomplete escape, and no op is recorded at all.
 */
export function splitOnDrawOps(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  let inEscape = false;
  // Set once `current` holds a drawing op, so the next op starts a new chunk.
  let sawDrawOp = false;
  const DRAW_FINALS = 'HfKJLM@ABCD';

  while (i < raw.length) {
    const ch = raw[i]!;
    const code = ch.codePointAt(0)!;
    current += ch;
    i++;

    if (inEscape) {
      const isFinal = code >= 0x40 && code <= 0x7e;
      if (isFinal) {
        inEscape = false;
        if (DRAW_FINALS.includes(ch)) sawDrawOp = true;
      }
      continue;
    }

    if (code === 0x1b) {
      const next = raw[i];
      if (next === '[' || next === ']' || next === 'P' || next === '7' || next === '8') {
        // Flush pending text before the escape. An erase op that follows
        // text belongs to the *next* redraw, and leaving it at the tail of
        // this delivery produces a zero-width op segment that carries no
        // information.
        if (current.length > 1) {
          out.push(current.slice(0, -1));
          current = '\x1b';
        }
        sawDrawOp = false;
        inEscape = true;
      }
      continue;
    }

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // A CR starts a delivery, not ends one -- see above.
      if (code === 0x0d) {
        if (current.length > 1) {
          out.push(current.slice(0, -1));
          current = String.fromCharCode(0x0d);
        }
        continue;
      }

      // Mid-repaint, each redrawn row is its own delivery. A selector emits
      // `CUP` + erase + line repeatedly; keeping the whole burst as one
      // delivery means only its first op is visible and the rest of the lines
      // read as appends. `\x1b[2K` before each row is the marker.
      if (sawDrawOp) {
        out.push(current);
        current = '';
        sawDrawOp = false;
        continue;
      }

      out.push(current);
      current = '';
      continue;
    }
  }
  if (current) out.push(current);
  return out.filter((c) => c.length > 0);
}

/**
 * Join the segments produced across a trace's deliveries.
 *
 * A replay classifies one batch per delivery, so the batches need joining
 * before they can be scored against expectations that span several of them.
 *
 * Two rules on top of the classifier's own coalescing, both about replay
 * artifacts rather than about meaning:
 *
 *  - a zero-width segment is dropped. A control byte delivered on its own
 *    produces one, and merging it in flips the verdict of the run around it.
 *  - op-less text immediately following a drawing segment is part of that
 *    repaint. A repaint is `CUP` + erase + text, and the text carries no op
 *    of its own, so it reads as an append.
 *
 * The second is bounded by adjacency, so a later append after a pause is its
 * own segment: a selector draws its list and then stops.
 */
function merge(segments: readonly Segment[]): Segment[] {
  // Zero-width segments first: a control byte delivered on its own produces
  // one, and merging one in flips the verdict of the run around it on a
  // delivery artifact.
  const kept = segments.filter((s) => s.toByte > s.fromByte);

  // Repaint absorption runs *before* coalescing, and that order is load
  // bearing: absorbing afterwards lets coalesce() join the op segment to the
  // op-less one first, and the op-less text then lands under the op segment
  // instead of extending the repaint. Measured on the corpus: the other
  // order loses `complex.resize-during-tui` (19/22 vs 20/22).
  const absorbed: Segment[] = [];
  for (const seg of kept) {
    const prev = absorbed[absorbed.length - 1];
    const continuesRepaint =
      prev?.kind === 'drawing' &&
      seg.evidence.ops.length === 0 &&
      // Adjacency: the text must start exactly where the drawing segment
      // ended, so a later append after a pause is its own segment.
      seg.fromByte === prev.toByte &&
      // One CRLF-sized step, not a run of new lines.
      seg.toByte - seg.fromByte <= 2;

    if (continuesRepaint) {
      prev.toByte = Math.max(prev.toByte, seg.toByte);
      continue;
    }
    absorbed.push({ ...seg, evidence: { ...seg.evidence, ops: [...seg.evidence.ops] } });
  }

  return coalesce(absorbed);
}

/**
 * Score segments against expectations.
 *
 * Expectations are byte ranges from the programme's own `mark()` points, while
 * an op's offset is wherever the byte counter stood when the handler ran --
 * and the recorder feeds in chunks, so several ops in one chunk share an
 * offset. The two coordinate systems are close but not identical, so scoring
 * is by **coverage**: does the expected verdict hold across the expectation's
 * span?
 *
 * An expectation passes when the segments covering its span are unanimously of
 * the expected kind. A span straddling a boundary -- writing then drawing --
 * is a segmentation disagreement, not a verdict error, and the corpus is not
 * asking about boundaries here.
 */
export interface CaseResult {
  id: string;
  category: string;
  summary: string;
  pass: boolean;
  expectations: {
    from: number;
    to: number;
    expected: 'writing' | 'drawing';
    got: string[];
    pass: boolean;
    why: string;
  }[];
}

/**
 * Cases where the corpus disagrees with CLASSIFIER.md, or with itself.
 *
 * Listed rather than silently resolved: a corpus that is wrong about one case
 * is still a corpus, but a harness that quietly picks a side makes the
 * disagreement invisible. Each entry says which authority wins and why.
 */
export const CONFLICTS: Record<string, { ruling: 'writing' | 'drawing'; reason: string }> = {
  // Same structure as `basic.alt-screen-write` -- enter alt, home, four
  // sequential lines -- but the two expect opposite verdicts. CLASSIFIER.md
  // §3.4 rules this case directly, with a verified trace: writing on the alt
  // screen is observationally identical to writing on the normal screen, so
  // the alt screen cannot be a verdict. §3.4 wins; this expectation is wrong.
  'complex.unclean-tui-exit': {
    ruling: 'writing',
    reason:
      'CLASSIFIER.md §3.4: alt screen is a prior and a capture-urgency flag, never a verdict. Identical in structure to basic.alt-screen-write, which expects writing.',
  },
};

export function scoreTrace(trace: Trace, segments: Segment[]): CaseResult {
  const conflict = CONFLICTS[trace.id];
  const results = trace.expectations.map((exp) => {
    const expected = conflict?.ruling ?? exp.kind;
    const overlapping = segments.filter((s) => s.fromByte < exp.to && s.toByte > exp.from);
    const kinds = [...new Set(overlapping.map((s) => s.kind))];

    // Dominant verdict across the span, weighted by how much of it each
    // segment covers.
    let expectedBytes = 0;
    let otherBytes = 0;
    for (const s of overlapping) {
      const lo = Math.max(s.fromByte, exp.from);
      const hi = Math.min(s.toByte, exp.to);
      const covered = Math.max(0, hi - lo);
      if (s.kind === expected) expectedBytes += covered;
      else otherBytes += covered;
    }

    const pass = exp.ambiguous
      ? overlapping.every((s) => s.confidence === 'low' || s.kind === exp.kind)
      : overlapping.length > 0 && expectedBytes > otherBytes;

    return {
      from: exp.from,
      to: exp.to,
      expected,
      got: kinds,
      pass,
      why: exp.why,
    };
  });
  return {
    id: trace.id,
    category: trace.category,
    summary: trace.summary,
    pass: results.every((r) => r.pass),
    expectations: results,
  };
}
