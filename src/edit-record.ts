/**
 * The edit record: the program's control operations, in order.
 *
 * CLASSIFIER.md §3.1 — the op stream supplies *where the segment boundaries
 * are*; the screen model supplies *what each segment did*. Neither alone is
 * enough: a screen diff cannot recover boundaries once a scroll has moved
 * everything (§4), and an op alone says a cursor moved, not whether content
 * was destroyed.
 *
 * This is a second view of the same parser that produces the screen, not a
 * second parser. Printable text does not pass through these handlers, so runs
 * of text between ops are implicit.
 */
import type { XtermTerminal } from './xterm.js';

/** Control operations that end a segment. */
export type OpName =
  | 'CUP' // CSI H / f    — cursor position
  | 'CUU' // CSI A       — cursor up
  | 'CUD' // CSI B       — cursor down
  | 'CUF' // CSI C       — cursor forward
  | 'CUB' // CSI D       — cursor back
  | 'EL' //  CSI K       — erase in line
  | 'ED' //  CSI J       — erase in display
  | 'IL' //  CSI L       — insert lines
  | 'DL' //  CSI M       — delete lines
  | 'DCH' // CSI P       — delete characters
  | 'ICH' // CSI @       — insert characters
  | 'DECSC' // ESC 7     — save cursor
  | 'DECRC' // ESC 8     — restore cursor
  | 'DECSET' // CSI ? X h
  | 'DECRST' // CSI ? X l
  | 'RIS'; //  ESC c      — full reset

/**
 * One control operation, with the state that makes it interpretable.
 *
 * `byteOffset` is the count of pty bytes consumed *before* this op, so a
 * segment boundary can be located in the byte stream and in history (L0.3)
 * even when a whole coalescing window arrives at once.
 */
export interface Op {
  name: OpName;
  /** Bytes fed to the emulator before this op. Monotonic across a session. */
  byteOffset: number;
  /** Cursor position when the op ran. */
  cursorX: number;
  cursorY: number;
  /** Raw parameters, for ops where they matter (DECSET modes, EL/ED variants). */
  params: number[];
  /** True when this op ran on the alternate buffer. */
  altScreen: boolean;
  /** Timestamp, for ordering and history. */
  at: number;
}

/** Operations that change which buffer is active or how the screen behaves. */
const MODE_OPS: Record<number, string> = {
  47: 'alt-screen',
  1047: 'alt-screen',
  1049: 'alt-screen',
  1048: 'save-cursor',
  2026: 'synchronized-output',
  2004: 'bracketed-paste',
  25: 'cursor-visibility',
  1000: 'mouse-tracking',
  1002: 'mouse-tracking',
  1003: 'mouse-tracking',
};

/**
 * Records the op stream for one terminal.
 *
 * Byte offsets come from the feeder, since xterm's handlers do not report how
 * many bytes were consumed. `feed` is awaited before `write`, so by the time
 * an op handler runs, the offset covers everything up to and including the
 * bytes that produced it.
 */
export class EditRecord {
  private readonly ops: Op[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private _bytesFed = 0;

  constructor(private readonly terminal: XtermTerminal) {
    this.install();
  }

  /** Record that `n` bytes were handed to the emulator. */
  noteBytes(n: number): void {
    this._bytesFed += n;
  }

  /** Ops recorded so far, oldest first. */
  get recorded(): readonly Op[] {
    return this.ops;
  }

  /** Total bytes fed, i.e. the offset the next op will carry. */
  get bytesFed(): number {
    return this._bytesFed;
  }

  /** Drop recorded ops. Callers drain rather than accumulate without bound. */
  clear(): void {
    this.ops.length = 0;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private push(name: OpName, params: number[] = []): void {
    const buf = this.terminal.buffer.active;
    this.ops.push({
      name,
      byteOffset: this._bytesFed,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      params,
      altScreen: buf.type === 'alternate',
      at: Date.now(),
    });
  }

  private install(): void {
    const parser = this.terminal.parser;
    const csi = (
      final: string,
      name: OpName,
      intermediates?: string,
    ): void => {
      this.disposables.push(
        parser.registerCsiHandler({ final, ...(intermediates ? { intermediates } : {}) }, (params) => {
          this.push(name, flatten(params));
          // Return false: we observe, we do not handle. xterm still applies it.
          return false;
        }),
      );
    };

    csi('H', 'CUP');
    csi('f', 'CUP');
    csi('A', 'CUU');
    csi('B', 'CUD');
    csi('C', 'CUF');
    csi('D', 'CUB');
    csi('K', 'EL');
    csi('J', 'ED');
    csi('L', 'IL');
    csi('M', 'DL');
    csi('P', 'DCH');
    csi('@', 'ICH');

    // DEC private modes: CSI ? Pm h / l.
    // '?' is a *prefix* (0x3f), not an intermediate (0x20..0x2f) -- xterm
    // rejects it as an intermediate with "intermediate must be in range
    // 0x20 .. 0x2f".
    this.disposables.push(
      parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        this.push('DECSET', flatten(params));
        return false;
      }),
      parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        this.push('DECRST', flatten(params));
        return false;
      }),
    );

    const esc = (final: string, name: OpName): void => {
      this.disposables.push(
        parser.registerEscHandler({ final }, () => {
          this.push(name);
          return false;
        }),
      );
    };
    esc('7', 'DECSC');
    esc('8', 'DECRC');
    esc('c', 'RIS');
  }
}

function flatten(params: (number | number[])[]): number[] {
  const out: number[] = [];
  for (const p of params) {
    if (Array.isArray(p)) out.push(p[0] ?? 0);
    else out.push(p);
  }
  return out;
}

/** Human-readable mode grouping, for evidence attached to a verdict. */
export function modeKind(param: number): string | undefined {
  return MODE_OPS[param];
}
