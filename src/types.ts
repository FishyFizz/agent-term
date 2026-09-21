/**
 * Event names emitted by a PtySession.
 *
 * Kept as a small closed set rather than a generic string index so callers get
 * compile-time checking.
 */
export interface PtySessionEvents {
  /** Raw bytes read from the pty, in order. */
  data: (chunk: Buffer) => void;
  /** Process exited. `code` is null when killed by a signal. */
  exit: (info: { exitCode: number | null; signal: number | null }) => void;
}

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
