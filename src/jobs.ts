/**
 * Job boundaries — where one unit of program intent ends and the next begins.
 *
 * CLASSIFIER.md §9.3 measured that the verdict depends on where deliveries
 * begin: the same corpus scores 20/23 replayed per drawing op and 17/23
 * replayed in 64-byte chunks. A chunk boundary lands wherever the pty buffer
 * filled, which has nothing to do with what the program meant, so the
 * classifier is being asked its question at boundaries the program never drew.
 * A job is the missing unit: the run of output a program emits as one act.
 *
 * The signal available without a second parser is silence. A program painting
 * a menu writes its rows back to back and then waits; the gap between bursts
 * is the boundary. Measured on `cli.menu-selector`: 0ms between the ops of one
 * draw, 15–16ms between draws.
 *
 * Silence is a fallback, not the truth. `CSI ?2026 h/l` is a program declaring
 * its own frame, and it needs no special case here: a frame is written in one
 * burst, so no gap opens inside it. What the detector does need is a cap. A
 * firehose never goes quiet, so without one the job grows without bound and
 * "bounded delivery" (GOAL.md L1.1) is violated by the thing meant to provide
 * it.
 *
 * The numbers are policy, and this module takes them as arguments: L0 owns the
 * fact that output has boundaries, L1/L3 owns how long a quiet period is.
 */
import type { JobPolicy } from './types.js';

/**
 * The policy a session uses when it is not given one.
 *
 * Grouping is the default because where a delivery begins decides what the
 * classifier can see (CLASSIFIER.md §9.3), and the alternative is to let a
 * pty buffer decide that. Measured on the corpus: every threshold from 20ms to
 * 70ms separates the two pauses a real programme makes — 6ms within an act,
 * 80–120ms between acts — and scores identically across that range. 50ms sits
 * in the middle of it.
 *
 * The caps exist for the pathological case GOAL.md calls out: a program that
 * never goes quiet. Without them a firehose holds one job open forever, and
 * the thing meant to provide bounded delivery would be the thing violating it.
 * They are set well above what any corpus programme writes, so they do not
 * change the measured score.
 */
export const DEFAULT_JOB_POLICY: JobPolicy = {
  gapMs: 50,
  maxBytes: 64 * 1024,
  maxChunks: 256,
};

/** Why a job stopped accumulating. Reported so a consumer can read the granularity. */
export type JobCloseReason =
  /** The pty went quiet for the policy's gap. */
  | 'gap'
  /** The byte cap was reached — a program that never pauses. */
  | 'bytes'
  /** The delivery-count cap was reached. */
  | 'chunks'
  /** Something forced it: a resize, an exit, or a dispose. */
  | 'flush';

/** One raw delivery: bytes that arrived together, and when. */
export interface Arrival {
  bytes: Buffer;
  at: number;
}

/** A run of raw deliveries grouped into one unit of intent. */
export interface Job {
  /** The merged bytes, in arrival order. */
  bytes: Buffer;
  /**
   * The raw deliveries themselves, in arrival order.
   *
   * Kept because the merged bytes cannot be un-merged. A job is classified
   * over its whole span, which is what makes a repaint legible; the parts are
   * what let a caller who saw only the net effect go back and read the
   * intermediate states it swallowed.
   */
  parts: Buffer[];
  /** How many raw deliveries were merged. 1 means nothing was coalesced. */
  chunks: number;
  /** When the first delivery arrived. */
  startedAt: number;
  /** When the job closed. */
  closedAt: number;
  reason: JobCloseReason;
}

/**
 * Group recorded arrivals into jobs by gap.
 *
 * The pure form, used to replay a trace at job granularity: a trace records
 * when each op ran, so the gaps are recoverable even though the raw bytes
 * carry no timing of their own.
 *
 * A cap closes a job mid-run rather than merging without bound, but the cap is
 * checked *before* appending, so a single arrival larger than the cap becomes a
 * job of its own instead of being split — splitting a delivery would invent a
 * boundary the program never drew.
 */
export function groupByGap(arrivals: readonly Arrival[], policy: JobPolicy): Job[] {
  const jobs: Job[] = [];
  let parts: Buffer[] = [];
  let chunks = 0;
  let bytes = 0;
  let startedAt = 0;
  let lastAt = 0;

  const close = (at: number, reason: JobCloseReason): void => {
    if (chunks === 0) return;
    jobs.push({ bytes: Buffer.concat(parts), parts, chunks, startedAt, closedAt: at, reason });
    parts = [];
    chunks = 0;
    bytes = 0;
  };

  for (const a of arrivals) {
    const gap = chunks === 0 ? 0 : a.at - lastAt;
    const overBytes = policy.maxBytes !== undefined && bytes + a.bytes.length > policy.maxBytes;
    const overChunks = policy.maxChunks !== undefined && chunks + 1 > policy.maxChunks;

    if (chunks > 0 && (gap >= policy.gapMs || overBytes || overChunks)) {
      close(lastAt, overBytes ? 'bytes' : overChunks ? 'chunks' : 'gap');
    }

    if (chunks === 0) startedAt = a.at;
    parts.push(a.bytes);
    chunks++;
    bytes += a.bytes.length;
    lastAt = a.at;

    // Closed as soon as it is full, rather than waiting for a gap: the cap
    // exists for programs that never go quiet, and a cap that only takes
    // effect on the *next* arrival lets a firehose hold a job open forever.
    const fullBytes = policy.maxBytes !== undefined && bytes >= policy.maxBytes;
    const fullChunks = policy.maxChunks !== undefined && chunks >= policy.maxChunks;
    if (fullBytes || fullChunks) close(lastAt, fullBytes ? 'bytes' : 'chunks');
  }
  // The tail is not a gap -- nothing went quiet, the arrivals simply ran out.
  close(lastAt, 'flush');
  return jobs;
}

