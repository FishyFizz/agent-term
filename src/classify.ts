/**
 * Classification: what the screen did, one verdict per delivery.
 *
 * The verdict is read off the screen and nowhere else. Not off the escape
 * sequences, not off what the program appears to have intended: a human at
 * the terminal sees a screen, and the agent is meant to see the same thing.
 * The op stream is how output is *replayed* and how a caller reads raw bytes
 * when the screen model is under suspicion; it is not an input to the
 * verdict, because an op's meaning depends on what the program meant by it
 * and that is semantics, which is out of scope.
 *
 * The tests are **structural and threshold-free**: did content arrive, was it
 * replaced in place, did it move, did the surface change. Never "more than
 * N% changed". A tuned classifier needs tuning per program, and the project's
 * success criteria are all "without special-casing any program".
 *
 * There is deliberately no abstention. Nothing here declines to answer, and
 * nothing here reports doubt: a verdict is either supported by the screen or
 * the screen says it did not happen. What replaces doubt is *volume* — an
 * update that collapsed many deliveries and changed little is reported as
 * having collapsed many deliveries, and a caller that cares can read the
 * intermediates.
 */
import type { ScreenModel } from './screen.js';
import type { ScreenSnapshot } from './screen.js';

export type Verdict = 'writing' | 'drawing';

/** Why a verdict was reached. Attached to every segment (a bug you can't see is a bug you can't fix). */
export interface Evidence {
  /** The segment erased cells outside the scrolled region. */
  erased: boolean;
  /** The segment wrote onto cells that were non-blank. */
  overwrote: boolean;
  /** The segment changed rows above where the cursor was writing. */
  reachedBack: boolean;
  /** Rows scrolled during the segment, already factored out. */
  scrolledBy: number;
  /** The segment ran on the alternate buffer. A prior, not a verdict. */
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
  /**
   * Rows of the *after* frame that differ from their counterpart in `before`.
   *
   * The segment says a redraw happened and over which bytes; this says which
   * rows it landed on, which is the question a caller driving a TUI is actually
   * asking and the one a byte span cannot answer -- "bytes 6199-7573 were
   * redrawn" does not say that one glyph flipped. Indices, not content: the
   * rows themselves are in the screen the update carries, and the ones they
   * replaced are one `history_read` away.
   *
   * Scroll-aware, so a build log moving up reports only the rows that truly
   * changed rather than every row that shifted (see `rowDiff`).
   */
  changedRows: number[];
  /** Bytes consumed by this update. */
  fromByte: number;
  toByte: number;
}

/**
 * A screen captured before and after a delivery, used to answer structural
 * questions about what it did.
 */
export interface Frame {
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
  /** Rows the emulator reports the content moved. See `scrollDelta`. */
  scrolledBy?: number;
}): ClassifiedUpdate {
  const { before, after, fromByte, toByte, scrolledBy } = params;
  // Resolved once and passed in: the scroll estimate and the row walk are the
  // same facts whether they are read for the verdict or for the row list, and
  // computing them twice could let the two disagree.
  const scrolled = scrollDelta(before, after, scrolledBy);
  const facts = diffFacts(before, after, scrolled);
  return {
    segments: [inferSegment(before, after, fromByte, toByte, scrolled, facts)],
    changedRows: facts.rows,
    fromByte,
    toByte,
  };
}

/**
 * Merge consecutive segments of the same kind.
 *
 * `classify` produces one segment per delivery, so this is what turns a run of
 * deliveries that did the same kind of thing into one span -- which is what a
 * caller scoring a trace, or paging history, wants to read.
 *
 * Different kinds are never merged -- that boundary is the whole point. A
 * sequence of deliveries that alternates stays a sequence, because "this
 * happened, then that" is the comprehensible answer.
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
 * Every update gets exactly one: the server reports every change,
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
 * -- see the file header.
 */
