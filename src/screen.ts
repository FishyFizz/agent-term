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
 */
import { createTerminal, type XtermTerminal } from './xterm.js';
import { EditRecord, type Op } from './edit-record.js';

/** One row of the screen, as text. */
export type ScreenRow = string;

/**
 * A faithful capture of what is on the screen.
 *
 * Deliberately a plain, JSON-serializable structure: it crosses the MCP
 * boundary and is stored in history (L0.3), so it must not carry live
 * references into the emulator.
 */
export interface ScreenSnapshot {
  /** Rows top to bottom, exactly `rows` of them, each exactly `cols` cells wide. */
  lines: ScreenRow[];
  cols: number;
  rows: number;
  /** Which buffer is active. Alt screen is context, not a verdict (CLASSIFIER.md §3.4). */
  buffer: 'normal' | 'alternate';
  /** Cursor position within the viewport. */
  cursorX: number;
  cursorY: number;
  /** True when the active buffer has scrollback (normal only). */
  hasScrollback: boolean;
}

/**
 * Owns one terminal emulator and the bytes fed into it.
 */
export class ScreenModel {
  readonly terminal: XtermTerminal;
  /** The op stream: control operations, in order, with byte offsets. */
  readonly ops: EditRecord;

  private _cols: number;
  private _rows: number;

  constructor(cols: number, rows: number) {
    this._cols = cols;
    this._rows = rows;
    this.terminal = createTerminal({ cols, rows });
    // Installed immediately so no bytes can reach the parser unobserved.
    this.ops = new EditRecord(this.terminal);
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
    return new Promise((resolve) => {
      this.terminal.write(new Uint8Array(bytes), () => resolve());
    });
  }

  /** Resize the grid. Content reflows; callers treat this as an event, not a change. */
  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new RangeError(`invalid terminal size ${cols}x${rows}`);
    }
    this.terminal.resize(cols, rows);
    this._cols = cols;
    this._rows = rows;
  }

  /**
   * Capture the current screen.
   *
   * Lines are padded to full width so a caller can index a cell by (x, y)
   * without worrying about trailing blank cells being omitted.
   */
  snapshot(): ScreenSnapshot {
    const buffer = this.terminal.buffer.active;
    const lines: ScreenRow[] = [];
    // `getLine(y)` is an index into the whole buffer *including* scrollback,
    // so the visible row y is at `viewportY + y`. Absolute indexing here would
    // silently capture the top of scrollback instead of the screen -- the
    // viewport scrolls but the buffer's first line never changes.
    const top = buffer.viewportY;
    for (let y = 0; y < this._rows; y++) {
      const line = buffer.getLine(top + y);
      const text = line ? line.translateToString(true) : '';
      lines.push(text.padEnd(this._cols, ' '));
    }
    return {
      lines,
      cols: this._cols,
      rows: this._rows,
      buffer: buffer.type,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      hasScrollback: buffer.type === 'normal',
    };
  }

  dispose(): void {
    this.ops.dispose();
    this.terminal.dispose();
  }
}
