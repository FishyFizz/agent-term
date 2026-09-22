/**
 * The recording harness.
 *
 * A corpus programme is a small script that writes terminal output. This runs
 * it two ways:
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
 *
 * The emulator, the op stream and the byte counter are the repo's own
 * `ScreenModel`, not a parallel copy. A trace is replayed through the same
 * classifier that reads a live session, so if the two recorders disagreed
 * about what an op is, the corpus would be measuring something the server
 * never produces. What is corpus-specific here is only the *framing*:
 * capturing a labelled `Frame` at points of interest, and draining a text log.
 */
import { ScreenModel } from '../../src/screen.js';
import type { Op } from '../../src/edit-record.js';
import type { Frame } from './types.js';

export interface RecorderOptions {
  cols?: number;
  rows?: number;
}

/**
 * Feeds bytes into `ScreenModel` and captures labelled frames along the way.
 *
 * Ops, byte offsets and screen state come from the model. This adds the frame
 * list, which is the corpus's own view of the journey.
 */
export class Recorder {
  readonly screen: ScreenModel;

  private readonly frames: Frame[] = [];
  private readonly textLog: string[] = [];

  constructor(opts: RecorderOptions = {}) {
    this.screen = new ScreenModel(opts.cols ?? 80, opts.rows ?? 24);
  }

  get cols(): number {
    return this.screen.cols;
  }

  get rows(): number {
    return this.screen.rows;
  }

  /** Feed bytes. Resolves once the emulator has parsed them. */
  write(data: string | Buffer): Promise<void> {
    return this.screen.feed(data);
  }

  /**
   * Split a write into small chunks so the emulator sees the programme's output
   * arrive over time, the way a pty delivers it, rather than as one blob.
   */
  async writeChunked(data: string | Buffer, chunkSize = 64): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (let i = 0; i < buf.length; i += chunkSize) await this.write(buf.subarray(i, i + chunkSize));
  }

  /** Snapshot the current screen and append it to the trace's frames. */
  capture(label?: string): Frame {
    const snap = this.screen.snapshot();
    const frame: Frame = {
      index: this.frames.length,
      label,
      at: this.screen.ops.bytesFed,
      cursorY: snap.cursorY,
      cursorX: snap.cursorX,
      buffer: snap.buffer,
      viewportY: this.screen.terminal.buffer.active.viewportY,
      // Right-trimmed. `snapshot()` pads rows to the full width so a caller
      // can index a cell, but a trace is read by eye.
      lines: snap.lines.map((l) => l.replace(/\s+$/, '')),
    };
    this.frames.push(frame);
    return frame;
  }

  /** Drain the completed lines currently above the cursor into the text log. */
  drainTextLog(): void {
    const buf = this.screen.terminal.buffer.active;
    for (let y = 0; y < buf.cursorY; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.length > 0 && !this.textLog.includes(text)) this.textLog.push(text);
    }
  }

  get bytesWritten(): number {
    return this.screen.ops.bytesFed;
  }

  /** Everything recorded, for `assemble` to fold into a `Trace`. */
  recorded(): { ops: readonly Op[]; frames: Frame[]; textLog: string[] } {
    return { ops: this.screen.ops.recorded, frames: this.frames, textLog: this.textLog };
  }

  dispose(): void {
    this.screen.dispose();
  }
}
