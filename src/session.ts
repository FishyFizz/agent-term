/**
 * A hosted terminal session: pty + screen model + classifier, as one object.
 *
 * This is the L0.4 session with the L0.1/L0.2 machinery attached. It owns the
 * pty, feeds every byte to the emulator, and reports each change as ordered
 * segments of `writing` or `drawing`.
 *
 * What it deliberately does not do: deliver, coalesce on a timer, or store
 * history. Those are L1/L3 and sit above this.
 *
 * Output is classified as it arrives: the pty's `data` is wired straight to
 * `feed` in the constructor. Otherwise a caller could build a session, never
 * subscribe, and have a classifier that silently never runs -- a mistake
 * possible by omission, which is the kind worth removing.
 */
import { PtySession, type PtyExitInfo } from './pty.js';
import { ScreenModel } from './screen.js';
import { classify, frameOf } from './classify.js';
import type { Segment } from './classify.js';
import { gridDelta, type GridDelta } from './delta.js';
import type { TextLine } from './text-log.js';
import type { SessionOptions } from './types.js';
import { assertGridSize } from './types.js';
import { JobDetector, type JobCloseReason, type Job } from './jobs.js';

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
  io: SessionIo;
  /**
   * Completed lines produced by this delivery, in order.
   *
   * The screen grid alone is not a record of what was written: it holds the
   * viewport, so lines that scrolled out are in no snapshot. These are those
   * lines, and they are the only record of alt-screen content, which is
   * destroyed on exit (CLASSIFIER.md §5).
   */
  text: TextLine[];
  /**
   * What this delivery changed on the grid, or `null` when nothing changed or
   * a delta would not have been smaller than the screen itself.
   *
   * Storing the delta rather than only the screen is what keeps a repainting
   * TUI affordable: 60fps of full grids is ~17 MB/minute at 120x40, where the
   * change is usually a few cells. The screen is still reported whole, because
   * a caller that wants the state should not have to reconstruct it.
   */
  grid: GridDelta | null;
  /** The screen after this update. Present whenever the change touched it. */
  screen: ReturnType<ScreenModel['snapshot']>;
  /**
   * What was merged into this update, or `null` when nothing was.
   *
   * `null` is the honest value when the session is not grouping output into
   * jobs, or when this update came from a direct `feed` — GOAL.md L1.3: an
   * unknown is `null`, never a fabricated `1`.
   *
   * `chunks > 1` is the signal a consumer acts on: the screen it is looking at
   * is the net effect of that many raw deliveries, so *intermediate states
   * existed and were not shown*. A selector whose highlight moved and moved
   * back is the case that matters — it nets to no visible change at all, and
   * the count is the only evidence anything happened.
   */
  collapsed: CollapsedInfo | null;
}

/**
 * What one delivered job swallowed.
 *
 * Same meaning whatever the granularity: a job is one update, and this says
 * how much raw output it stands for, so a consumer can decide to go back and
 * read the intermediates rather than being told about them.
 */
export interface CollapsedInfo {
  /** Raw pty deliveries merged into this update. */
  chunks: number;
  /**
   * Whether states existed that this update does not show.
   *
   * Redundant with `chunks > 1`, and deliberately so: it is the one field a
   * consumer has to act on without reading documentation. When it is true the
   * screen being shown is a net effect, and states between it and the previous
   * update were seen and then collapsed away.
   */
  intermediates: boolean;
  /** Ops recorded across the merged span. */
  ops: number;
  /** Bytes merged. Equal to `toByte - fromByte`; kept so it need not be derived. */
  bytes: number;
  /** Why the job stopped accumulating — which is why the granularity changed. */
  reason: JobCloseReason;
  /** Milliseconds between the first and last delivery in the job. */
  spanMs: number;
}

/**
 * L1.3 — the facts that distinguish "quiet" from "not read yet".
 *
 * `bytesRead` is a watermark: monotonic, never reset, so comparing an earlier
 * value against the current one says whether anything arrived since.
 *
 * `bytesPending` is bytes read but not yet through the parser. `null` when the
 * number is not knowable, and 0 only when it is genuinely zero — GOAL.md L1.3:
 * unknown values are `null`, never `0`, because conflating the two is a whole
 * class of interaction bug.
 */
export interface SessionIo {
  /** Total bytes read from the pty. Monotonic. */
  bytesRead: number;
  /** Bytes read but not yet parsed. `null` when not knowable. */
  bytesPending: number | null;
}

/** A grid size a session was resized to. */
export interface SessionSize {
  cols: number;
  rows: number;
}