/** The clock and timer a live detector uses. Injected so tests need no sleeping. */
export interface JobClock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The real clock. `now` is `Date.now`, in the same millisecond space as `Op.at`. */
export const realClock: JobClock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A fake clock for tests: time only moves when it is told to.
 *
 * Sleeping through a quiet period makes a test both slow and flaky, and a
 * boundary that only sometimes opens is the worst thing a test can assert.
 */
export class FakeClock implements JobClock {
  private t = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  set(fn: () => void, ms: number): unknown {
    const handle = this.next++;
    this.timers.set(handle, { at: this.t + ms, fn });
    return handle;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Move time forward, firing every timer due at or before the new time. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let due: { handle: number; at: number; fn: () => void } | undefined;
      for (const [handle, timer] of this.timers) {
        if (timer.at <= target && (due === undefined || timer.at < due.at)) {
          due = { handle, at: timer.at, fn: timer.fn };
        }
      }
      if (due === undefined) break;
      this.timers.delete(due.handle);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
}

/**
 * Group live pty output into jobs, closing one when the pty goes quiet.
 *
 * A pending job is held open across arrivals and re-armed on each one, so the
 * timer measures the gap *since the last byte* rather than since the job
 * opened — otherwise a slow but continuous program would be chopped at
 * arbitrary intervals.
 *
 * `flush` exists because a boundary that only ever opens on silence is too
 * late where it matters most. A resize and an exit both destroy state the
 * classifier needs to see as a whole: history freezes an epoch at a resize
 * (HISTORY.md §2), and alt-screen content is gone once the program leaves it
 * (L0.1). Both force the pending job out first, in the same order the bytes
 * arrived.
 */
export class JobDetector {
  private readonly policy: JobPolicy;
  private readonly emit: (job: Job) => void;
  private readonly clock: JobClock;

  private parts: Buffer[] = [];
  private chunks = 0;
  private bytes = 0;
  private startedAt = 0;
  private lastAt = 0;
  private handle: unknown;
  private closed = false;

  constructor(policy: JobPolicy, emit: (job: Job) => void, clock: JobClock = realClock) {
    this.policy = policy;
    this.emit = emit;
    this.clock = clock;
  }

  /** Raw deliveries merged into the job currently open. */
  get pendingChunks(): number {
    return this.chunks;
  }

  /** Bytes held in the job currently open. */
  get pendingBytes(): number {
    return this.bytes;
  }

  /** Add one raw delivery. May close a job synchronously on a cap. */
  push(bytes: Buffer): void {
    if (this.closed) return;
    const at = this.clock.now();

    if (this.chunks > 0) {
      const overBytes = this.policy.maxBytes !== undefined && this.bytes + bytes.length > this.policy.maxBytes;
      const overChunks = this.policy.maxChunks !== undefined && this.chunks + 1 > this.policy.maxChunks;
      if (overBytes || overChunks) this.close(overBytes ? 'bytes' : 'chunks');
    }

    if (this.chunks === 0) this.startedAt = at;
    this.parts.push(bytes);
    this.chunks++;
    this.bytes += bytes.length;
    this.lastAt = at;

    // Closed as soon as it is full, rather than waiting for a gap. Note this
    // tests the *new* total: the check above was against what was already
    // pending, so reusing it here would close a job that just absorbed a
    // two-byte delivery after a cap was hit.
    const fullBytes = this.policy.maxBytes !== undefined && this.bytes >= this.policy.maxBytes;
    const fullChunks = this.policy.maxChunks !== undefined && this.chunks >= this.policy.maxChunks;
    if (fullBytes || fullChunks) {
      this.close(fullBytes ? 'bytes' : 'chunks');
      return;
    }

    if (this.handle !== undefined) this.clock.clear(this.handle);
    this.handle = this.clock.set(() => {
      this.handle = undefined;
      this.close('gap');
    }, this.policy.gapMs);
  }

  /** Close the pending job now, whatever the reason. */
  flush(reason: JobCloseReason = 'flush'): void {
    if (this.handle !== undefined) {
      this.clock.clear(this.handle);
      this.handle = undefined;
    }
    this.close(reason);
  }

  /** Stop the timer. A pending job is *not* emitted — see `dispose`. */
  private close(reason: JobCloseReason): void {
    if (this.chunks === 0) return;
    const job: Job = {
      bytes: Buffer.concat(this.parts),
      parts: this.parts,
      chunks: this.chunks,
      startedAt: this.startedAt,
      closedAt: this.lastAt,
      reason,
    };
    this.parts = [];
    this.chunks = 0;
    this.bytes = 0;
    this.emit(job);
  }

  /**
   * Close anything pending, then stop accepting.
   *
   * The pending job is flushed rather than dropped: those bytes arrived, and
   * dropping them would leave the classifier's byte offsets short of what the
   * pty actually produced.
   */
  dispose(): void {
    this.flush('flush');
    this.closed = true;
  }
}
