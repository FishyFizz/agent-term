import type { GroupClock } from './groups.js';

/**
 * Opaque handle identifying a hosted terminal session.
 *
 * Callers treat this as an unforgeable key; its shape is an implementation
 * detail of the session registry.
 */
export type SessionId = string;

/**
 * How raw pty output is grouped into groups — the units the classifier is
 * asked about. Not units of intent: the boundary is inferred from silence.
 *
 * The numbers are policy and belong to L1/L3; the fact that output *has*
 * boundaries belongs to L0, because where a boundary falls decides what the
 * classifier can see (CLASSIFIER.md §9.3). See `groups.ts` for the reasoning and
 * for what each field guards against.
 */
export interface GroupPolicy {
  /**
   * Milliseconds of silence that close a group.
   *
   * Measured against `Op.at`, the same millisecond clock the emulator stamps
   * ops with, so a policy tuned on live output replays against the corpus.
   */
  gapMs: number;
  /** Cap on bytes in one group. Without it a firehose never closes a group. */
  maxBytes?: number;
  /** Cap on raw deliveries in one group. */
  maxChunks?: number;
}

/** Options for spawning a session. */
export interface SessionOptions {
  /** Executable to run. Defaults to a platform shell. */
  command?: string;
  /** Arguments to the executable. */
  args?: string[];
  /** Working directory. Defaults to the server's cwd. */
  cwd?: string;
  /** Environment. Defaults to a sanitized copy of `process.env`. */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /**
   * Group output into groups before classifying it.
   *
   * On by default, because where a delivery begins decides what the classifier
   * can see (CLASSIFIER.md §9.3) and leaving it to the pty means letting a
   * buffer decide. Pass `false` for what a session did before groups existed:
   * one classified update per raw pty delivery, which is the honest setting
   * for a caller that wants every byte boundary and is what the corpus's
   * op-aligned replay measures.
   *
   * The numbers are policy; absent means `DEFAULT_GROUP_POLICY`.
   *
   * Off, the session reports `collapsed: null` rather than an invented `1`
   * (GOAL.md L1.3).
   */
  groupPolicy?: GroupPolicy | false;

  /**
   * The clock the session measures silence with.
   *
   * Injected so a test advances time rather than sleeping through it: a quiet
   * period that only sometimes elapses is the worst thing a test can assert,
   * and a real clock makes every timing test both slow and flaky.
   *
   * Shared with the group detector, so the boundary a group closes on and the
   * session's idle measurement cannot disagree about what time it is.
   */
  clock?: GroupClock;
}

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/**
 * Reject a terminal size that is not a usable grid.
 *
 * Shared because a session resizes a pty and an emulator that must never
 * disagree. If each validated on its own, `TerminalSession.resize` could
 * accept the size for one, throw for the other, and leave them out of step --
 * and a caller that caught the error would see a half-applied resize.
 */
export function assertGridSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new RangeError(`invalid terminal size ${cols}x${rows}`);
  }
}
