/**
 * The text log: every completed line the emulator produced, in order.
 *
 * CLASSIFIER.md §5 — the emulator feeds two sinks, and this is the first of
 * them. The screen grid is a *state*; a program emitting 10k lines overflows
 * any bounded scrollback, so the grid cannot be the record of what was written.
 * Success criterion 1 ("page back to any earlier part of that build") is
 * unsatisfiable from the grid alone.
 *
 * Verified against `@xterm/headless` v6.0.0 (HISTORY.md):
 *
 *  - Scrollback is lossy; the linefeed stream is not. Writing 200 lines into a
 *    5-row terminal with 50 lines of scrollback leaves 54 lines in the buffer,
 *    but `onLineFeed` fires 200 times and reading the completed line at each
 *    event recovers all 200, distinct.
 *  - The alt buffer has no scrollback, so content written there is destroyed on
 *    exit and is recoverable *only* here. A program that writes lines on the
 *    alt screen emits linefeeds exactly as on the normal screen (L0.1's
 *    corollary: the alt screen is not a verdict), so this sink does not filter
 *    by buffer -- it records which buffer each line came from and lets the
 *    timeline attribute it.
 *  - A CUP-drawn TUI emits *no* linefeeds at all (drawn, not written), so
 *    nothing is captured from one and nothing is polluted either. That content
 *    is the screen grid's to record.
 *
 * Byte stamps are delivery-coarse for the same reason `Op.byteOffset` is
 * (CLASSIFIER.md §9.3): `noteBytes` is called once per feed, before the write,
 * so every line completed by one delivery shares that delivery's offset. That
 * is an upper bound on resolution, not a precision the sink invents.
 */
import type { XtermTerminal } from './xterm.js';

/** One completed line, with where and when it was produced. */
export interface TextLine {
  /** Bytes fed to the emulator when this line completed. Delivery-coarse. */
  byte: number;
  /** Which buffer the line was written on. Context, not a verdict. */
  buffer: 'normal' | 'alternate';
  text: string;
}

/**
 * Records completed lines for one terminal.
 *
 * Append-only and never de-duplicated: two identical lines are two lines. A
 * build log that repeats "Compiling foo" is the common case, and a set-like log
 * silently loses exactly the repetition that says how far the build got.
 */
export class TextLog {
  private readonly lines: TextLine[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private _bytesFed = 0;

  constructor(private readonly terminal: XtermTerminal) {
    // Installed immediately, beside the op stream, so no line can complete
    // unobserved -- the same reason `EditRecord` installs in its constructor.
    this.disposables.push(this.terminal.onLineFeed(() => this.capture()));
  }

  /** Record that `n` bytes were handed to the emulator. */
  noteBytes(n: number): void {
    this._bytesFed += n;
  }

  /** Total bytes fed. Monotonic; the offset the next line will carry. */
  get bytesFed(): number {
    return this._bytesFed;
  }

  /** Take the lines captured so far and reset. Callers drain rather than accumulate. */
  drain(): TextLine[] {
    const out = this.lines.slice();
    this.lines.length = 0;
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  /**
   * Read the line a linefeed just completed.
   *
   * A linefeed moves the cursor down one row, so the line that finished is the
   * row above it. At the bottom of the buffer the content scrolls instead and
   * the cursor stays on the last row while `viewportY` advances -- the same
   * expression still names the completed row, which is why this is a read of
   * `viewportY + cursorY - 1` and not of a tracked row index.
   */
  private capture(): void {
    const buffer = this.terminal.buffer.active;
    if (buffer.cursorY < 1) return;
    const line = buffer.getLine(buffer.viewportY + buffer.cursorY - 1);
    if (!line) return;
    this.lines.push({
      byte: this._bytesFed,
      buffer: buffer.type,
      // Right-trimmed: this is text, not a cell grid. Padding is the grid's
      // business (`snapshot()` pads; this must not).
      text: line.translateToString(true),
    });
  }
}
