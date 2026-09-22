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
