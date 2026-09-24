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
import { applyDelta, gridDelta, type GridDelta } from './delta.js';
import type { TextLine } from './text-log.js';
import type { ScreenSnapshot } from './screen.js';
import type { SessionOptions } from './types.js';
import { assertGridSize } from './types.js';
import { JobDetector, DEFAULT_JOB_POLICY, realClock, type JobClock, type JobCloseReason, type Job } from './jobs.js';

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
  /**
   * The deliveries this job stands for, as an inclusive range of `Delivery.seq`.
   * Pass to `SessionHistory.deliveries(from, to)` to read and play them back.
   *
   * `0..0` when grouping is off: nothing was swallowed, so there is nothing to
   * play back and the honest answer is an empty range rather than `1..1`.
   */
  rawFrom: number;
  rawTo: number;
}

/**
 * One raw delivery — the canonical unit of what a session produced.
 *
 * Emitted for every delivery, grouped or not, and recorded by the timeline.
 * A job is a *projection* over a run of these (`history.jobs`), which is why
 * nothing here carries a verdict: the presentation classifies the span from
 * the frames, and a verdict stored beside those frames would be a second
 * opinion that could drift from them.
 *
 * The screen is always supplied. Whether it is *kept* as a keyframe or encoded
 * as a delta against the previous delivery is the timeline's decision, not the
 * session's — encoding is what a store does.
 */
export interface Delivery {
  /** Monotonic per session, independent of the job sequence. */
  seq: number;
  /** The job this delivery was grouped into. */
  job: number;
  at: number;
  fromByte: number;
  toByte: number;
  /** Completed lines this delivery produced. */
  text: TextLine[];
  /** Rows the emulator reported the content moved. */
  scrolledRows: number;
  /** What changed on the grid, or `null` when a delta would not be smaller. */
  grid: GridDelta | null;
  /** The screen after this delivery. */
  screen: ScreenSnapshot;
}

/**
 * L1.3 — the facts that distinguish "quiet" from "not read yet".
 *
 * `bytesRead` is a watermark: monotonic, never reset, so comparing an earlier
 * value against the current one says whether anything arrived since.
 *
 * `bytesPending` is bytes the pty handed us that the parser has not finished
 * with. `null` when the number is not knowable, and 0 only when it is genuinely
 * zero — GOAL.md L1.3: unknown values are `null`, never `0`, because conflating
 * the two is a whole class of interaction bug.
 *
 * It is `null` rather than `0` when the parser has also been handed bytes that
 * did not come from this pty — a caller feeding buffers directly. The two
 * counters are then not a difference of the same thing, and reporting a clamped
 * zero would answer a question that was never asked with a number that looks
 * like an answer to it.
 */
export interface SessionIo {
  /** Total bytes read from the pty. Monotonic. */
  bytesRead: number;
  /** Bytes read but not yet parsed. `null` when not knowable. */
  bytesPending: number | null;
}

/**
 * What a session is doing, stated as facts.
 *
 * Three readings fall out of it, and they are the whole surface:
 *
 *   running, idle for x ms
 *   exit, more to read
 *   exit, drained
 *
 * There is deliberately no "settled". Whether a live program will produce more
 * output is not provable at a byte interface: it may emit at any future moment
 * for reasons entirely internal to it -- a timer, a network reply, a
 * background job -- and the only event that closes the set is termination. A
 * state claiming otherwise would be a judgement dressed as an observation.
 * `idleMs` is the measurement; what it means is the caller's call, and the
 * caller is the one that knows what it is driving.
 *
 * `exit` is the pty's own fact, not the session's queued `onExit`
 * notification. The queued one fires only after the feed has drained, so a
 * state built on it could never report "exit, more to read" -- the state would
 * be unreachable, and the window it exists to describe would be invisible.
 */
export interface SessionState {
  /** Whether the pty has reported the process gone. */
  running: boolean;
  /** Milliseconds since the pty last handed us a byte. `null` before the first. */
  idleMs: number | null;
  /**
   * Whether everything the pty handed us has been through the parser.
   *
   * `false` after an exit is the window worth waiting in: the last of the
   * output is still in the pipeline, and a read taken there is missing its
   * tail with nothing left to correct it.
   *
   * `null` when it cannot be known — see `pendingBytes`.
   */
  drained: boolean | null;
  /** Bytes the pty handed us that the parser has not finished with. */
  bytesPending: number | null;
  /** Exit info once the pty has reported the process gone, otherwise `null`. */
  exit: PtyExitInfo | null;
}

