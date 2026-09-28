/**
 * The text log: every line the screen gained, in order.
 *
 * The emulator feeds two sinks, and this is the first of
 * them. The screen grid is a *state*; a program emitting 10k lines overflows
 * any bounded scrollback, so the grid cannot be the record of what was written.
 * Success criterion 1 ("page back to any earlier part of that build") is
 * unsatisfiable from the grid alone.
 *
 * Capture is **two stages**, and keeping them apart is the whole design.
 *
 * 1. **Trigger — when is a line complete?** A per-line signal, because a line
 *    can be born and scroll away inside one feed, before any before/after
 *    comparison exists. Verified against `@xterm/headless` v6.0.0: writing 200
 *    lines into a 5-row terminal with 10 lines of scrollback leaves 15 lines in
 *    the buffer, while 200 linefeeds fire. A frame diff of that feed sees five
 *    rows; the other 195 were never in any frame. So the trigger cannot be the
 *    diff.
 *
 *    There are two, because one is not enough. `onLineFeed` covers a program
 *    that terminates its lines normally. Windows ConPTY does not always:
 *
 *        echo RAW-CHECK<CR><LF><ESC>[?25lRAW-CHECK<ESC>[7;1H E:\agent-term>
 *                                                                 ^ no linefeed
 *
 *    — the output line is terminated by absolute cursor positioning, and the
 *    linefeed count for that feed is zero. So a second pass looks at rows the
 *    cursor has left, and anything the linefeed pass already took is skipped,
 *    so the two cannot double-count.
 *
 * 2. **Judgement — is it text or a repaint?** The diff, per row, through
 *    `rowDiff` in `classify.ts`: content arriving where there was none is text;
 *    an erase or an overwrite is a repaint and is dropped. A program drawing a
 *    frame onto blank cells is therefore recorded as text — it is
 *    indistinguishable from appending, and the agent sees the full draw either
 *    way. A frame that repaints rows it already wrote is not recorded.
 *
 * Lines wait in `pending` until the judgement is available, so nothing is
 * appended that the diff might contradict. `drain` includes anything still
 * pending: a caller that never judged gets text rather than silence, because
 * losing a line is the failure this log exists to prevent.
 *
 * Byte stamps are delivery-coarse for the same reason `Op.byteOffset` is:
 * `noteBytes` is called once per feed, before the write,
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

/** A line whose trigger fired, waiting on the diff to say whether it is text. */
interface PendingLine extends TextLine {
  /** Buffer row it occupies, so the judgement can find it in the frames. */
  row: number;
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
  private pending: PendingLine[] = [];
  /** Buffer rows already taken this feed, so the two triggers cannot overlap. */
  private readonly takenRows = new Set<number>();
  private readonly disposables: { dispose(): void }[] = [];
  private _bytesFed = 0;

  constructor(private readonly terminal: XtermTerminal) {
    // Installed immediately, beside the op stream, so no line can complete
    // unobserved -- the same reason `EditRecord` installs in its constructor.
    this.disposables.push(this.terminal.onLineFeed(() => this.captureLinefeed()));
  }

  /** Record that `n` bytes were handed to the emulator. */
  noteBytes(n: number): void {
    this._bytesFed += n;
  }

  /** Total bytes fed. Monotonic; the offset the next line will carry. */
  get bytesFed(): number {
    return this._bytesFed;
  }

  /**
   * Take the lines captured so far and reset.
   *
   * Anything still pending is included: a caller that never ran the judgement
   * gets the lines rather than losing them.
   */
  drain(): TextLine[] {
    const out = this.lines.slice();
    for (const p of this.pending) out.push({ byte: p.byte, buffer: p.buffer, text: p.text });
    this.lines.length = 0;
    this.pending.length = 0;
    this.takenRows.clear();
    return out;
  }

  /**
   * Complete the current feed.
   *
   * `isText` is handed each candidate's buffer row and returns whether the diff
   * says the row's content arrived rather than replaced. Called once per feed,
   * after the write and after `captureLeftRows`.
   */
  resolve(isText: (row: number) => boolean): void {
    for (const p of this.pending) {
      if (isText(p.row)) this.lines.push({ byte: p.byte, buffer: p.buffer, text: p.text });
    }
    this.pending.length = 0;
    this.takenRows.clear();
  }

  /**
   * Take the rows the cursor has left that no linefeed accounted for.
   *
   * The ConPTY case, and any program that ends a line by positioning rather
   * than by a linefeed. Rows at or below the cursor are still being written, so
   * they are not candidates: a prompt the cursor is sitting on is not a
   * completed line.
   */
  captureLeftRows(cursorRow: number, viewportTop: number, changed: (y: number) => boolean): void {
    for (let y = 0; y < cursorRow; y++) {
      const row = viewportTop + y;
      if (this.takenRows.has(row)) continue;
      if (!changed(y)) continue;
      const line = this.terminal.buffer.active.getLine(row);
      if (!line) continue;
      this.take(row, line.translateToString(true));
    }
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
  private captureLinefeed(): void {
    const buffer = this.terminal.buffer.active;
    if (buffer.cursorY < 1) return;
    const row = buffer.viewportY + buffer.cursorY - 1;
    const line = buffer.getLine(row);
    if (!line) return;
    this.take(row, line.translateToString(true));
  }

  /** Queue a line for judgement, unless its row is already queued this feed. */
  private take(row: number, text: string): void {
    this.takenRows.add(row);
    this.pending.push({
      byte: this._bytesFed,
      buffer: this.terminal.buffer.active.type,
      text,
      row,
    });
  }
}
