/**
 * A hosted terminal session: pty + screen model + classifier, as one object.
 *
 * This is the L0.4 session with the L0.1/L0.2 machinery attached. It owns the
 * pty, feeds every byte to the emulator, and reports each change as ordered
 * segments of `writing` or `drawing`.
 *
 * What it deliberately does not do: deliver, coalesce on a timer, or store
 * history. Those are L1/L3 and sit above this.
 */
import { PtySession } from './pty.js';
import { ScreenModel } from './screen.js';
import { classify, frameOf } from './classify.js';
import type { Segment } from './classify.js';
import type { SessionOptions } from './types.js';

/** One classified change to a session. */
export interface SessionUpdate {
  sessionId: string;
  /** Sequence number, per session, from 1. */
  seq: number;
  at: number;
  /** Byte range of the pty output this update covers. */
  fromByte: number;
  toByte: number;
  segments: Segment[];
  /** L1.3: bytes read in total; `bytesPending` is null when unknown, never 0. */
  io: {
    bytesRead: number;
    /** Bytes delivered but not yet parsed. null when not knowable. */
    bytesPending: number | null;
  };
  /** The screen after this update. Present whenever the change touched it. */
  screen: ReturnType<ScreenModel['snapshot']>;
}

/**
 * A terminal session that classifies its own output.
 *
 * Feeding is serialized: the emulator's write is async and `snapshot()` is
 * only meaningful after it resolves, so overlapping feeds would interleave
 * frames and corrupt both the diff and the byte offsets.
 */
export class TerminalSession {
  readonly id: string;
  readonly pty: PtySession;
  readonly screen: ScreenModel;

  private _seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private pendings = 0;

  constructor(id: string, options: SessionOptions = {}) {
    this.id = id;
    this.pty = new PtySession(id, options);
    this.screen = new ScreenModel(this.pty.cols, this.pty.rows);
  }

  /** Feed one chunk of pty output and classify it. Serialized. */
  feed(chunk: Buffer): Promise<SessionUpdate> {
    this.pendings++;
    const run = this.queue.then(async () => {
      const fromByte = this.screen.ops.bytesFed;
      const before = frameOf(this.screen);
      await this.screen.feed(chunk);
      const after = frameOf(this.screen);
      const ops = this.screen.ops.recorded.filter((o) => o.byteOffset >= fromByte);
      this.screen.ops.clear();

      this._seq++;
      const classified = classify({
        before,
        after,
        ops,
        fromByte,
        toByte: this.screen.ops.bytesFed,
      });

      return {
        sessionId: this.id,
        seq: this._seq,
        at: Date.now(),
        fromByte,
        toByte: classified.toByte,
        segments: classified.segments,
        io: {
          bytesRead: this.pty.bytesRead,
          // Bytes handed over but not yet through the parser. Zero here is a
          // real zero -- this call has drained what it was given -- so it is
          // genuinely 0, not null.
          bytesPending: 0,
        },
        screen: this.screen.snapshot(),
      } satisfies SessionUpdate;
    });

    // Keep the chain alive regardless of one feed failing.
    this.queue = run.then(
      () => {
        this.pendings--;
      },
      () => {
        this.pendings--;
      },
    );
    return run;
  }

  /** Feeds queued but not yet processed. */
  get pending(): number {
    return this.pendings;
  }

  get seq(): number {
    return this._seq;
  }

  /** Resize the pty and the screen together, so they never disagree. */
  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
    this.screen.resize(cols, rows);
  }

  /**
   * End the session: kill the process tree first, then release handles.
   *
   * `PtySession.dispose()` only releases listeners -- it does not kill. A
   * session that is disposed without being killed leaves its shell running
   * and the process never exits.
   */
  dispose(): void {
    this.pty.kill();
    this.screen.dispose();
    this.pty.dispose();
  }
}