/** Add `listener` to `list`, and return the function that takes it back out. */
function subscribe<T>(list: T[], listener: T): () => void {
  list.push(listener);
  return () => {
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  };
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

  private readonly listeners: ((update: SessionUpdate) => void)[] = [];
  private readonly resizeListeners: ((size: SessionSize) => void)[] = [];
  private readonly exitListeners: ((info: PtyExitInfo) => void)[] = [];
  /** Present only when the session was opened with a `jobPolicy`. */
  private readonly jobs?: JobDetector;
  private _seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private pendings = 0;

  constructor(id: string, options: SessionOptions = {}) {
    this.id = id;
    this.pty = new PtySession(id, options);
    this.screen = new ScreenModel(this.pty.cols, this.pty.rows);

    if (options.jobPolicy) {
      // Grouped at the boundary the program drew rather than the one the pty's
      // buffer happened to fill: `jobs.ts` has the reasoning, and
      // CLASSIFIER.md §9.3 has the measurement that makes it necessary.
      this.jobs = new JobDetector(options.jobPolicy, (job) => {
        void this.feed(job.bytes, job).then(this.deliver);
      });
    }

    this.pty.on('data', (chunk) => {
      if (this.jobs) {
        this.jobs.push(chunk);
        return;
      }
      void this.feed(chunk).then(this.deliver);
    });
    // Queued, not fired directly: the last bytes of a session are delivered
    // before it exits, and a caller told "it exited" while an update is still
    // in the queue would have to guess whether to wait.
    this.pty.on('exit', (info) => {
      // Flushed first, for the same reason as a resize and more urgently:
      // alt-screen content is destroyed when the program leaves it (L0.1), so
      // the last live frame has to be classified before the exit is reported.
      this.jobs?.flush();
      this.enqueue(() => {
        for (const listener of this.exitListeners) listener(info);
      });
    });
  }

  /**
   * Subscribe to classified output. Returns an unsubscribe function.
   *
   * Every change produces an update, in the order the pty produced it.
   */
  onUpdate(listener: (update: SessionUpdate) => void): () => void {
    return subscribe(this.listeners, listener);
  }

  /**
   * Subscribe to resizes. Returns an unsubscribe function.
   *
   * Fires *after* any delivery already in flight, so a listener that records
   * position in the update stream never has to decide whether a boundary came
   * before or after the update it is looking at.
   */
  onResize(listener: (size: SessionSize) => void): () => void {
    return subscribe(this.resizeListeners, listener);
  }

  /** Subscribe to the process exiting. Returns an unsubscribe function. */
  onExit(listener: (info: PtyExitInfo) => void): () => void {
    return subscribe(this.exitListeners, listener);
  }

  /** Hand one update to every listener. */
  private readonly deliver = (update: SessionUpdate): void => {
    for (const listener of this.listeners) listener(update);
  };

  /**
   * Run `task` after everything already queued.
   *
   * Same shape as `feed`'s keep-alive: the chain is reassigned to a promise
   * that cannot reject, so one throwing listener cannot strand the deliveries
   * behind it.
   */
  private enqueue(task: () => void): void {
    const run = this.queue.then(() => {
      task();
    });
    this.queue = run.then(
      () => {},
      () => {},
    );
  }

  /**
   * Feed one chunk of pty output and classify it. Serialized.
   *
   * `job` may carry the group this chunk belongs to, in which case the update
   * reports what was merged. A caller feeding bytes directly gets
   * `collapsed: null`, which is correct: nothing was merged, and claiming `1`
   * would say otherwise (GOAL.md L1.3).
   */
  feed(chunk: Buffer, job?: Job): Promise<SessionUpdate> {
    this.pendings++;
    const run = this.queue.then(async () => {
      const fromByte = this.screen.ops.bytesFed;
      // Snapshotted once and used for both the classifier's frame and the grid
      // delta: the frame trims the padded rows the delta needs, so taking two
      // snapshots would do the same work twice to get the same grid.
      const beforeSnap = this.screen.snapshot();
      const before = frameOf(this.screen, beforeSnap);
      await this.screen.feed(chunk);
      const afterSnap = this.screen.snapshot();
      const after = frameOf(this.screen, afterSnap);
      const ops = this.screen.ops.recorded.filter((o) => o.byteOffset >= fromByte);
      this.screen.ops.clear();
      // Drained in the same window as the ops, so each line belongs to exactly
      // one update and none is counted twice.
      const text = this.screen.text.drain();

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
        text,
        // The viewport delta is exactly the scroll until the scrollback ring
        // saturates; past that it is useless, and the encoder falls back to
        // searching for a shift it can verify (see `delta.ts`).
        grid: gridDelta(beforeSnap, afterSnap, after.viewportY - before.viewportY),
        // Zero is a real zero here: this call has drained what it was given.
        // It is per-update, so it says *this* update is parsed, not that the
        // pty is quiet -- `bytesRead` is the watermark that answers that.
        io: { bytesRead: this.pty.bytesRead, bytesPending: 0 },
        screen: afterSnap,
        collapsed: job
          ? {
              chunks: job.chunks,
              intermediates: job.chunks > 1,
              ops: ops.length,
              bytes: classified.toByte - fromByte,
              reason: job.reason,
              spanMs: job.closedAt - job.startedAt,
            }
          : null,
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

  /**
   * Resize the pty and the screen together, so they never disagree.
   *
   * Validated once here, before either is touched: if each half validated on
   * its own, one could accept the size and the other throw, leaving a session
   * with a pty at one size and a screen at another.
   *
   * The resize itself is applied synchronously -- the program inside must be
   * told promptly -- but the *notification* is queued. A caller recording the
   * boundary needs it ordered against the output, and a resize that overtook a
   * delivery in flight would be recorded as having happened before output that
   * was produced at the old size.
   *
   * A pending job is flushed first, because a job may not straddle a boundary
   * that freezes history: everything before a resize belongs to the old epoch
   * at the old size (HISTORY.md §2). The job is closed but its bytes are still
   * fed through the queue, so they may land after the resize applies -- which
   * is the case `history.ts` already handles by deriving epochs from the size
   * a record reports rather than trusting the resize event.
   */
  resize(cols: number, rows: number): void {
    assertGridSize(cols, rows);
    this.jobs?.flush();
    this.pty.resize(cols, rows);
    this.screen.resize(cols, rows);
    this.enqueue(() => {
      for (const listener of this.resizeListeners) listener({ cols, rows });
    });
  }

  /**
   * End the session.
   *
   * `pty.dispose()` kills the process tree itself, so there is no separate
   * kill to remember here.
   */
  dispose(): void {
    this.listeners.length = 0;
    this.resizeListeners.length = 0;
    this.exitListeners.length = 0;
    this.jobs?.dispose();
    this.screen.dispose();
    this.pty.dispose();
  }
}
