import { EventEmitter } from 'node:events';
import { spawn, type IPty, type IDisposable } from 'node-pty';
import { DEFAULT_COLS, DEFAULT_ROWS, type SessionOptions } from './types.js';
import { defaultShell, sanitizeEnv } from './env.js';

export interface PtyExitInfo {
  exitCode: number | null;
  signal: number | null;
}

export interface PtySessionEvents {
  /** Chunks of output, in the order the pty produced them. */
  data: (chunk: string) => void;
  /** The process exited. Emitted at most once. */
  exit: (info: PtyExitInfo) => void;
}

/** Strongly typed surface over `EventEmitter` for the events above. */
export interface PtyEventTarget {
  on<E extends keyof PtySessionEvents>(event: E, listener: PtySessionEvents[E]): void;
  off<E extends keyof PtySessionEvents>(event: E, listener: PtySessionEvents[E]): void;
}

/**
 * One hosted terminal: a real pty with a process tree inside it.
 *
 * This is the L0.5 substrate and nothing more -- it owns the pty, moves bytes
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
    });

    this.pid = this.pty.pid;

    this.disposables.push(
      this.pty.onData((chunk) => {
        this.emitter.emit('data', chunk);
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

  /**
   * Send input, exactly as a human typing would -- no implicit newline.
   * Callers that want a submitted line append `\r` (or `\n`) themselves.
   */
  write(input: string): void {
    if (!this._alive) return;
    this.pty.write(input);
  }

  /** Resize the pty; the program inside is told via SIGWINCH / ConPTY. */
  resize(cols: number, rows: number): void {
    if (!this._alive) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new RangeError(`invalid terminal size ${cols}x${rows}`);
    }
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

  /** Release listeners and pty handles. Safe to call after exit. */
  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.emitter.removeAllListeners();
  }
}