/**
 * Why a wait ended.
 *
 * `idle` and `timeout` are the difference the caller is judging: one says the
 * quiet period was observed, the other says it was not and time ran out.
 */
export type WaitReason =
  /**
   * Quiet for at least the interval asked for, and caught up.
   *
   * It does not mean the program has finished. Nothing observable can say
   * that, and a caller that reads `idle` as "done" is making a judgement this
   * value deliberately does not make.
   */
  | 'idle'
  /**
   * The process is gone and everything it wrote has been parsed.
   *
   * Waiting longer cannot change what is observable, so the wait ends early
   * rather than sitting out a quiet period that no longer means anything.
   */
  | 'exited'
  /** Gave up. `state` says what was seen; the caller decides what to do. */
  | 'timeout';

/** The result of a bounded wait. */
export interface WaitResult {
  reason: WaitReason;
  /** What was observed when the wait ended. */
  state: SessionState;
  /** Milliseconds the wait lasted, on the session's clock. */
  waitedMs: number;
}

/** What `waitForIdle` is asked for. Both bounds are required. */
export interface WaitOptions {
  /** How long the pty must have been quiet, in milliseconds. */
  idleMs: number;
  /** Stop waiting after this long, in milliseconds. */
  timeoutMs: number;
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
  private readonly clock: JobClock;

  private readonly listeners: ((update: SessionUpdate) => void)[] = [];
  private readonly resizeListeners: ((size: SessionSize) => void)[] = [];
  private readonly exitListeners: ((info: PtyExitInfo) => void)[] = [];
  /** Present unless the session was opened with `jobPolicy: false`. */
  private readonly jobs?: JobDetector;
  private readonly deliveryListeners: ((delivery: Delivery) => void)[] = [];
  /**
   * When the last byte arrived from the pty, or `null` before the first.
   *
   * Set on the pty's `data`, not on delivery: see `idleMs` for why the
   * difference is the whole point.
   */
  private _lastByteAt: number | null = null;
  /**
   * Waiters for the session changing, woken by `wake`.
   *
   * A waiter is woken rather than polling: the alternatives are a timer on a
   * fixed step, which is a sleep by another name, and a caller inventing its
   * own, which is what L1.2 exists to stop.
   */
  private readonly waiters: (() => void)[] = [];
  private _seq = 0;
  private _rawSeq = 0;
  private queue: Promise<void> = Promise.resolve();
  private pendings = 0;
  /**
   * Bytes the parser has finished with. Monotonic.
   *
   * Not `screen.ops.bytesFed`, which is counted *before* the write because op
   * handlers run during it and their offsets must already include the bytes
   * that produced them. That makes it a count of bytes handed over, so a chunk
   * mid-parse reads as done — the opposite of what "pending" asks.
   */
  private _bytesParsed = 0;

