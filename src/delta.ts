/**
 * Grid deltas: what changed between two screens, as a shift plus written runs.
 *
 * Storing a full screen per draw is the wrong shape for a terminal. A TUI
 * repainting a status bar at 60fps would retain a whole grid per frame, and a
 * 120x40 session at 60fps is roughly 17 MB/minute of state for changes that are
 * usually a few cells. GOAL.md calls continuous repaint the pathological case
 * (criterion 5), so it is the case this exists to bound.
 *
 * Verified against `@xterm/headless` v6.0.0 (HISTORY.md):
 *
 *  - A naive row diff is useless for a scrolling log: one new line in a 6-row
 *    grid differs in 5 of 6 rows, because the content shifted.
 *  - Xterm exposes no exact scroll counter past saturation. `IBuffer.baseY`
 *    freezes at the scrollback size while content keeps moving, and an
 *    `IMarker` tracks a line through *eviction*, not scroll. So the shift is
 *    not read from the emulator.
 *  - The shift is instead **searched and verified**, which needs no counter.
 *
 * A free parameter with a verifier is not a heuristic: `gridDelta` accepts a
 * shift only if applying the result reproduces `after` exactly, so a wrong
 * shift cannot be returned. And the shift it returns is not necessarily the
 * one the terminal performed -- a 5-line scroll is cheaper to describe as
 * `scrollBy=1` plus 4 runs, and is exactly equivalent. That is safe because
 * later deltas are computed against the real after-state, never against a
 * reconstruction, so an equivalent choice cannot compound.
 */
import type { ScreenSnapshot } from './screen.js';

/** New content for a span of one row, after the shift. */
export interface GridRun {
  /** Row, in the shifted grid. */
  y: number;
  /** First column the run replaces. */
  x: number;
  /** Replacement text. Trailing unchanged columns are not included. */
  text: string;
}

/**
 * A screen change: the grid shifted up by `scrollBy`, then these runs written.
 *
 * Shift-then-write, not one or the other. Within a delivery the program writes
 * at the cursor *first* and the scroll happens *after*, so the new content
 * lands at pre-scroll positions -- a shift alone can never describe it, which
 * is what an early attempt at whole-overlap matching discovered by failing to
 * match anything at all.
 */
export interface GridDelta {
  scrollBy: number;
  runs: GridRun[];
}

/**
 * Encode the change from `before` to `after`, or `null` if a snapshot is
 * cheaper.
 *
 * `hint` is the shift to try first: callers pass the viewport delta, which is
 * exactly right whenever the scrollback ring has not saturated. If it verifies,
 * no search happens. When it does not -- the saturated case -- every shift is
 * tried and the cheapest verified one wins.
 */
export function gridDelta(before: ScreenSnapshot, after: ScreenSnapshot, hint = 0): GridDelta | null {
  // A grid change is only expressible against a grid of the same shape. A
  // different size is a new epoch (a resize); a different buffer is a wholesale
  // replace. Neither is a delta, and the caller stores a keyframe instead.
  if (before.cols !== after.cols || before.rows !== after.rows) return null;
  if (before.buffer !== after.buffer) return null;

  const { rows, cols } = after;
  const attempted = new Set<number>();
  let best: GridDelta | null = null;
  let bestCost = Infinity;

  const consider = (scrollBy: number): void => {
    if (scrollBy < 0 || scrollBy >= rows || attempted.has(scrollBy)) return;
    attempted.add(scrollBy);
    const encoded = encodeAt(before, after, scrollBy);
    if (encoded && encoded.cost < bestCost) {
      bestCost = encoded.cost;
      best = { scrollBy, runs: encoded.runs };
    }
  };

  // The cheap path, and the correct one whenever the ring has not saturated.
  consider(hint);
  if (bestCost === 0) return best;

  for (let scrollBy = 0; scrollBy < rows; scrollBy++) {
    consider(scrollBy);
    // Nothing can cost less than nothing; a shift that rewrites no cell is the
    // answer and the search is over.
    if (bestCost === 0) break;
  }

  // A delta no smaller than a full grid is not worth decoding. Let the caller
  // store the state itself.
  if (!best || bestCost >= rows * cols) return null;
  return best;
}

/**
 * The runs that turn `before` (shifted by `scrollBy`) into `after`, or `null`
 * when no such description exists.
 *
 * Returning `null` rather than a best-effort answer is the whole point: the
 * caller must not be able to store a delta that does not reproduce the screen.
 */
function encodeAt(
  before: ScreenSnapshot,
  after: ScreenSnapshot,
  scrollBy: number,
): { runs: GridRun[]; cost: number } | null {
  const { rows, cols } = after;
  const base = shift(before.lines, scrollBy, rows, cols);
  const runs: GridRun[] = [];
  let cost = 0;

  for (let y = 0; y < rows; y++) {
    const from = base[y] ?? '';
    const to = after.lines[y] ?? '';
    if (from === to) continue;

    // Replace only the span that actually differs: keep the common prefix and
    // the common suffix. A row cleared to blanks keeps the whole blank suffix
    // and rewrites just the text, so blanking needs no special case.
    let x = 0;
    while (x < cols && from[x] === to[x]) x++;
    let end = cols;
    while (end > x && from[end - 1] === to[end - 1]) end--;

    runs.push({ y, x, text: to.slice(x, end) });
    cost += end - x;
  }

  // The verifier. Everything above is a guess until this passes.
  const recon = base.slice();
  for (const run of runs) {
    const line = recon[run.y] ?? '';
    recon[run.y] = line.slice(0, run.x) + run.text + line.slice(run.x + run.text.length);
  }
  for (let y = 0; y < rows; y++) {
    if (recon[y] !== after.lines[y]) return null;
  }
  return { runs, cost };
}

/** Content scrolled up by `scrollBy`; rows past the end come in blank. */
function shift(lines: readonly string[], scrollBy: number, rows: number, cols: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < rows; y++) {
    const src = y + scrollBy;
    out.push(src < rows ? (lines[src] ?? blank(cols)) : blank(cols));
  }
  return out;
}

function blank(cols: number): string {
  return ' '.repeat(cols);
}

/**
 * Apply a delta to a screen.
 *
 * The cursor is not part of a delta -- it is `HistoryRecord.cursor` -- so the
 * returned snapshot carries `base`'s metadata and the caller overlays the
 * record's own cursor and buffer.
 */
export function applyDelta(base: ScreenSnapshot, delta: GridDelta): ScreenSnapshot {
  const { rows, cols } = base;
  const lines = shift(base.lines, delta.scrollBy, rows, cols);
  for (const run of delta.runs) {
    if (run.y < 0 || run.y >= rows) continue;
    const line = lines[run.y] ?? '';
    lines[run.y] = line.slice(0, run.x) + run.text + line.slice(run.x + run.text.length);
  }
  return { ...base, lines };
}
