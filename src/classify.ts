/**
 * Classification: per segment, `writing` or `drawing`.
 *
 * CLASSIFIER.md §2 — the unit is the **segment**, a run of activity bounded by
 * the program's own control operations. Not the update, and not a region of
 * the screen (§4 shows why a region cannot work). An update carries one or
 * more ordered segments; "mixed" is the structural fact that an update
 * contains more than one kind.
 *
 * §3.3 — the tests are **structural and threshold-free**: did it erase, did it
 * overwrite, did it reach back. Never "more than N% changed". A tuned
 * classifier needs tuning per program, and GOAL.md's success criteria are all
 * "without special-casing any program".
 */
import type { ScreenModel } from './screen.js';
import type { Op, OpName } from './edit-record.js';

export type Verdict = 'writing' | 'drawing';
export type Confidence = 'high' | 'low';

/** Why a verdict was reached. Attached to every segment (L0.1: a bug you can't see is a bug you can't fix). */
export interface Evidence {
  /** Ops that bounded or drove this segment. */
  ops: OpName[];
  /** The segment erased cells outside the scrolled region. */
  erased: boolean;
  /** The segment wrote onto cells that were non-blank. */
  overwrote: boolean;
  /** The segment changed rows above where the cursor was writing. */
  reachedBack: boolean;
  /** Rows scrolled during the segment, already factored out. */
  scrolledBy: number;
  /** The segment ran on the alternate buffer. A prior, not a verdict (§3.4). */
  altScreen: boolean;
}

export interface Segment {
  kind: Verdict;
  confidence: Confidence;
  /** Byte range this segment covers, half-open. */
  fromByte: number;
  toByte: number;
  evidence: Evidence;
}

export interface ClassifiedUpdate {
  segments: Segment[];
  /** Bytes consumed by this update. */
  fromByte: number;
  toByte: number;
}

/** Ops that mean "the program is redrawing", i.e. that end a writing run. */
const DRAWING_OPS: ReadonlySet<OpName> = new Set<OpName>([
  'CUP',
  'CUU',
  'CUD',
  'CUF',
  'CUB',
  'EL',
  'ED',
  'IL',
  'DL',
  'DCH',
  'ICH',
  'DECSC',
  'DECRC',
]);

/** Ops that are structural events: they change the screen's shape, not its content. */
const STRUCTURAL_OPS: ReadonlySet<OpName> = new Set<OpName>(['RIS', 'DECSET', 'DECRST']);

const OP = {
  isDrawing: (n: OpName) => DRAWING_OPS.has(n),
  isStructural: (n: OpName) => STRUCTURAL_OPS.has(n),
};

export { OP };

/**
 * A screen captured before and after a segment, used to answer structural
 * questions about what the segment did.
 */
interface Frame {
  lines: string[];
  cursorX: number;
  cursorY: number;
  viewportY: number;
  altScreen: boolean;
}

/**
 * Classify one update for a session.
 *
 * `before` is the screen as of `fromByte`; `screen` is the live model after
 * feeding the update. `ops` are the ops recorded during it.
 */
export function classify(params: {
  before: Frame;
  after: Frame;
  ops: readonly Op[];
  fromByte: number;
  toByte: number;
}): ClassifiedUpdate {
  const { before, after, ops, fromByte, toByte } = params;

  if (ops.length === 0) return appendOnly(before, after, fromByte, toByte);

  const raw: Segment[] = [];

  // A segment is the run of activity that *starts* at an op and runs until
  // the next one. Kind therefore comes from the op that opens it, not the one
  // that closes it: `text \n CUP EL text` is an append followed by a repaint,
  // and the CUP is what begins the repaint.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const start = i === 0 ? fromByte : ops[i - 1]!.byteOffset;
    const end = i === ops.length - 1 ? toByte : ops[i + 1]!.byteOffset;

    if (OP.isStructural(op.name)) {
      // Mode changes are not repaints. They are evidence on the segment they
      // open, and the segment's kind comes from what actually happened.
      raw.push(
        buildSegment({
          kind: 'writing',
          before,
          after,
          op,
          fromByte: start,
          toByte: end,
        }),
      );
      continue;
    }

    // Text before the first op, with no op opening it: an append.
    if (i === 0 && start < op.byteOffset) {
      raw.push(appendOnly(before, after, start, op.byteOffset).segments[0]!);
    }

    raw.push(
      buildSegment({
        kind: OP.isDrawing(op.name) ? 'drawing' : 'writing',
        before,
        after,
        op,
        fromByte: op.byteOffset,
        toByte: end,
      }),
    );
  }

  return { segments: coalesce(raw), fromByte, toByte };
}

/**
 * Merge consecutive segments of the same kind.
 *
 * A repaint is rarely one op: shells and TUIs emit `CUP` per line they draw,
 * so a single screen update arrives as a run of same-kind ops. Reporting one
 * segment per op is noise for the agent; the meaningful unit is the run.
 * Different kinds are never merged -- that boundary is the whole point.
 */
