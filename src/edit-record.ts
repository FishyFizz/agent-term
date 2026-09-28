/**
 * The edit record: everything the emulator saw that was not printable text.
 *
 * The op stream supplies *where the segment boundaries
 * are*; the screen model supplies *what each segment did*. Neither alone is
 * enough: a screen diff cannot recover boundaries once a scroll has moved
 * everything, and an op alone says a cursor moved, not whether content
 * was destroyed.
 *
 * It is a second view of the same parser that produces the screen, not a
 * second parser. Printable text does not pass through these handlers, so runs
 * of text between ops are implicit.
 *
 * Two kinds of op are recorded, and the distinction matters:
 *
 *  - **sequences** (`source: 'csi' | 'esc'`) — control operations the program
 *    actually sent. These are the program stating its intent.
 *  - **events** (`source: 'event'`) — structural things the emulator did in
 *    response: a linefeed, a scroll, a resize, a buffer switch, a title
 *    change. No program wrote them; they are inferred from the state change.
 *
 * The classifier does not read this file. The verdict comes from the screen;
 * the op stream is what output is replayed from, what
 * boundaries are found from, and what a caller reads when the screen model is
 * under suspicion. The corpus asserts on these ops, because a trace that
 * claims "20 lines were appended" has to be able to count them.
 */
import type { XtermTerminal } from './xterm.js';

/**
 * Control operations, plus the structural events the emulator reports.
 *
 * One closed vocabulary for the whole repo: the classifier picks its policy
 * sets from this, and the corpus records all of it.
 */
export type OpName =
  // Cursor movement.
  | 'CUP' // CSI H / f    — cursor position
  | 'CUU' // CSI A       — cursor up
  | 'CUD' // CSI B       — cursor down
  | 'CUF' // CSI C       — cursor forward
  | 'CUB' // CSI D       — cursor back
  // Erase and edit.
  | 'EL' //  CSI K       — erase in line
  | 'ED' //  CSI J       — erase in display
  | 'IL' //  CSI L       — insert lines
  | 'DL' //  CSI M       — delete lines
  | 'DCH' // CSI P       — delete characters
  | 'ICH' // CSI @       — insert characters
  // Scrolling.
  | 'SU' //  CSI S       — scroll up
  | 'SD' //  CSI T       — scroll down
  // Appearance.
  | 'SGR' // CSI m       — select graphic rendition
  // DEC private modes.
  | 'DECSET' // CSI ? X h
  | 'DECRST' // CSI ? X l
  // State save/restore and reset.
  | 'DECSC' // ESC 7      — save cursor
  | 'DECRC' // ESC 8      — restore cursor
  | 'RIS' //  ESC c      — full reset
  // Structural events, fired by the emulator rather than written by the
  // program. Boundaries and shape changes, never content.
  | 'LINEFEED'
  | 'SCROLL'
  | 'RESIZE'
  | 'BUFFERCHANGE'
  | 'TITLECHANGE';

/** Where an op came from: a sequence the program sent, or an emulator event. */
export type OpSource = 'csi' | 'esc' | 'event';

/**
 * One op, with the state that makes it interpretable.
 *
 * `byteOffset` is the count of pty bytes consumed *before* this op, so a
 * segment boundary can be located in the byte stream and in history
 * even when a whole coalescing window arrives at once.
 */
export interface Op {
  name: OpName;
  source: OpSource;
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

/** DEC private modes that change which buffer is active. */
const ALT_SCREEN_MODES: ReadonlySet<number> = new Set([47, 1047, 1049]);

/** Ops that are structural events rather than sequences the program sent. */
const EVENT_OPS: ReadonlySet<OpName> = new Set<OpName>([
  'LINEFEED',
  'SCROLL',
  'RESIZE',
  'BUFFERCHANGE',
  'TITLECHANGE',
]);

/**
 * Predicates over the op vocabulary.
 *
 * They live next to the vocabulary they interpret rather than in the
 * classifier, so the corpus can ask the same questions the classifier does.
 */
export const OP = {
  /** A structural event, fired by the emulator rather than written. */
  isEvent: (n: OpName): boolean => EVENT_OPS.has(n),
  /**
   * An alt-screen enter/exit: a buffer switch, which is a timeline boundary.
   *
   * It draws nothing and erases nothing, but content on the alt screen is
   * destroyed when the program leaves it, so the boundary has to be
   * visible in the stream.
   */
  isAltScreenSwitch: (op: Op): boolean =>
    (op.name === 'DECSET' || op.name === 'DECRST') && op.params.some((p) => ALT_SCREEN_MODES.has(p)),
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

  private push(name: OpName, source: OpSource, params: number[] = []): void {
    const buf = this.terminal.buffer.active;
    this.ops.push({
      name,
      source,
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
    const csi = (final: string, name: OpName): void => {
      this.disposables.push(
        parser.registerCsiHandler({ final }, (params) => {
          this.push(name, 'csi', flatten(params));
          // Return false: we observe, we do not handle. xterm still applies it.
          return false;
        }),
      );
    };
    const esc = (final: string, name: OpName): void => {
      this.disposables.push(
        parser.registerEscHandler({ final }, () => {
          this.push(name, 'esc');
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
    csi('S', 'SU');
    csi('T', 'SD');
    csi('m', 'SGR');

    // DEC private modes: CSI ? Pm h / l.
    // '?' is a *prefix* (0x3f), not an intermediate (0x20..0x2f) -- xterm
    // rejects it as an intermediate with "intermediate must be in range
    // 0x20 .. 0x2f".
    this.disposables.push(
      parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        this.push('DECSET', 'csi', flatten(params));
        return false;
      }),
      parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        this.push('DECRST', 'csi', flatten(params));
        return false;
      }),
    );

    esc('7', 'DECSC');
    esc('8', 'DECRC');
    esc('c', 'RIS');

    // Structural events. `onScroll` reports the new viewport position, and
    // `onResize` the new size, so both carry their value as a param.
    this.disposables.push(
      this.terminal.onLineFeed(() => this.push('LINEFEED', 'event')),
      this.terminal.onScroll((position) => this.push('SCROLL', 'event', [position])),
      this.terminal.onResize(({ cols, rows }) => this.push('RESIZE', 'event', [cols, rows])),
      this.terminal.onTitleChange(() => this.push('TITLECHANGE', 'event')),
      this.terminal.buffer.onBufferChange?.(() => this.push('BUFFERCHANGE', 'event')) ?? {
        dispose() {},
      },
    );
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

/**
 * Human-readable mode grouping, for evidence attached to a verdict.
 *
 * Kept beside the vocabulary because it is the same question in another form:
 * what did this mode number mean.
 */
export function modeKind(param: number): string | undefined {
  return MODE_OPS[param];
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
