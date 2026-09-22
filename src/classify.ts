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
import { OP, type Op, type OpName } from './edit-record.js';

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
 * `before` is the screen as of `fromByte`; `after` is the live model once the
 * update has been fed in. `ops` are the ops recorded during it.
 *
 * An op's `byteOffset` is the end of the delivery that carried it: the byte
 * counter advances per feed, not per op. Two ops in one delivery therefore
 * always share an offset, which means ops can be *counted* but never ordered
 * or bounded against each other inside a delivery. Every segment below spans
 * the whole delivery for that reason.
 */
export function classify(params: {
  before: Frame;
  after: Frame;
  ops: readonly Op[];
  fromByte: number;
  toByte: number;
}): ClassifiedUpdate {
  const { before, after, ops, fromByte, toByte } = params;

  // The screen's own account, with no op to interpret it: did the content
  // land where an append would put it? Emitted first and spanning the whole
  // delivery, so an op that agrees absorbs it rather than replacing it.
  const segments: Segment[] = [inferSegment(before, after, fromByte, toByte)];

  for (const op of ops) {
    // Most ops are evidence, not segments: a mode change alters shape or
    // behaviour, and a structural event is the emulator reporting what it did
    // in response. Neither is a segment of its own.
    //
    // A buffer switch is the exception. It draws nothing and erases nothing,
    // but content on the alt screen is destroyed when the program leaves it
    // (L0.3), so the boundary has to survive into the stream -- neither
    // swallowed by the repaint that follows nor lost as mode-change noise.
    if (!OP.isDrawing(op.name) && !(OP.isModeChange(op.name) && OP.isAltScreenSwitch(op))) continue;

    segments.push(
      buildSegment({
        kind: OP.isAltScreenSwitch(op) ? 'writing' : 'drawing',
        before,
        after,
        op,
        fromByte,
        toByte,
      }),
    );
  }

  return { segments: coalesce(segments), fromByte, toByte };
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
      // An op-less segment is an inference from the screen; a segment carrying
      // an op is the program stating what it did, which is strictly better
      // evidence. Replace the inference's empty op list rather than appending
      // to it, so the verdict is attributed to the op. Otherwise union, since
      // a run of ops draws from more than one.
      if (prev.evidence.ops.length === 0) prev.evidence.ops.push(...seg.evidence.ops);
      else for (const name of seg.evidence.ops) if (!prev.evidence.ops.includes(name)) prev.evidence.ops.push(name);

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

/**
 * The verdict the screen supports on its own, with no control op to interpret.
 *
 * Every update gets one: L0.1 says the server reports every change, so an
 * update carrying only mode changes -- evidence, not segments -- must still
 * produce a segment rather than nothing.
 */
function inferSegment(before: Frame, after: Frame, fromByte: number, toByte: number): Segment {
  const scrolledBy = scrollDelta(before, after);
  const { erased, overwrote, reachedBack } = diffFacts(before, after, scrolledBy);

  // The decisive test when no control op fired: did the content land where an
  // append would put it? An append continues at the cursor and only ever
  // touches that row and, via scrolling, rows below it.
  //
  // A bare carriage-return overwrite emits no op at all (CLASSIFIER.md §9.2),
  // and a spinner is one followed by text, repeated. Judging those by "did
  // anything change anywhere" classifies a repaint as writing whenever a
  // repainted row happens to differ, which is most of them.
  const continued = appendContinues(before, after, scrolledBy);

  // A buffer switch is not a content change. Entering the alt screen replaces
  // the whole visible grid with a blank one, which reads as "erased" -- but
  // nothing was erased, another buffer was simply switched in. Treating it as
  // a repaint would call every shell→TUI transition a redraw.
  const bufferSwitch = before.altScreen !== after.altScreen;

  // Positive structural evidence. `continued` failing is the absence of a
  // signal, not a signal, so it demotes confidence rather than standing
  // alongside the three that do.
  const damaged = erased || overwrote || reachedBack;
  const isDrawing = !bufferSwitch && (!continued || damaged);

  return {
    kind: isDrawing ? 'drawing' : 'writing',
    confidence: isDrawing && !damaged ? 'low' : 'high',
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
  // a bare carriage return produce exactly this, and a program that is
  // mid-line is not repainting. Reporting it as drawing would fire once per
  // colour change.
  if (!changed) return true;

  // Deliberately no "cursor moved backwards ⇒ drawing" test. A trailing
  // carriage return after appended text leaves the cursor at column 0 with the
  // text intact, which every build log does; the structural signal for an
  // overwrite is `overwrote` -- text landing on cells that were already
  // non-blank.
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
  //
  // `CUP` alone corroborates because a repaint that redraws a row with the
  // content it already held leaves no screen fact behind -- the op is the
  // program stating its intent, and nothing here can contradict it.
  const agrees = kind === 'drawing' ? op.name === 'CUP' || erased || overwrote || reachedBack : !erased && !reachedBack;

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
