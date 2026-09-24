/**
 * Opaque handle identifying a hosted terminal session.
 *
 * Callers treat this as an unforgeable key; its shape is an implementation
 * detail of the session registry.
 */
export type SessionId = string;

/**
 * How raw pty output is grouped into jobs — the program's units of intent.
 *
 * The numbers are policy and belong to L1/L3; the fact that output *has*
 * boundaries belongs to L0, because where a boundary falls decides what the
 * classifier can see (CLASSIFIER.md §9.3). See `jobs.ts` for the reasoning and
 * for what each field guards against.
 */
export interface JobPolicy {
  /**
   * Milliseconds of silence that close a job.
   *
   * Measured against `Op.at`, the same millisecond clock the emulator stamps
   * ops with, so a policy tuned on live output replays against the corpus.
   */
  gapMs: number;
  /** Cap on bytes in one job. Without it a firehose never closes a job. */
  maxBytes?: number;
  /** Cap on raw deliveries in one job. */
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
   * Group output into jobs before classifying it.
   *
   * Absent means what the session has always done: one classified update per
   * raw pty delivery. That is the honest default for a caller that wants every
   * byte boundary, and it is what the corpus's per-op replay measures. Setting
   * a policy is what makes a repaint legible — see `src/jobs.ts`.
   */
  jobPolicy?: JobPolicy;
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
