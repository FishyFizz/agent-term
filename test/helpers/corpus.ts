/**
 * Measure the classifier against the corpus.
 *
 * The corpus (`corpus/`, in-tree) is the regression suite for L0.1: 23
 * programmes, 46 recorded traces, each with expected verdicts over byte
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
import { groupByGap } from '../../src/jobs.js';
import { OP } from '../../src/edit-record.js';
import type { Trace } from '../../corpus/src/types.js';
import type { Segment, Verdict } from '../../src/classify.js';

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
 * paint -- including the bare `\r` overwrite in CLASSIFIER.md §9.2, which
 * emits no control op at all.
 *
 * Chunks, not single bytes: at one byte per delivery the `\r` and the text
 * after it land in different deliveries, so the CR alone looks like a
 * one-character append and the verdict flips on a replay artifact. Splitting
 * after control characters keeps a `\r` with the text that follows it, which
 * is the unit a program actually emits.
 */
export async function classifyTraceStreaming(
  trace: Trace,
  chunker: (raw: string) => string[] = splitOnDrawOps,
): Promise<Segment[]> {
  const screen = new ScreenModel(trace.cols, trace.rows);
  const segments: Segment[] = [];
  // A trace has to be replayed at the size the programme was running at, or the
  // replay describes a terminal that never existed -- and the frames, the ops
  // and the verdicts all describe that terminal. Resizes take effect before the
  // chunk that reaches their offset, the same way the recorder applied them.
  const resizes = [...trace.resizes].sort((a, b) => a.offset - b.offset);
  let nextResize = 0;
  let prevTo = 0;

  for (const chunk of chunker(trace.raw)) {
    const chunkEnd = prevTo + Buffer.byteLength(chunk, 'utf8');
    while (nextResize < resizes.length && resizes[nextResize]!.offset <= chunkEnd) {
      const r = resizes[nextResize]!;
      screen.resize(r.cols, r.rows);
      nextResize++;
    }

    const before = frameOf(screen);
    await screen.feed(chunk);
    const ops = [...screen.ops.recorded];
    const toByte = screen.ops.bytesFed;
    screen.ops.clear();
    const after = frameOf(screen);

    for (const seg of classify({ before, after, fromByte: prevTo, toByte, scrolledBy: screen.takeScrolledRows() }).segments) {
      segments.push(seg);
    }
    prevTo = toByte;
  }
  return merge(segments);
}

/**
 * Split into deliveries of a fixed size, whatever their content.
 *
 * The other end of the scale from `splitOnDrawOps`: no knowledge of the stream
 * at all, which is closer to what a real pty delivers -- a chunk boundary lands
 * wherever the buffer filled. Scoring against it is what makes the cost of
 * delivery granularity visible rather than implied (CLASSIFIER.md §9.3).
 */
export function fixedChunks(size: number): (raw: string) => string[] {
  return (raw) => {
    const out: string[] = [];
    for (let i = 0; i < raw.length; i += size) out.push(raw.slice(i, i + size));
    return out;
  };
}

/**
 * Split a trace into deliveries at the boundaries the *programme* drew.
 *
 * The other splitters cut the byte stream by structure (`splitOnDrawOps`) or
 * by an arbitrary size (`fixedChunks`). This one cuts it by time, using the
 * arrivals the recorder stamped when the bytes came in — so a replay can be
 * grouped the way the programme produced it rather than the way a buffer
 * filled. That gap is the whole of CLASSIFIER.md §9.3: same corpus, same
 * classifier, different answer.
 *
 * Traces are ASCII, so an arrival's byte offset indexes `raw` directly.
 */
