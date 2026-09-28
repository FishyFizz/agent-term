/**
 * Grid deltas: what changed between two screens, as a shift plus written runs.
 *
 * Storing a full screen per draw is the wrong shape for a terminal. A TUI
 * repainting a status bar at 60fps would retain a whole grid per frame, and a
 * 120x40 session at 60fps is roughly 17 MB/minute of state for changes that are
 * usually a few cells. Continuous repaint is the pathological case
 * this exists to bound.
 *
 * A delta carries what changed in **text** and in **appearance**. Text is
 * spliced by glyph; appearance rides as a per-row payload (`GridRow`). They are
 * not merged, because a row's colours are runs over *columns* while its glyphs
 * are indexed one at a time, and a row's glyphs are what decide where its wide
 * columns are -- reconciling all three inside one interval arithmetic is where
 * this would get subtly wrong. `screen.ts` owns the two coordinates; this file
 * only moves them.
 *
 * Verified against `@xterm/headless` v6.0.0:
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
import type { ScreenSnapshot, StyleRun } from './screen.js';

/** New content for a span of one row, after the shift. */
export interface GridRun {
  /** Row, in the shifted grid. */
  y: number;
  /** First glyph the run replaces. */
  x: number;
  /**
   * How many glyphs it replaces. **Not** always `text.length`: a row that gains
   * or loses a double-width glyph changes its glyph count, and a run that could
   * only preserve length could never say so.
   */
  len: number;
  /** Replacement text. Trailing unchanged glyphs are not included. */
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
 *
 * Text and appearance travel separately on purpose. `runs` splice glyphs;
 * `rows` carry a row's whole appearance. A run changes glyphs, and a row's
 * glyphs are what decides where its wide columns are, and `styles` are runs
 * over columns -- splicing all three in one interval arithmetic is where this
 * would get subtly wrong. A row payload is coarse, but appearance changes are
 * almost always whole-row anyway.
 */
export interface GridDelta {
  scrollBy: number;
  runs: GridRun[];
  /**
   * Rows whose appearance or glyph widths changed, with the new column state.
   *
   * Present **only** when one of them changed: a row whose glyphs changed but
   * whose colours and widths did not needs no payload, and carries none.
   */
  rows: GridRow[];
}

/** One row's column-space state. */
export interface GridRow {
  y: number;
  styles: StyleRun[];
  wide: number[];
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
      best = { scrollBy, runs: encoded.runs, rows: encoded.rows };
    }
  };

  // The cheap path, and the correct one whenever the ring has not saturated.
  consider(hint);
  if (bestCost === 0) return best;

  for (let scrollBy = 0; scrollBy < rows; scrollBy++) {
    consider(scrollBy);
    // Zero means nothing changed at all -- not one glyph, not one colour --
    // because appearance is counted in the cost. Nothing can beat that, so the
    // search is over.
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
 *
 * **The trap this exists to avoid.** A repaint that changes only colour leaves
 * the glyph strings identical. Comparing text alone would find nothing changed,
 * return an empty delta at zero cost, and the recolour would be silently gone
 * -- and the `bestCost === 0` early return above is exactly where it would go.
 * So a row counts as changed when its glyphs **or** its appearance **or** its
 * glyph widths differ, and cost counts the appearance payload, which is what
 * keeps a restyle from costing zero.
 */
function encodeAt(
  before: ScreenSnapshot,
  after: ScreenSnapshot,
  scrollBy: number,
): { runs: GridRun[]; rows: GridRow[]; cost: number } | null {
  const { rows, cols } = after;
  const base = shiftRows(before.lines, scrollBy, rows, () => blank(cols));
  // A row past the end gains no appearance and no wide columns, which is what
  // a blank row has.
  const baseStyles = shiftRows(before.styles, scrollBy, rows, () => []);
  const baseWide = shiftRows(before.wide, scrollBy, rows, () => []);
  const runs: GridRun[] = [];
  const changed: GridRow[] = [];
  let cost = 0;

  for (let y = 0; y < rows; y++) {
    const from = base[y] ?? '';
    const to = after.lines[y] ?? '';
    const textChanged = from !== to;
    const stylesChanged = !sameRuns(baseStyles[y], after.styles[y]);
    const wideChanged = !sameWide(baseWide[y], after.wide[y]);
    if (!textChanged && !stylesChanged && !wideChanged) continue;

    if (textChanged) {
      // The common prefix is where the two rows agree; everything after it is
      // rewritten.
      let x = 0;
      const shared = Math.min(from.length, to.length);
      while (x < shared && from[x] === to[x]) x++;

      let len = from.length - x;
      let text = to.slice(x);
      if (from.length === to.length) {
        // Same glyph count, so the suffix aligns too: keep it and rewrite only
        // the span that actually differs. A row cleared to blanks keeps the
        // whole blank suffix and rewrites just the text, so blanking needs no
        // special case.
        let end = shared;
        while (end > x && from[end - 1] === to[end - 1]) end--;
        len = end - x;
        text = to.slice(x, end);
      }

      runs.push({ y, x, len, text });
      cost += Math.max(len, text.length);
    }

    if (stylesChanged || wideChanged) {
      const styles = after.styles[y] ?? [];
      const wide = after.wide[y] ?? [];
      changed.push({ y, styles, wide });
      // At least one, so a pure restyle cannot cost nothing.
      cost += 1 + styles.length + wide.length;
    }
  }

  // The verifier. Everything above is a guess until this passes -- and it
  // checks appearance as well, or it would happily approve a delta that drops
  // every colour on the screen.
  const recon = base.slice();
  for (const run of runs) {
    const line = recon[run.y] ?? '';
    recon[run.y] = line.slice(0, run.x) + run.text + line.slice(run.x + run.len);
  }
  const reconStyles = baseStyles.slice();
  const reconWide = baseWide.slice();
  for (const row of changed) {
    reconStyles[row.y] = row.styles;
    reconWide[row.y] = row.wide;
  }
  for (let y = 0; y < rows; y++) {
    if (recon[y] !== after.lines[y]) return null;
    if (!sameRuns(reconStyles[y], after.styles[y])) return null;
    if (!sameWide(reconWide[y], after.wide[y])) return null;
  }
  return { runs, rows: changed, cost };
}

/**
 * Rows scrolled up by `scrollBy`; rows past the end come in as `blank`.
 *
 * One function for glyphs, appearance runs and wide columns: a delta shifts all
 * three by the same amount, and three copies of that walk is how they drift
 * apart.
 */
function shiftRows<T>(source: readonly T[], scrollBy: number, rows: number, blank: () => T): T[] {
  const out: T[] = [];
  for (let y = 0; y < rows; y++) {
    const src = y + scrollBy;
    out.push(src < rows ? (source[src] ?? blank()) : blank());
  }
  return out;
}

function sameRuns(a: readonly StyleRun[] | undefined, b: readonly StyleRun[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const x = left[i]!;
    const y = right[i]!;
    if (x.from !== y.from || x.to !== y.to || x.style !== y.style) return false;
  }
  return true;
}

function sameWide(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((v, i) => v === right[i]);
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
  const lines = shiftRows(base.lines, delta.scrollBy, rows, () => blank(cols));
  const styles = shiftRows(base.styles, delta.scrollBy, rows, () => []);
  const wide = shiftRows(base.wide, delta.scrollBy, rows, () => []);

  for (const run of delta.runs) {
    if (run.y < 0 || run.y >= rows) continue;
    const line = lines[run.y] ?? '';
    lines[run.y] = line.slice(0, run.x) + run.text + line.slice(run.x + run.len);
  }
  for (const row of delta.rows) {
    if (row.y < 0 || row.y >= rows) continue;
    styles[row.y] = row.styles;
    wide[row.y] = row.wide;
  }
  return { ...base, lines, styles, wide };
}
