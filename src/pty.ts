import { EventEmitter } from 'node:events';
import { spawn, type IPty, type IDisposable } from 'node-pty';
import { DEFAULT_COLS, DEFAULT_ROWS, assertGridSize, type SessionOptions } from './types.js';
import { defaultShell, sanitizeEnv } from './env.js';

export interface PtyExitInfo {
  exitCode: number | null;
  signal: number | null;
}

export interface PtySessionEvents {
  /**
   * Chunks of output, in the order the pty produced them.
   *
   * Bytes, not a string. Byte watermarks are what let a caller
   * distinguish "quiet" from "not read yet", and a decoded string miscounts
   * bytes for non-ASCII output. The pty is spawned with `encoding: null` to
   * get raw buffers rather than lossily re-encoding a decoded string.
   */
  data: (chunk: Buffer) => void;
  /** The process exited. Emitted at most once. */
  exit: (info: PtyExitInfo) => void;
  /**
   * Input was written into the pty, after both watermarks moved.
   *
   * For a layer above that has to stamp a watermark of its own at the moment of
   * the write -- the session's `seq`, which the byte counters here know nothing
   * about. It is emitted from `write` rather than left to the caller for the
   * same reason `_lastInputByte` is stamped here: this is the one place bytes
   * go in, so whoever writes -- the surface, a test, a script -- cannot forget.
   */
  input: () => void;
}

/** Strongly typed surface over `EventEmitter` for the events above. */
export interface PtyEventTarget {
  on<E extends keyof PtySessionEvents>(event: E, listener: PtySessionEvents[E]): void;
  off<E extends keyof PtySessionEvents>(event: E, listener: PtySessionEvents[E]): void;
}

/**
 * One hosted terminal: a real pty with a process tree inside it.
 *
 * This is the pty substrate and nothing more -- it owns the pty, moves bytes
 * in and out, resizes, and reports exit. It deliberately does not interpret
 * what those bytes mean; classification and screen state sit above it.
 */
export class PtySession implements PtyEventTarget {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly pid: number;

  private readonly pty: IPty;
  private readonly emitter = new EventEmitter();
  private readonly disposables: IDisposable[] = [];
  private _alive = true;
  private _exitInfo: PtyExitInfo | null = null;
  private _cols: number;
  private _rows: number;
  /**
   * Total bytes read from the pty. Monotonic, never reset. The read watermark:
   * comparing an earlier value against this one tells a caller whether
   * anything arrived since — the difference between "quiet" and "not read yet".
   */
  private _bytesRead = 0;
  /**
   * `bytesRead` when input was last written into the pty. Monotonic.
   *
   * The watermark a wait matches *after*: output a program produces in response
   * to input is by construction produced after this point, while whatever was
   * already on the screen is at or before it. Without it, a wait for a prompt
   * would match the prompt that was already there.
   *
   * Stamped here rather than by a caller because this is the one place bytes go
   * in, so whoever writes -- the surface, a test, a script -- it cannot be
   * forgotten (the same reason `dispose` owns the kill).
   */
  private _lastInputByte = 0;
  /**
   * Total bytes written into the pty. Monotonic, never reset.
   *
   * The counterpart to `bytesRead`, and the input watermark: comparing how
   * much went *in* against how much has come *back out* is the only honest
   * statement available about whether a program has consumed what it was sent.
   * It does not say the program is waiting — only what the byte counts are.
   */
  private _bytesWritten = 0;

  constructor(id: string, options: SessionOptions = {}) {
    const shell = defaultShell();
    const command = options.command ?? shell.command;
    const args = options.args ?? shell.args;

    this.id = id;
    this.command = command;
    this.args = args;
    this._cols = options.cols ?? DEFAULT_COLS;
    this._rows = options.rows ?? DEFAULT_ROWS;

    this.pty = spawn(command, [...args], {
      cols: this._cols,
      rows: this._rows,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? sanitizeEnv(process.env),
      // Raw bytes. The default 'utf8' decodes to a string, which loses the
      // byte counts the watermarks depend on.
      encoding: null,
    });

    this.pid = this.pty.pid;

    this.disposables.push(
      this.pty.onData((chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        this._bytesRead += bytes.length;
        this.emitter.emit('data', bytes);
      }),
      this.pty.onExit(({ exitCode, signal }) => {
        this._alive = false;
        this._exitInfo = {
          exitCode: exitCode === 0 && signal !== undefined && signal !== 0 ? null : exitCode,
          signal: signal ?? null,
        };
        this.emitter.emit('exit', this._exitInfo);
      }),
    );
  }

