/**
 * Opaque handle identifying a hosted terminal session.
 *
 * Callers treat this as an unforgeable key; its shape is an implementation
 * detail of the session registry.
 */
export type SessionId = string;

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