function coalesce(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === seg.kind) {
      prev.toByte = Math.max(prev.toByte, seg.toByte);
      if (!prev.evidence.ops.includes(seg.evidence.ops[0]!)) {
        prev.evidence.ops.push(...seg.evidence.ops);
      }
      prev.evidence.erased ||= seg.evidence.erased;
      prev.evidence.overwrote ||= seg.evidence.overwrote;
      prev.evidence.reachedBack ||= seg.evidence.reachedBack;
      prev.evidence.scrolledBy += seg.evidence.scrolledBy;
      if (seg.confidence === 'low') prev.confidence = 'low';
      continue;
    }
    // Clone: coalescing mutates the accumulated segment.
    out.push({
      kind: seg.kind,
      confidence: seg.confidence,
      fromByte: seg.fromByte,
      toByte: seg.toByte,
      evidence: { ...seg.evidence, ops: [...seg.evidence.ops] },
    });
  }
  return out;
}

function appendOnly(
  before: Frame,
  after: Frame,
  fromByte: number,
  toByte: number,
): ClassifiedUpdate {
  const scrolledBy = after.viewportY - before.viewportY;
  const { erased, overwrote, reachedBack } = diffFacts(before, after, scrolledBy);
  // No control ops at all: the only way this is drawing is if it overwrote
  // or reached back -- e.g. a bare \r overwrite, which emits no CSI.
  const isDrawing = erased || overwrote || reachedBack;
  return {
    segments: [
      {
        kind: isDrawing ? 'drawing' : 'writing',
        confidence: isDrawing ? 'high' : 'high',
        fromByte,
        toByte,
        evidence: { ops: [], erased, overwrote, reachedBack, scrolledBy, altScreen: after.altScreen },
      },
    ],
    fromByte,
    toByte,
  };
}

function buildSegment(params: {
  kind: Verdict;
  before: Frame;
  after: Frame;
  op: Op;
  fromByte: number;
  toByte: number;
}): Segment {
  const { kind, before, after, op, fromByte, toByte } = params;
  const scrolledBy = after.viewportY - before.viewportY;
  const { erased, overwrote, reachedBack } = diffFacts(before, after, scrolledBy);

  // Structural corroboration: an op said "drawing", so believe it unless the
  // screen says nothing changed at all.
  const agrees =
    kind === 'drawing' ? erased || overwrote || reachedBack || op.name === 'CUP' : !erased && !reachedBack;

  return {
    kind,
    confidence: agrees ? 'high' : 'low',
    fromByte,
    toByte,
    evidence: {
      ops: [op.name],
      erased,
      overwrote,
      reachedBack,
      scrolledBy,
      altScreen: op.altScreen,
    },
  };
}

/**
 * The structural questions, answered against the two frames.
 *
 * `scrolledBy` rows have already been factored out, so a scrolling build log
 * is not mistaken for a repaint.
 */
function diffFacts(
  before: Frame,
  after: Frame,
  scrolledBy: number,
): { erased: boolean; overwrote: boolean; reachedBack: boolean } {
  const rows = Math.min(before.lines.length, after.lines.length);
  let erased = false;
  let overwrote = false;
  let reachedBack = false;

  // Scrolling moves content up by `scrolledBy`, so the row now visible at y
  // was previously at y + scrolledBy. Mapping the other way round compares
  // two unrelated rows and reports every scrolling update as a repaint.
  //
  // The append point moves with it: where output was continuing in `before`
  // is `before.cursorY - scrolledBy` in `after` coordinates.
  const writeRow = before.cursorY - scrolledBy;

  for (let y = 0; y < rows; y++) {
    const prevIdx = y + scrolledBy;
    // A row with no counterpart in `before` is newly revealed content, i.e.
    // the bottom of a scroll -- appending, not reaching back.
    if (prevIdx < 0 || prevIdx >= before.lines.length) continue;

    const prevLine = before.lines[prevIdx] ?? '';
    const nextLine = after.lines[y] ?? '';
    if (prevLine === nextLine) continue;

    if (y < writeRow) reachedBack = true;

    // Erasure: cells that were non-blank became blank.
    if (blanked(prevLine, nextLine)) erased = true;

    // Overwrite: non-blank cells changed to different non-blank content.
    if (overwroteNonBlank(prevLine, nextLine)) overwrote = true;
  }

  return { erased, overwrote, reachedBack };
}

function blanked(prev: string, next: string): boolean {
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    if (prev[i] !== ' ' && next[i] === ' ') return true;
  }
  return false;
}

function overwroteNonBlank(prev: string, next: string): boolean {
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    if (prev[i] !== ' ' && next[i] !== ' ' && prev[i] !== next[i]) return true;
  }
  return false;
}

/** Capture the frame a classifier call needs from a live model. */
export function frameOf(screen: ScreenModel): Frame {
  const snap = screen.snapshot();
  return {
    lines: [...snap.lines],
    cursorX: snap.cursorX,
    cursorY: snap.cursorY,
    viewportY: screen.terminal.buffer.active.viewportY,
    altScreen: snap.buffer === 'alternate',
  };
}