  get alive(): boolean {
    return this._alive;
  }

  /** Exit info once the process has exited, otherwise `null`. */
  get exitInfo(): PtyExitInfo | null {
    return this._exitInfo;
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  /** Total bytes read from the pty so far. Monotonic; never reset or wrapped. */
  get bytesRead(): number {
    return this._bytesRead;
  }

  /**
   * The byte watermark at the last write into the pty, or 0 before the first.
   *
   * A read taken now plus this value answers "has anything arrived since I
   * typed?" without the caller having to remember what it wrote when.
   */
  get lastInputByte(): number {
    return this._lastInputByte;
  }

  /**
   * Send input, exactly as a human typing would -- no implicit newline.
   * Callers that want a submitted line append `\r` (or `\n`) themselves.
   */
  write(input: string): void {
    if (!this._alive) return;
    this._lastInputByte = this._bytesRead;
    this._bytesWritten += Buffer.byteLength(input, 'utf8');
    // Before the bytes are handed over: a listener is stamping the moment of
    // the write, and the counters above are what define that moment.
    this.emitter.emit('input');
    this.pty.write(input);
  }

  /** Total bytes written into the pty so far. Monotonic; never reset. */
  get bytesWritten(): number {
    return this._bytesWritten;
  }

  /**
   * Bytes written since the pty last produced output, or `null` before any
   * input.
   *
   * **This is a byte count, not a statement about the program.** It says how
   * much went in and has not been followed by anything coming out — which is
   * the most that a byte interface can honestly say about "is it waiting".
   * Whether the program is blocked on a prompt, busy, or has simply not
   * flushed is not observable here: a shell running a
   * slow builtin and a shell sitting at a prompt look identical from outside.
   */
  get unconsumedBytes(): number | null {
    if (this._bytesWritten === 0) return null;
    return this._bytesWritten > 0 && this._lastInputByte === this._bytesRead
      ? this._bytesWritten
      : 0;
  }

  /** Resize the pty; the program inside is told via SIGWINCH / ConPTY. */
  resize(cols: number, rows: number): void {
    if (!this._alive) return;
    assertGridSize(cols, rows);
    this.pty.resize(cols, rows);
    this._cols = cols;
    this._rows = rows;
  }

  /** Terminate the process tree. Idempotent. */
  kill(signal?: string): void {
    if (!this._alive) return;
    try {
      this.pty.kill(signal);
    } catch {
      // Already gone -- onExit will have fired or is about to.
    }
  }

  on<E extends keyof PtySessionEvents>(event: E, listener: PtySessionEvents[E]): void {
    this.emitter.on(event, listener);
  }

  off<E extends keyof PtySessionEvents>(event: E, listener: PtySessionEvents[E]): void {
    this.emitter.off(event, listener);
  }

  /**
   * End the session: release the pty, then release listeners and handles.
   * Idempotent, and safe to call after exit.
   *
   * Killing is part of disposal, not a separate step a caller must remember.
   * A pty released without being killed leaves its shell running and the
   * process never exits -- which is a hang, not a leak you notice later.
   * `TerminalSession.dispose()` used to have to say this out loud in a
   * comment; the invariant belongs here, where the handle is owned.
   *
   * The underlying `kill()` is called **even when the process has already
   * exited**, which `kill()` itself deliberately does not do. Stopping a
   * process and releasing its resources are different questions, and node-pty
   * only answers the second one from `kill()`: the ConPTY agent owns a worker
   * thread that nothing else terminates. A process that exits on its own never
   * runs that path, so skipping it here leaves the thread alive and the host
   * process unable to exit -- the session that ended by itself would be the one
   * that never lets go.
   *
   * Disposal is itself the end of the session, so `alive` goes false here and
   * not only when an exit event happens to arrive. The exit handler is disposed
   * in the same breath, so nothing else would ever clear the flag -- and a
   * caller holding the session would be told it is alive with its socket gone.
   */
  dispose(): void {
    this._alive = false;
    try {
      this.pty.kill();
    } catch {
      // Nothing left to kill, so nothing left to release.
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.emitter.removeAllListeners();
  }
}