export function jobChunks(trace: Trace, gapMs: number): string[] {
  const arrivals = trace.arrivals;
  if (arrivals.length === 0) return [trace.raw];
  const endOf = (i: number): number => arrivals[i + 1]?.offset ?? trace.raw.length;

  // A job may not straddle a resize, for the same reason the live detector
  // flushes on one (`session.ts`) and for the same reason history splits
  // epochs there (HISTORY.md §2): inside one job the width is fixed, so a
  // row-run delta means one thing and a captured line's wrapping is
  // unambiguous. Across a resize neither is true, and a frame diff spanning
  // two grid sizes describes a terminal that never existed.
  const resizes = [...trace.resizes].sort((a, b) => a.offset - b.offset);
  let nextResize = 0;

  // An alt-screen switch is a boundary for the same reason, and a stronger
  // one: entering the alternate buffer replaces the whole visible grid, and
  // leaving it destroys what was on it (L0.1). A frame diff reaching across
  // that compares two different surfaces and reports the swap as a repaint of
  // everything.
  const switches = [...new Set(trace.ops.filter(OP.isAltScreenSwitch).map((o) => o.byteOffset))].sort(
    (a, b) => a - b,
  );
  let nextSwitch = 0;

  const out: string[] = [];
  let start = arrivals[0]!.offset;
  let lastAt = arrivals[0]!.at;

  for (let i = 0; i < arrivals.length; i++) {
    const a = arrivals[i]!;
    const end = endOf(i);
    while (nextResize < resizes.length && resizes[nextResize]!.offset < a.offset) nextResize++;
    while (nextSwitch < switches.length && switches[nextSwitch]! < a.offset) nextSwitch++;
    const crossesResize = nextResize < resizes.length && resizes[nextResize]!.offset < end;
    // `Op.byteOffset` is bytes fed *before* the op, so it names the end of the
    // delivery that carried it. `<=`, not `<`: a switch sitting exactly at
    // `end` is in this delivery, and missing it merges a repaint with the exit
    // that destroys what it painted -- the job's net diff is then "everything
    // vanished", which describes neither the repaint nor the exit.
    const crossesSwitch = nextSwitch < switches.length && switches[nextSwitch]! <= end;

    if (i > 0 && (a.at - lastAt >= gapMs || crossesResize || crossesSwitch)) {
      out.push(trace.raw.slice(start, a.offset));
      start = a.offset;
    }
    // The replay applies the resize before the delivery containing it, so that
    // delivery begins the next job and the whole job is at the new size.
    if (crossesResize) nextResize++;
    if (crossesSwitch) nextSwitch++;
    lastAt = a.at;
  }
  out.push(trace.raw.slice(start));
  return out.filter((c) => c.length > 0);
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
 * One rule on top of the classifier's own coalescing, and it is about a
 * replay artifact rather than about meaning: a zero-width segment is dropped.
 * A control byte delivered on its own produces one, and merging it in flips
 * the verdict of the run around it.
 *
 * A second rule used to live here -- op-less text following a drawing segment
 * was absorbed into that repaint -- and it went when the verdict stopped
 * reading ops. It existed to rejoin a `CUP` segment with the text it
 * governed, which is a distinction only the op stream made.
 */
function merge(segments: readonly Segment[]): Segment[] {
  // Zero-width segments first: a control byte delivered on its own produces
  // one, and merging one in flips the verdict of the run around it on a
  // delivery artifact.
  return coalesce(segments.filter((s) => s.toByte > s.fromByte));
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

    // A span declared mixed is not asked which verdict wins. It contains both
    // by construction, so a majority over its bytes would be decided by
    // weighting accidents -- two programmes' verdicts flip on nothing but how
    // much text happened to be in each segment. Presence is the assertion.
    const covers = (kind: Verdict): boolean =>
      overlapping.some(
        (s) =>
          s.kind === kind && Math.min(s.toByte, exp.to) > Math.max(s.fromByte, exp.from),
      );

    // No abstention branch: nothing reports doubt any more. An update that
    // collapsed many deliveries and changed little says so by its collapsed
    // count, which is the replacement for "I am not sure" (CLASSIFIER.md §3.5).
    const pass = exp.also
      ? covers(exp.kind) && covers(exp.also)
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