function inferSegment(
  before: Frame,
  after: Frame,
  fromByte: number,
  toByte: number,
  scrolledBy: number,
  facts: { erased: boolean; overwrote: boolean; reachedBack: boolean },
): Segment {
  const { erased, overwrote, reachedBack } = facts;

  // A bare carriage-return overwrite emits no op at all,
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
 * What one row did between two frames, scroll-normalised.
 *
 * The single row comparison in the repo. `diffFacts` reads it in aggregate to
 * answer the classifier's questions; `text-log.ts` reads it per row to decide
 * whether a captured line is text or a repaint. Two comparisons would be two
 * witnesses, and they could disagree.
 *
 * A row that was erased or overwritten is a repaint — something was there and
 * is now gone or different. Anything else is content arriving, which is the
 * text log's definition of a line. Note that "arriving" is not the same as
 * "changed in this window": a line is often written by one delivery and
 * completed by the next, and in the second its row is untouched. So the text
 * log asks whether a row was *replaced*, not whether it changed.
 */
export interface RowDiff {
  /** True when the row differs from its counterpart in `before`. */
  changed: boolean;
  /** Non-blank cells became blank. */
  erased: boolean;
  /** Non-blank cells changed to different non-blank content. */
  overwrote: boolean;
}

export function rowDiff(
  before: readonly string[],
  after: readonly string[],
  scrolledBy: number,
  y: number,
): RowDiff {
  const none: RowDiff = { changed: false, erased: false, overwrote: false };
  const prevIdx = y + scrolledBy;
  // A row with no counterpart in `before` -- below the buffer, or shifted off
  // the top -- is newly revealed. The common case is the bottom of a scroll.
  if (prevIdx < 0 || prevIdx >= before.length) {
    return { changed: true, erased: false, overwrote: false };
  }
  const prev = before[prevIdx] ?? '';
  const next = after[y] ?? '';
  if (prev === next) return none;

  return { changed: true, erased: blanked(prev, next), overwrote: overwroteNonBlank(prev, next) };
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
): { erased: boolean; overwrote: boolean; reachedBack: boolean; rows: number[] } {
  const rows = Math.min(before.lines.length, after.lines.length);
  let erased = false;
  let overwrote = false;
  let reachedBack = false;
  // Which rows of `after` differ from their counterpart. The walk is already
  // happening for the three flags above, so collecting the indices costs
  // nothing -- and it is the fact the flags cannot carry: `erased` says a row
  // was damaged somewhere, never where.
  const changed: number[] = [];

  // The append row, in `before` coordinates. Scrolling is already accounted
  // for by mapping an after-row back to `y + scrolledBy`, so comparing against
  // a further scroll-adjusted row would double-count it.
  const writeRow = before.cursorY;

  for (let y = 0; y < rows; y++) {
    const row = rowDiff(before.lines, after.lines, scrolledBy, y);
    if (!row.changed) continue;
    changed.push(y);

    // A row shifted off the top has no `before` counterpart to reach back into.
    const prevIdx = y + scrolledBy;
    if (prevIdx >= 0 && prevIdx < before.lines.length && prevIdx < writeRow) reachedBack = true;

    if (row.erased) erased = true;
    if (row.overwrote) overwrote = true;
  }

  return { erased, overwrote, reachedBack, rows: changed };
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
function scrollDelta(before: Frame, after: Frame, reported = 0): number {
  // Trust the emulator when it reports a scroll. It counts rows as they move,
  // so it stays correct where `viewportY` does not -- a burst larger than the
  // grid moves every visible line off, and aligning the frames afterwards finds
  // no overlap to recover the shift from.
  if (reported > 0) return reported;
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
  return frameFrom(snap, screen.terminal.buffer.active.viewportY);
}

/**
 * The frame a *stored* screen makes, with no live model behind it.
 *
 * The projection over a timeline classifies from screens that were recorded,
 * not from an emulator still running, so it cannot ask `screen.terminal` for
 * anything. `viewportY` is the one field it cannot supply; it is only ever a
 * hint to `scrollDelta`, and a caller reconstructing from the stream passes the
 * scroll it recorded, so nothing reads it.
 */
export function frameFrom(snap: ScreenSnapshot, viewportY = 0): Frame {
  return {
    // Right-trimmed. `snapshot()` pads rows to the full width so a caller can
    // index a cell, but comparing padded rows against trimmed ones makes
    // every trailing-blank difference look like a real change.
    lines: snap.lines.map((l) => l.replace(/\s+$/, '')),
    cursorY: snap.cursorY,
    viewportY,
    altScreen: snap.buffer === 'alternate',
  };
}
