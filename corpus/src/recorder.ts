/**
 * The recording harness.
 *
 * A trace programme is a small script that writes terminal output. This runs it
 * two ways:
 *
 *  - **direct**: its output is fed straight into the headless emulator. Every
 *    byte the programme emitted is seen, exactly as emitted.
 *  - **pty**: it is run inside a real node-pty session and the pty's output is
 *    fed to the emulator. This is what a real session would see — and on
 *    Windows it is *not* the same bytes (see OPS.md "ConPTY rewrites").
 *
 * Both feeds produce the same `Trace` shape, so the classifier can be validated
 * against the idealised stream and then against the real one.
 *
 * Design rules this follows, from CLASSIFIER.md §3.1:
 *  - one parser, one truth: everything recorded comes out of the emulator, not
 *    from a second scan of the bytes;
 *  - control ops are intercepted with `return false` so the emulator still
 *    applies them and we only observe;
 *  - `write()` is always awaited before `buffer` is read.
 */
import { EventEmitter } from 'node:events';
import { createTerminal } from '../../src/xterm.js';
import type { XtermTerminal } from '../../src/xterm.js';
import type { Op, Frame, Trace, SegmentExpectation } from './types.js';

/** Control ops we intercept. `final` is the CSI/ESC terminating byte. */
const CSI_OPS: ReadonlyArray<readonly [string, string]> = [
  ['CUP', 'H'], // cursor position
  ['EL', 'K'], // erase in line
  ['ED', 'J'], // erase in display
  ['CUU', 'A'], // cursor up
  ['CUD', 'B'], // cursor down
  ['CUF', 'C'], // cursor forward
  ['CUB', 'D'], // cursor back
  ['IL', 'L'], // insert line
  ['DL', 'M'], // delete line
  ['DCH', 'P'], // delete character
  ['ICH', '@'], // insert character
  ['SU', 'S'], // scroll up
  ['SD', 'T'], // scroll down
  ['SGR', 'm'], // select graphic rendition
] as const;

const ESC_OPS: ReadonlyArray<readonly [string, string]> = [
  ['DECSC', '7'], // save cursor
  ['DECRC', '8'], // restore cursor
  ['RIS', 'c'], // full reset
] as const;

/** Non-CSI/ESC events worth stamping: they change the frame structurally. */
type StructuralEvent = 'linefeed' | 'scroll' | 'resize' | 'bufferChange' | 'titleChange';

export interface RecorderOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
  /** Called after the programme ends; use to send input (pty mode only). */
  drive?: (io: { write: (s: string) => void }) => Promise<void> | void;
}

/**
 * Feeds bytes into a headless terminal and records what the emulator saw.
 *
 * `bytesIn` accumulates every byte handed over, so an op's `offset` is a real
 * byte offset into the programme's output — the same coordinate space the
 * classifier is specified in (CLASSIFIER.md §3.1).
 */
export class Recorder extends EventEmitter {
  readonly terminal: XtermTerminal;
  readonly ops: Op[] = [];
  readonly frames: Frame[] = [];
  readonly textLog: string[] = [];

  private bytesIn = 0;
  private seq = 0;
  private disposables: Array<{ dispose(): void }> = [];
  private pendingText: string | null = null;
  private capturedFrames = 0;

  constructor(opts: RecorderOptions = {}) {
    super();
    // `cols`/`rows` are constructor-only in xterm; sizing after construction
    // goes through `resize`. Typings omit them from ITerminalOptions, so pass
    // them explicitly rather than widening the shared options type.
    this.terminal = createTerminal({
      scrollback: opts.scrollback ?? 1000,
    } as Parameters<typeof createTerminal>[0]);
    this.terminal.resize(opts.cols ?? 80, opts.rows ?? 24);
    this.installTaps();
  }

