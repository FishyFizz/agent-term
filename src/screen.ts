/**
 * The screen model: a hosted terminal's cell grid, fed by the pty.
 *
 * L0.2 — the screen is a structured model, never a byte stream. One
 * `@xterm/headless` Terminal per session is the authority for what a human at
 * that terminal would see; everything above this (classification, history,
 * delivery) reads cells from here and never re-parses bytes.
 *
 * Two constraints shape the API, both verified against v6.0.0:
 *
 * 1. `terminal.write()` is **asynchronous**. The buffer does not reflect a
 *    write until its callback fires, so every write here is awaited and
 *    `snapshot()` is only meaningful after `feed()` resolves. Reading
 *    `terminal.buffer` in the same tick as a write sees a stale grid.
 * 2. The alternate buffer has **no scrollback** — its `length` stays fixed at
 *    `rows`. Content written there is destroyed when the program exits the alt
 *    screen, so capturing it while live is mandatory, not optional.
 *
 * ## Two coordinates, and why
 *
 * A snapshot describes a row in **glyph** space and in **column** space, and for
 * most content the two agree. They part company on a double-width glyph — CJK,
 * or an emoji — which is *one* string index but *two* terminal columns:
 *
 * ```
 *   'ab中文cd' in a 10-column terminal
 *     glyphs  : a b 中 文 c d            (6 characters)
 *     columns : 0 1 2·3 4·5 6 7          (8 columns; · is the tail of a wide glyph)
 * ```
 *
 * `lines` is glyph space, because that is what a caller reads and searches as
 * text. `cols`, `wide`, `cursorX` and `styles` are column space, because that is
 * where a position on a screen lives. Pinning a row to `cols` *characters*
 * instead — which this used to do — over-fills every wide row and misstates
 * every position after the first wide glyph.
 *
 * The mapping is total and lives in one place: `columnOf`, `glyphAtColumn` and
 * `styleAt` below are the only code that reconciles the two. Content with no
 * wide characters has `wide` empty, both coordinates identical, and a row that
 * is exactly `cols` characters — so nothing that reads `lines` had to change.
 */
import { createTerminal, type IBufferCell, type XtermTerminal } from './xterm.js';
import { EditRecord, type Op } from './edit-record.js';
import { TextLog } from './text-log.js';
import { assertGridSize } from './types.js';

/** One row of the screen, as text. Glyph-indexed; see `ScreenSnapshot.wide`. */
export type ScreenRow = string;

/** A run of columns sharing one appearance, half-open `[from, to)`. */
export interface StyleRun {
  from: number;
  to: number;
  /**
   * Canonical appearance key; `''` is the default appearance (no colour, no
   * flags), which is what most cells on most screens are.
   */
  style: string;
}

/**
 * A faithful capture of what is on the screen.
 *
 * Deliberately a plain, JSON-serializable structure: it crosses the MCP
 * boundary and is stored in history (L0.3), so it must not carry live
 * references into the emulator.
 */
export interface ScreenSnapshot {
  /** Rows top to bottom, exactly `rows` of them. Indexed by glyph; see `wide`. */
  lines: ScreenRow[];
  /**
   * Per row, appearance runs over **columns**. Only the non-default columns
   * appear; anything no run covers is the default appearance. `[]` means the
   * whole row is default, which is the common case.
   */
  styles: StyleRun[][];
  /** Per row, the columns where a double-width glyph begins. `[]` means none. */
  wide: number[][];
  cols: number;
  rows: number;
  /** Which buffer is active. Alt screen is context, not a verdict (CLASSIFIER.md §3.4). */
  buffer: 'normal' | 'alternate';
  /** Cursor position within the viewport, in **columns**. */
  cursorX: number;
  cursorY: number;
  /** True when the active buffer has scrollback (normal only). */
  hasScrollback: boolean;
}

