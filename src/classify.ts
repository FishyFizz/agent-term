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

/** DEC private modes that change which buffer is active. */
const ALT_SCREEN_MODES: ReadonlySet<number> = new Set([47, 1047, 1049]);

const OP = {
  isDrawing: (n: OpName) => DRAWING_OPS.has(n),
  isStructural: (n: OpName) => STRUCTURAL_OPS.has(n),
  /** Alt-screen enter/exit: a buffer switch, which is a timeline boundary. */
  isAltScreenSwitch: (op: Op): boolean =>
    (op.name === 'DECSET' || op.name === 'DECRST') &&
    op.params.some((p) => ALT_SCREEN_MODES.has(p)),
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

  // Op offsets are only as precise as the delivery that carried them: the byte
  // counter advances per feed, so an op reports the offset at the *end* of its
  // delivery. Two ops in one delivery therefore share an offset and cannot be
  // ordered or bounded against each other.
  //
  // When that happens the ops still say what the program did -- reaching for
  // CUP/EL is a repaint -- but they cannot say where one ends and the next
  // begins. So: one segment per op, each spanning the whole delivery, and let
  // the caller's coalescing merge the ones that agree. Spanning the whole
  // delivery rather than a zero-width point is what keeps them from being
  // discarded as noise.
  const offsets = new Set(ops.map((o) => o.byteOffset));
  const coarselyLocated = ops.length > 1 && offsets.size < ops.length;

  if (coarselyLocated) {
    for (const op of ops) {
      // Buffer switches are timeline boundaries, emitted on their own so they
      // neither swallow the repaint nor vanish into it. Other mode changes are
      // evidence, not segments.
      if (OP.isStructural(op.name) && !OP.isAltScreenSwitch(op)) continue;
      raw.push(
        buildSegment({
          kind: OP.isAltScreenSwitch(op) ? 'writing' : OP.isDrawing(op.name) ? 'drawing' : 'writing',
          before,
          after,
          op,
          fromByte,
          toByte,
        }),
      );
    }
    // When ops cannot be localized, the delivery is still usually mixed: text
    // followed by a repaint. Emit the append first and the op's run second --
    // the op sits at the end of the delivery, so anything before it was
    // written rather than drawn. In the ambiguous case (no way to tell) both
    // are reported and the caller sees the mixture; ordering the append first
    // keeps the repaint from absorbing it during coalescing.
    raw.unshift(appendOnly(before, after, fromByte, toByte).segments[0]!);
    return { segments: coalesce(raw), fromByte, toByte };
  }

  // A segment is the run of activity that *starts* at an op and runs until
  // the next one. Kind therefore comes from the op that opens it, not the one
  // that closes it: `text \n CUP EL text` is an append followed by a repaint,
  // and the CUP is what begins the repaint.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const start = i === 0 ? fromByte : ops[i - 1]!.byteOffset;
    const end = i === ops.length - 1 ? toByte : ops[i + 1]!.byteOffset;

    // Mode changes are not repaints -- except a buffer switch, which is a
    // timeline boundary even though it draws nothing. It is emitted *after*
    // the append that preceded it and *before* any repaint it introduces, so
    // merging cannot swallow either.
    if (OP.isStructural(op.name) && !OP.isAltScreenSwitch(op)) continue;
    if (OP.isAltScreenSwitch(op)) {
      raw.push(
        buildSegment({
          kind: 'writing',
          before,
          after,
          op,
          fromByte: start,
          toByte: Math.max(start, op.byteOffset),
        }),
      );
      continue;
    }

    // Text before the first op, with no op opening it: an append.
    //
    // Only when offsets actually localize the op. When the byte counter is
    // coarser than the ops, `start < op.byteOffset` is an artifact of the
    // shared offset, and inferring a leading append from it produces a
    // phantom segment that then absorbs the real evidence.
    if (i === 0 && start < op.byteOffset && offsets.size === ops.length) {
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

  // Every update gets at least one segment. An update with no segments is a
  // change the caller cannot see, and L0.1 says the server reports every
  // change. This happens when the only ops were mode changes, which are
  // evidence rather than segments of their own.
  if (raw.length === 0) {
    raw.push(appendOnly(before, after, fromByte, toByte).segments[0]!);
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
      // Keep the ops even when the range contributes nothing: a zero-width
      // segment still records what the program did, and dropping it loses the
      // evidence the verdict is supposed to carry (L0.1).
    // Absorb into whichever side carries op evidence. An op-less segment is an
    // inference from the screen; an op is the program stating what it did, and
    // that is strictly better. Without this, the inference segment emitted
    // first survives and the op evidence is lost.
    if (prev.evidence.ops.length === 0 && seg.evidence.ops.length > 0) {
      prev.evidence.ops.push(...seg.evidence.ops);
    } else {
      for (const name of seg.evidence.ops) {
        if (!prev.evidence.ops.includes(name)) prev.evidence.ops.push(name);
      }
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
  const scrolledBy = scrollDelta(before, after);
  const { erased, overwrote, reachedBack } = diffFacts(before, after, scrolledBy);

  // The decisive test when no control op fired: did the content land where an
  // append would put it? An append continues at the cursor and only ever
  // touches that row and, via scrolling, rows below it.
  //
  // A bare `\r` overwrite emits no op at all (CLASSIFIER.md §9.2), and a
  // spinner is `\r` + text repeated. Judging those by "did anything change
  // anywhere" classifies a repaint as writing whenever a repainted row
  // happens to differ, which is most of them.
  const continued = appendContinues(before, after, scrolledBy);

  // A buffer switch is not a content change. Entering the alt screen replaces
  // the whole visible grid with a blank one, which reads as "erased" -- but
  // nothing was erased, another buffer was simply switched in. Treating it as
  // a repaint would call every shell→TUI transition a redraw.
  const bufferSwitch = before.altScreen !== after.altScreen;

  const isDrawing = !bufferSwitch && (!continued || erased || overwrote || reachedBack);

  return {
    segments: [
      {
        kind: isDrawing ? 'drawing' : 'writing',
        confidence: isDrawing && !(erased || overwrote || reachedBack) ? 'low' : 'high',
        fromByte,
        toByte,
        evidence: {
          ops: [],
          erased,
          overwrote,
          reachedBack,
          scrolledBy,
          altScreen: after.altScreen,
        },
      },
    ],
    fromByte,
    toByte,
  };
}

/**
 * Did the change continue from where output was being appended?
 *
 * True when every changed row is at or below the row the cursor was writing
 * on, accounting for scroll, and the cursor did not move backwards.
 */
function appendContinues(before: Frame, after: Frame, scrolledBy: number): boolean {
  const rows = Math.min(before.lines.length, after.lines.length);

  // The append row, in `before` coordinates. Scrolling is already accounted
  // for by mapping an after-row back to `y + scrolledBy`, so comparing against
  // a further scroll-adjusted row would double-count it.
  const writeRow = before.cursorY;
  let changed = false;

  for (let y = 0; y < rows; y++) {
    const prevIdx = y + scrolledBy;
    if (prevIdx < 0 || prevIdx >= before.lines.length) continue;
    const prevLine = before.lines[prevIdx] ?? '';
    const nextLine = after.lines[y] ?? '';
    if (prevLine === nextLine) continue;
    changed = true;
    if (prevIdx < writeRow) return false;
  }

  // Nothing on screen changed: the only movement is the caret. SGR resets and
  // a bare `\r` produce exactly this, and a program that is mid-line is not
  // repainting. Reporting it as drawing would fire once per colour change.
  if (!changed) return true;

  // Deliberately no "cursor moved backwards ⇒ drawing" test. A trailing `\r`
  // after appended text leaves the cursor at column 0 with the text intact,
  // which every build log does; the structural signal for an overwrite is
  // `overwrote` -- text landing on cells that were already non-blank.
  void writeRow;
  return true;
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
  const scrolledBy = scrollDelta(before, after);
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

  // The append row, in `before` coordinates. Scrolling is already accounted
  // for by mapping an after-row back to `y + scrolledBy`, so comparing against
  // a further scroll-adjusted row would double-count it.
  const writeRow = before.cursorY;

  for (let y = 0; y < rows; y++) {
    const prevIdx = y + scrolledBy;
    // A row with no counterpart in `before` -- either below the buffer or
    // shifted off the top -- is not evidence of reaching back. The common case
    // is the bottom of a scroll: newly revealed content.
    if (prevIdx < 0 || prevIdx >= before.lines.length) continue;

    const prevLine = before.lines[prevIdx] ?? '';
    const nextLine = after.lines[y] ?? '';
    if (prevLine === nextLine) continue;

    if (prevIdx < writeRow) reachedBack = true;

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

/**
 * How many rows the content moved up between the two frames.
 *
 * Usually the `viewportY` difference -- but at scrollback capacity `viewportY`
 * saturates while content keeps shifting, so it reports 0 and the shift is
 * then misread as an overwrite of every row. Fall back to aligning the frames'
 * own lines: the shift whose row-by-row match is best.
 */
function scrollDelta(before: Frame, after: Frame): number {
  const declared = after.viewportY - before.viewportY;
  const rows = after.lines.length;
  if (rows === 0) return declared;

  let best = declared;
  let bestScore = scoreShift(before, after, declared);

  for (let shift = 0; shift < rows; shift++) {
    const score = scoreShift(before, after, shift);
    if (score > bestScore) {
      bestScore = score;
      best = shift;
    }
  }
  return best;
}

/** How many rows agree if content moved up by `shift`. */
function scoreShift(before: Frame, after: Frame, shift: number): number {
  let score = 0;
  for (let y = 0; y < after.lines.length; y++) {
    const prevIdx = y + shift;
    if (prevIdx < 0 || prevIdx >= before.lines.length) continue;
    if (before.lines[prevIdx] === after.lines[y]) score++;
  }
  return score;
}

/** Capture the frame a classifier call needs from a live model. */
export function frameOf(screen: ScreenModel): Frame {
  const snap = screen.snapshot();
  return {
    // Right-trimmed. `snapshot()` pads rows to the full width so a caller can
    // index a cell, but comparing padded rows against trimmed ones makes
    // every trailing-blank difference look like a real change.
    lines: snap.lines.map((l) => l.replace(/\s+$/, '')),
    cursorX: snap.cursorX,
    cursorY: snap.cursorY,
    viewportY: screen.terminal.buffer.active.viewportY,
    altScreen: snap.buffer === 'alternate',
  };
}