  constructor(id: string, options: SessionOptions = {}) {
    this.id = id;
    this.clock = options.clock ?? realClock;
    this.pty = new PtySession(id, options);
    this.screen = new ScreenModel(this.pty.cols, this.pty.rows);

    // Grouping is the default: where a delivery begins decides what the
    // classifier can see (CLASSIFIER.md §9.3), and the alternative is letting
    // the pty's buffer decide it. `false` is the opt-out.
    const policy = options.jobPolicy === false ? undefined : (options.jobPolicy ?? DEFAULT_JOB_POLICY);
    if (policy) {
      // Grouped at the boundary the program drew rather than the one the pty's
      // buffer happened to fill: `jobs.ts` has the reasoning, and
      // CLASSIFIER.md §9.3 has the measurement that makes it necessary.
      this.jobs = new JobDetector(
        policy,
        (job) => {
          void this.feed(job.bytes, job).then(this.deliver);
        },
        this.clock,
      );
    }

    this.pty.on('data', (chunk) => {
      // Stamped here, at the byte, before anything decides what to do with it.
      this._lastByteAt = this.clock.now();
      this.wake();
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
      this.wake();
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
   * Every delivery this session produces, in order. Returns an unsubscribe.
   *
   * This is the stream: the raw record from which a job is projected, and what
   * a timeline stores. Emitted whether or not output is being grouped — the
   * grouping decides what the *agent* is shown, not what happened.
   */
  onDelivery(listener: (delivery: Delivery) => void): () => void {
    return subscribe(this.deliveryListeners, listener);
  }

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
      // A job is classified over its whole span -- that is what makes a
      // repaint legible -- but it is *fed* one raw delivery at a time, because
      // the intermediate frames are the only place the swallowed states exist
      // and they cannot be recovered from merged bytes afterwards.
      const parts = job ? job.parts : [chunk];
      const jobStartSnap = this.screen.snapshot();
      const jobStart = frameOf(this.screen, jobStartSnap);

      let rawFrom = 0;
      let rawTo = 0;
      let scrolled = 0;
      let ops = 0;
      const text: TextLine[] = [];
      let afterSnap = jobStartSnap;
      let after = jobStart;
      let first = true;

      for (const part of parts) {
        // One witness, and it belongs to the model: `feed` takes the frames,
        // counts the ops and the scroll, judges the text, and hands all of it
        // back. The caller used to take its own before/after pair around this
        // call, which was a second witness to the same bytes.
        const partFromByte = this.screen.ops.bytesFed;
        const facts = await this.screen.feed(part);
        // Counted after the write resolves, unlike `bytesFed` — see the field.
        this._bytesParsed += part.length;
        // Dropped here, so a long session's op stream does not accumulate.
        this.screen.ops.clear();
        const beforeSnap = facts.before;
        afterSnap = facts.after;
        after = frameOf(this.screen, afterSnap);
        ops += facts.ops.length;
        scrolled += facts.scrolledRows;
        text.push(...facts.text);

        // Emitted for every delivery, grouped or not: this is the stream, and
        // the job is a projection over it. The hint is the emulator's own
        // scroll count, not the viewport difference -- `viewportY` saturates
        // once the scrollback ring is full and reports 0 while content keeps
        // moving (HISTORY.md 3).
        const seq = ++this._rawSeq;
        const delivery: Delivery = {
          seq,
          job: job ? this._seq + 1 : seq,
          at: Date.now(),
          fromByte: partFromByte,
          toByte: this.screen.ops.bytesFed,
          text: facts.text,
          scrolledRows: facts.scrolledRows,
          grid: gridDelta(beforeSnap, afterSnap, facts.scrolledRows),
          screen: afterSnap,
        };
        for (const listener of this.deliveryListeners) listener(delivery);
        if (job) {
          if (rawFrom === 0) rawFrom = seq;
          rawTo = seq;
        }
        first = false;
      }

      this._seq++;
      const classified = classify({
        before: jobStart,
        after,
        fromByte,
        toByte: this.screen.ops.bytesFed,
        scrolledBy: scrolled,
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
        grid: gridDelta(jobStartSnap, afterSnap, after.viewportY - jobStart.viewportY),
        // Not zero by construction. Everything this update covers is already
        // parsed, so what is left is what arrived *behind* it: bytes that came
        // in while it was being written, still held by the job detector or
        // queued behind this feed. That is the number L1.3 is asking for -- a
        // hardcoded 0 would make "nothing pending" unfalsifiable.
        io: { bytesRead: this.pty.bytesRead, bytesPending: this.pendingBytes() },
        screen: afterSnap,
        collapsed: job
          ? {
              chunks: job.chunks,
              intermediates: job.chunks > 1,
              ops,
              bytes: classified.toByte - fromByte,
              reason: job.reason,
              spanMs: job.closedAt - job.startedAt,
              rawFrom,
              rawTo,
            }
          : null,
      } satisfies SessionUpdate;
    });

    // Keep the chain alive regardless of one feed failing.
    this.queue = run.then(
      () => {
        this.pendings--;
        this.wake();
      },
      () => {
        this.pendings--;
        this.wake();
      },
    );
    return run;
  }

  /** Feeds queued but not yet processed. */
  get pending(): number {
    return this.pendings;
  }

  /**
   * Milliseconds since the pty last handed us a byte. `null` before the first.
   *
   * Measured from the *byte*, not from the last delivery. A program that never
   * pauses never opens a gap, so a job stays open until a cap closes it and no
   * delivery completes for seconds at a time — idle measured from the last
   * delivery would report "idle for 2560ms" while the program was flooding
   * output, which is the one thing this number must never do.
   *
   * It is a measurement and nothing else. It does not say the program has
   * finished; nothing observable can, and a caller deciding whether to act is
   * making a judgement this number deliberately does not make for it.
   */
  idleMs(at: number = this.clock.now()): number | null {
    if (this._lastByteAt === null) return null;
    return at - this._lastByteAt;
  }

  /**
   * What the session is doing, as facts. `at` is injectable so a caller can
   * ask about a moment it already has, rather than one this call invents.
   */
  state(at: number = this.clock.now()): SessionState {
    const exit = this.pty.exitInfo;
    return {
      running: exit === null,
      idleMs: this.idleMs(at),
      drained: this.drained(),
      bytesPending: this.pendingBytes(),
      exit,
    };
  }

  /**
   * Wait for the session to be quiet and caught up, or for the wait to end.
   *
   * Both halves are required, and the pairing is the point: quiet on its own
   * would return while a large feed was still being parsed, and a caller
   * reading the screen then would be reading one that is behind.
   *
   * It resolves on observation rather than on a fixed step: a byte arriving, a
   * feed finishing and the process exiting all wake it, and otherwise it
   * sleeps exactly until the moment the answer could change. A caller never
   * invents the interval, which is the whole of L1.2 -- guessing how long to
   * wait is how a driver silently succeeds at nothing.
   *
   * `idle` is not "finished". It says the quiet period was observed; whether
   * the program is done is not something a byte interface can establish, and
   * the result deliberately does not claim it.
   */
  async waitForIdle(options: WaitOptions): Promise<WaitResult> {
    const startedAt = this.clock.now();
    const deadline = startedAt + options.timeoutMs;

    for (;;) {
      const now = this.clock.now();
      const state = this.state(now);

      // Nothing more can arrive once the process is gone and its output has
      // been parsed, so a quiet period would no longer be evidence of
      // anything. Ending here rather than sitting it out.
      if (state.exit !== null && state.drained === true) {
        return { reason: 'exited', state, waitedMs: now - startedAt };
      }
      if (state.drained === true && state.idleMs !== null && state.idleMs >= options.idleMs) {
        return { reason: 'idle', state, waitedMs: now - startedAt };
      }
      if (now >= deadline) {
        return { reason: 'timeout', state, waitedMs: now - startedAt };
      }

      // Not drained, there is no moment to compute: only the pipeline knows
      // when it will finish, so this waits on the change rather than on a
      // clock. Drained, it waits exactly until the quiet period would elapse.
      const remaining =
        state.drained === true && state.idleMs !== null ? options.idleMs - state.idleMs : Infinity;
      await this.nextChange(Math.min(deadline, now + remaining));
    }
  }

  /**
   * Wake anything waiting on this session changing.
   *
   * Called wherever the facts a wait reads can change: a byte arriving, a feed
   * finishing, an exit. None of them decides whether the change matters -- the
   * waiter re-reads the state and decides for itself.
   */
  private wake(): void {
    if (this.waiters.length === 0) return;
    for (const wake of this.waiters.splice(0)) wake();
  }

  /**
   * Resolve on the session changing, or at `at` on the clock, whichever is
   * first. `at` is a bound, not a poll: nothing here wakes on a fixed step.
   */
  private nextChange(at: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: unknown;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.clock.clear(timer);
        const i = this.waiters.indexOf(finish);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      };
      this.waiters.push(finish);
      timer = this.clock.set(finish, Math.max(0, at - this.clock.now()));
    });
  }

  /**
   * Whether everything the pty handed us has been through the parser.
   *
   * A queued feed is answered first and settles it: bytes are in flight, so
   * the answer is no regardless of what the counters say. `null` only when the
   * counters cannot be compared at all.
   */
  private drained(): boolean | null {
    if (this.pendings > 0) return false;
    const pending = this.pendingBytes();
    if (pending === null) return null;
    return pending === 0;
  }

  /**
   * Bytes the pty handed us that the parser has not finished with.
   *
   * `null` when the parser has also been fed from somewhere other than the
   * pty — the two counters are then not a difference of the same thing.
   */
  private pendingBytes(): number | null {
    const read = this.pty.bytesRead;
    if (this._bytesParsed > read) return null;
    return read - this._bytesParsed;
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
    // Anything waiting is waiting on a session that will never change again.
    this.wake();
  }
}
