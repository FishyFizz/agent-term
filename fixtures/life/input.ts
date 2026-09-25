/**
 * The one owner of stdin.
 *
 * Two rules matter. First, only one consumer reads at a time: in shell mode
 * this router reads lines, and when a mode is running it goes quiet, because
 * clack and the chat frame attach listeners of their own and would otherwise
 * see the same bytes. Second, nothing is delivered while the program is busy --
 * the caller queues lines and drains them once the current action finishes,
 * which is what lets an agent type into a silence and be answered late.
 */

export type LineSink = (line: string) => void;

export class StdinRouter {
  private mode: 'shell' | 'foreign' = 'shell';
  private pending = '';
  private afterCr = false;
  private chunk: ((data: Buffer) => void) | null = null;

  constructor(private readonly stdin: NodeJS.ReadStream) {}

  start(onLine: LineSink, onEof: () => void): void {
    this.chunk = (data: Buffer): void => {
      const text = data.toString('utf8');
      for (const ch of text) {
        if (this.mode !== 'shell') continue;

        if (ch === '\r' || ch === '\n') {
          // ConPTY turns a typed CR into CRLF. Without collapsing that, one
          // Enter is delivered as a real line plus a phantom empty one -- which
          // the shell would answer with a second prompt.
          const repeatsLastBreak = ch === '\n' && this.afterCr;
          this.afterCr = ch === '\r';
          if (repeatsLastBreak) continue;

          const line = this.pending;
          this.pending = '';
          onLine(line.trim());
          continue;
        }

        this.afterCr = false;

        if (ch === '\x04') {
          // Ctrl-D: end of input.
          this.pending = '';
          onEof();
        } else if (ch === '\x7f' || ch === '\b') {
          this.pending = this.pending.slice(0, -1);
        } else {
          this.pending += ch;
        }
      }
    };

    this.stdin.on('data', this.chunk);
    this.stdin.resume();
  }

  stop(): void {
    if (this.chunk !== null) {
      this.stdin.off('data', this.chunk);
      this.chunk = null;
    }
  }

  /** Hand stdin to a mode. The shell reader ignores bytes until takeBack(). */
  handOff(): void {
    this.mode = 'foreign';
    this.pending = '';
    this.afterCr = false;
  }

  takeBack(): void {
    this.mode = 'shell';
    this.pending = '';
    this.afterCr = false;
  }

  setRawMode(on: boolean): void {
    if (typeof this.stdin.setRawMode === 'function') this.stdin.setRawMode(on);
  }
}
