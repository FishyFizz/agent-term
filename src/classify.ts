/**
 * Classification: what the screen did, per segment.
 *
 * The verdict is read off the screen and nowhere else. Not off the escape
 * sequences, not off what the program appears to have intended: a human at
 * the terminal sees a screen, and the agent is meant to see the same thing.
 * The op stream is how output is *replayed* and how a caller reads raw bytes
 * when the screen model is under suspicion (L2); it is not an input to the
 * verdict, because an op's meaning depends on what the program meant by it
 * and that is semantics, which GOAL.md puts out of scope.
 *
 * The tests are **structural and threshold-free**: did content arrive, was it
 * replaced in place, did it move, did the surface change. Never "more than
 * N% changed". A tuned classifier needs tuning per program, and GOAL.md's
 * success criteria are all "without special-casing any program".
 *
 * There is deliberately no abstention. Nothing here declines to answer, and
 * nothing here reports doubt: a verdict is either supported by the screen or
 * the screen says it did not happen. What replaces doubt is *volume* — an
 * update that collapsed many deliveries and changed little is reported as
 * having collapsed many deliveries, and a caller that cares can read the
 * intermediates. See CLASSIFIER.md §3.5.
 */
import type { ScreenModel } from './screen.js';
import type { ScreenSnapshot } from './screen.js';

export type Verdict = 'writing' | 'drawing';

/** Why a verdict was reached. Attached to every segment (L0.1: a bug you can't see is a bug you can't fix). */
export interface Evidence {
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
  cursorY: number;
  viewportY: number;
  altScreen: boolean;
}

/**
 * Classify one update for a session.
 *
 * `before` is the screen as of `fromByte`; `after` is the live model once the
 * update has been fed in.
 *
 * One segment per delivery, spanning the whole delivery: a segment cannot
 * claim a finer range than the thing it was measured over.
 */
export function classify(params: {
  before: Frame;
  after: Frame;
  fromByte: number;
  toByte: number;
}): ClassifiedUpdate {
  const { before, after, fromByte, toByte } = params;
  return { segments: [inferSegment(before, after, fromByte, toByte)], fromByte, toByte };
}

/**
 * Merge consecutive segments of the same kind.
 *
 * A repaint is rarely one op: shells and TUIs emit `CUP` per line they draw,
 * so a single screen update arrives as a run of same-kind ops. Reporting one
 * segment per op is noise for the agent; the meaningful unit is the run.
 * Different kinds are never merged -- that boundary is the whole point.
 *
 * Exported because replaying a corpus trace has the same need: a trace is
 * delivered in chunks, so classifying produces one batch per chunk and the
 * batches have to be joined. That is `merge` in test/helpers/corpus.ts, and
 * it routes the common case through here rather than re-deriving it.
 */
export function coalesce(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === seg.kind) {
      prev.toByte = Math.max(prev.toByte, seg.toByte);
      prev.evidence.erased ||= seg.evidence.erased;
      prev.evidence.overwrote ||= seg.evidence.overwrote;
      prev.evidence.reachedBack ||= seg.evidence.reachedBack;
      prev.evidence.scrolledBy += seg.evidence.scrolledBy;
      continue;
    }
    // Clone: coalescing mutates the accumulated segment.
    out.push({
      kind: seg.kind,
      fromByte: seg.fromByte,
      toByte: seg.toByte,
      evidence: { ...seg.evidence },
    });
  }
  return out;
}

/**
 * The verdict the screen supports.
 *
 * Every update gets exactly one: L0.1 says the server reports every change,
 * so an update that changed nothing visible still produces a segment rather
 * than nothing.
 *
 * A change is drawing exactly when it damaged something: erased a cell, wrote
 * over a non-blank one, or reached back above the cursor. Otherwise the
 * content landed where an append would put it, and that is writing.
 *
 * The decision is the same question `reachedBack` asks the other way round,
 * so a drawing always carries positive evidence: something was erased,
 * overwritten, or reached. Nothing here abstains, reports doubt, or declines
 * -- see the file header and CLASSIFIER.md §3.5.
 */
function inferSegment(before: Frame, after: Frame, fromByte: number, toByte: number): Segment {
  const scrolledBy = scrollDelta(before, after);
  const { erased, overwrote, reachedBack } = diffFacts(before, after, scrolledBy);

  // A bare carriage-return overwrite emits no op at all (CLASSIFIER.md §9.2),
  // and a spinner is one followed by text, repeated. Judging those by "did
  // anything change anywhere" classifies a repaint as writing whenever a
  // repainted row happens to differ, which is most of them.
  const damaged = erased || overwrote || reachedBack;

  // A buffer switch is not a content change. Entering the alt screen replaces
  // the whole visible grid with a blank one, which reads as "erased" -- but
  // nothing was erased, another buffer was simply switched in. Treating it as
  // a repaint would call every shell→TUI transition a redraw.
  const bufferSwitch = before.altScreen !== after.altScreen;

  return {
    kind: !bufferSwitch && damaged ? 'drawing' : 'writing',
    fromByte,
    toByte,
    evidence: {
      erased,
      overwrote,
      reachedBack,
      scrolledBy,
      altScreen: after.altScreen,
    },
  };
}

/**
 * The structural questions, answered against the two frames.
 *
 * `scrolledBy` rows have already been factored out, so a scrolling build log
 * is not mistaken for a repaint.
 *
 * One walk answers all three, because they are the same comparison asked three
 * ways. `reachedBack` is also the answer to "did the change continue from
 * where output was being appended?", asked the other way round: an append
 * continues at the cursor and only ever touches that row and, via scrolling,
 * rows below it. There is deliberately no "the cursor moved backwards" test --
 * a trailing carriage return after appended text leaves the cursor at column 0
 * with the text intact, which every build log does.
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

/**
 * Capture the frame a classifier call needs from a live model.
 *
 * `snap` may be passed when the caller has already taken one -- `feed` needs
 * the padded rows for a grid delta, and snapshotting the emulator twice per
 * delivery to get the same grid trimmed and untrimmed is waste, not clarity.
 */
export function frameOf(screen: ScreenModel, snap: ScreenSnapshot = screen.snapshot()): Frame {
  return {
    // Right-trimmed. `snapshot()` pads rows to the full width so a caller can
    // index a cell, but comparing padded rows against trimmed ones makes
    // every trailing-blank difference look like a real change.
    lines: snap.lines.map((l) => l.replace(/\s+$/, '')),
    cursorY: snap.cursorY,
    viewportY: screen.terminal.buffer.active.viewportY,
    altScreen: snap.buffer === 'alternate',
  };
}