/** The appearance at a column. `''` when the row is all default. */
export function styleAt(snapshot: ScreenSnapshot, y: number, column: number): string {
  for (const run of snapshot.styles[y] ?? []) {
    if (column >= run.from && column < run.to) return run.style;
  }
  return '';
}

/** The column a glyph starts at. */
export function columnOf(snapshot: ScreenSnapshot, y: number, glyph: number): number {
  const wide = snapshot.wide[y] ?? [];
  let column = 0;
  for (let g = 0; g < glyph; g++) column += wide.includes(column) ? 2 : 1;
  return column;
}

/**
 * The glyph at a column, or `-1` when that column is the tail of a wide glyph.
 *
 * The `-1` is the point: a wide glyph owns two columns and only the first holds
 * a character, so a caller asking "what is at column 3?" after a double-width
 * glyph at column 2 needs to be told there is nothing there rather than handed
 * the next character along.
 */
export function glyphAtColumn(snapshot: ScreenSnapshot, y: number, column: number): number {
  if (column < 0 || column >= snapshot.cols) return -1;
  const wide = snapshot.wide[y] ?? [];
  let col = 0;
  for (let glyph = 0; col < snapshot.cols; glyph++) {
    const width = wide.includes(col) ? 2 : 1;
    if (col === column) return glyph;
    if (col < column && column < col + width) return -1;
    col += width;
  }
  return -1;
}

/**
 * The canonical key for a cell's appearance.
 *
 * A string rather than an index into a palette: it is self-contained, so a
 * stored screen needs no table kept alive beside it across keyframes, deltas and
 * epochs; it compares with `===`; and it is readable in a trace.
 */
function cellStyle(cell: IBufferCell): string {
  if (cell.isAttributeDefault()) return '';
  const parts: string[] = [];
  if (cell.isFgRGB()) parts.push(`fg#${hex(cell.getFgColor())}`);
  else if (cell.isFgPalette()) parts.push(`fg${cell.getFgColor()}`);
  if (cell.isBgRGB()) parts.push(`bg#${hex(cell.getBgColor())}`);
  else if (cell.isBgPalette()) parts.push(`bg${cell.getBgColor()}`);
  // Fixed order: two keys for the same appearance must be the same string.
  if (cell.isBold()) parts.push('bold');
  if (cell.isDim()) parts.push('dim');
  if (cell.isItalic()) parts.push('italic');
  if (cell.isUnderline()) parts.push('underline');
  if (cell.isBlink()) parts.push('blink');
  if (cell.isInverse()) parts.push('inverse');
  if (cell.isInvisible()) parts.push('invisible');
  if (cell.isStrikethrough()) parts.push('strike');
  if (cell.isOverline()) parts.push('overline');
  return parts.join(' ');
}

function hex(value: number): string {
  return value.toString(16).padStart(6, '0');
}

/**
 * Owns one terminal emulator and the bytes fed into it.
 */
export class ScreenModel {
  readonly terminal: XtermTerminal;
  /** The op stream: control operations, in order, with byte offsets. */
  readonly ops: EditRecord;
  /**
   * The text log: completed lines, in order. CLASSIFIER.md §5's second sink,
   * and the only record of lines that fell out of a bounded scrollback.
   */
  readonly text: TextLog;

  private _cols: number;
  private _rows: number;

  constructor(cols: number, rows: number) {
    this._cols = cols;
    this._rows = rows;
    this.terminal = createTerminal({ cols, rows });
    // Installed immediately so no bytes can reach the parser unobserved.
    this.ops = new EditRecord(this.terminal);
    this.text = new TextLog(this.terminal);
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  /**
   * Feed raw pty bytes to the emulator.
   *
   * Resolves once the emulator has parsed them, which is the only point at
   * which `snapshot()` and `ops` reflect this input.
   */
  feed(data: Buffer | string): Promise<void> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    // Counted before the write: handlers run during it, and by then the
    // offset must already include the bytes that produced them.
    this.ops.noteBytes(bytes.length);
    this.text.noteBytes(bytes.length);
    return new Promise((resolve) => {
      this.terminal.write(new Uint8Array(bytes), () => resolve());
    });
  }