  private installTaps(): void {
    const t = this.terminal;

    for (const [name, final] of CSI_OPS) {
      this.disposables.push(
        t.parser.registerCsiHandler(
          { final },
          (params) => {
            this.ops.push({
              seq: this.seq++,
              kind: 'csi',
              name,
              final,
              params: flattenParams(params),
              offset: this.bytesIn,
              cursorY: t.buffer.active.cursorY,
              cursorX: t.buffer.active.cursorX,
              buffer: t.buffer.active.type,
            });
            return false; // observe only — the emulator still applies the op
          },
        ),
      );
    }

    for (const [name, final] of ESC_OPS) {
      this.disposables.push(
        t.parser.registerEscHandler({ final }, () => {
          this.ops.push({
            seq: this.seq++,
            kind: 'esc',
            name,
            final,
            params: [],
            offset: this.bytesIn,
            cursorY: t.buffer.active.cursorY,
            cursorX: t.buffer.active.cursorX,
            buffer: t.buffer.active.type,
          });
          return false;
        }),
      );
    }

    // ALT-SCREEN enter/exit are CSI with `?` prefix; hook them explicitly so a
    // trace shows the boundary even though they are not "drawing" ops.
    for (const [name, final] of [
      ['ALT_ENTER', 'h'],
      ['ALT_EXIT', 'l'],
    ] as const) {
      this.disposables.push(
        t.parser.registerCsiHandler(
          { prefix: '?', final },
          (params) => {
            const mode = flattenParams(params)[0];
            if (mode !== 1049 && mode !== 47 && mode !== 1047) return false;
            const wanted = name === 'ALT_ENTER' ? 'h' : 'l';
            if (final !== wanted) return false;
            this.ops.push({
              seq: this.seq++,
              kind: 'mode',
              name,
              final,
              params: [mode],
              offset: this.bytesIn,
              cursorY: t.buffer.active.cursorY,
              cursorX: t.buffer.active.cursorX,
              buffer: t.buffer.active.type,
            });
            return false;
          },
        ),
      );
    }

    t.onLineFeed(() => this.note('linefeed'));
    t.onScroll(() => this.note('scroll'));
    t.onResize(() => this.note('resize'));
    t.onTitleChange(() => this.note('titleChange'));
    t.buffer.onBufferChange?.(() => this.note('bufferChange'));
  }

  private note(kind: StructuralEvent): void {
    this.ops.push({
      seq: this.seq++,
      kind: 'event',
      name: kind.toUpperCase(),
      final: '',
      params: [],
      offset: this.bytesIn,
      cursorY: this.terminal.buffer.active.cursorY,
      cursorX: this.terminal.buffer.active.cursorX,
      buffer: this.terminal.buffer.active.type,
    });
  }

  /** Feed bytes. Resolves once the emulator has parsed them. */
  write(data: string | Buffer): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.bytesIn += buf.length;
    return new Promise<void>((resolve) => {
      this.terminal.write(buf.toString('utf8'), () => resolve());
    });
  }

  /**
   * Split a write into small chunks so the emulator sees the programme's output
   * arrive over time, the way a pty delivers it, rather than as one blob.
   */
  async writeChunked(data: string | Buffer, chunkSize = 64, gapMs = 0): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (let i = 0; i < buf.length; i += chunkSize) {
      await this.write(buf.subarray(i, i + chunkSize));
      if (gapMs > 0) await sleep(gapMs);
    }
  }

  /** Snapshot the current screen. */
  capture(label?: string): Frame {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.terminal.rows; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    const frame: Frame = {
      index: this.capturedFrames++,
      label,
      at: this.bytesIn,
      cursorY: buf.cursorY,
      cursorX: buf.cursorX,
      buffer: buf.type,
      viewportY: buf.viewportY,
      lines,
    };
    this.frames.push(frame);
    return frame;
  }

  /** Drain the completed lines currently above the cursor into the text log. */
  drainTextLog(): void {
    const buf = this.terminal.buffer.active;
    for (let y = 0; y < buf.cursorY; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.length > 0 && !this.textLog.includes(text)) this.textLog.push(text);
    }
  }

  get bytesWritten(): number {
    return this.bytesIn;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.terminal.dispose();
  }
}

function flattenParams(params: (number | number[])[]): number[] {
  const out: number[] = [];
  for (const p of params) {
    if (Array.isArray(p)) out.push(...p);
    else out.push(p);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build the final trace object. */
export function buildTrace(meta: {
  id: string;
  category: string;
  summary: string;
  feed: 'direct' | 'pty';
  cols: number;
  rows: number;
  platform: string;
  expectations: SegmentExpectation[];
}): Omit<Trace, 'ops' | 'frames' | 'textLog' | 'bytes' | 'raw'> {
  return {
    version: 1,
    id: meta.id,
    category: meta.category,
    summary: meta.summary,
    feed: meta.feed,
    cols: meta.cols,
    rows: meta.rows,
    platform: meta.platform,
    recordedAt: new Date().toISOString(),
    expectations: meta.expectations,
  };
}