  /** Resize the grid. Content reflows; callers treat this as an event, not a change. */
  resize(cols: number, rows: number): void {
    assertGridSize(cols, rows);
    this.terminal.resize(cols, rows);
    this._cols = cols;
    this._rows = rows;
  }

  /**
   * Capture the current screen.
   *
   * One walk over the cells per row, because the row's glyphs, its appearance
   * runs and its wide columns are three views of one fact and deriving them
   * separately is how they drift apart.
   *
   * Blank cells are `' '` with the default appearance, so a row is neither
   * padded nor trimmed here: it is exactly the columns the emulator holds, which
   * is `cols` glyphs unless a wide glyph is present.
   */
  snapshot(): ScreenSnapshot {
    const buffer = this.terminal.buffer.active;
    // `getLine(y)` is an index into the whole buffer *including* scrollback,
    // so the visible row y is at `viewportY + y`. Absolute indexing here would
    // silently capture the top of scrollback instead of the screen -- the
    // viewport scrolls but the buffer's first line never changes.
    const top = buffer.viewportY;
    // One cell object, reloaded per column: the typings recommend this
    // explicitly when every cell is being looped over.
    const cell = buffer.getLine(top)?.getCell(0);

    const lines: ScreenRow[] = [];
    const styles: StyleRun[][] = [];
    const wide: number[][] = [];
    for (let y = 0; y < this._rows; y++) {
      const row = this.buildRow(top + y, cell);
      lines.push(row.line);
      styles.push(row.styles);
      wide.push(row.wide);
    }

    return {
      lines,
      styles,
      wide,
      cols: this._cols,
      rows: this._rows,
      buffer: buffer.type,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      hasScrollback: buffer.type === 'normal',
    };
  }

  /** One row: its glyphs, its appearance runs over columns, its wide columns. */
  private buildRow(
    y: number,
    cell: IBufferCell | undefined,
  ): { line: string; styles: StyleRun[]; wide: number[] } {
    const line = this.terminal.buffer.active.getLine(y);
    const styles: StyleRun[] = [];
    const wide: number[] = [];
    let text = '';
    let column = 0;

    // The run being accumulated, or `start < 0` for none.
    let start = -1;
    let runStyle = '';
    const extend = (style: string, at: number): void => {
      if (start < 0) {
        start = at;
        runStyle = style;
      } else if (style !== runStyle) {
        styles.push({ from: start, to: at, style: runStyle });
        start = at;
        runStyle = style;
      }
    };

    for (let x = 0; column < this._cols; x++) {
      const c = line?.getCell(x, cell);
      if (!c) break;
      const width = c.getWidth();
      // Width 0 is the tail half of a double-width glyph: it holds no
      // character and occupies no column of its own.
      if (width === 0) continue;
      extend(cellStyle(c), column);
      if (width === 2) wide.push(column);
      // A cell holding no character is a blank column, and it renders as a
      // space. The emulator reports it as `''` rather than `' '`, which is why
      // `translateToString` -- and the padding this replaced -- had to supply
      // the space.
      const chars = c.getChars();
      text += chars === '' ? ' ' : chars;
      column += width;
    }

    // A line shorter than the grid is blank to the right, and blanks are
    // default. Closing the run first keeps a styled prefix from bleeding.
    if (column < this._cols) {
      extend('', column);
      text += ' '.repeat(this._cols - column);
      column = this._cols;
    }
    if (start >= 0) styles.push({ from: start, to: column, style: runStyle });

    // Only non-default columns are worth a run: `styleAt` resolves by
    // containment, so a column no run covers is default already. Dropping them
    // makes the common case free and makes two captures of the same screen
    // identical.
    return { line: text, styles: styles.filter((run) => run.style !== ''), wide };
  }

  dispose(): void {
    this.ops.dispose();
    this.text.dispose();
    this.terminal.dispose();
  }
}
