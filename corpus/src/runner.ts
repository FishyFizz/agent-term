/**
 * Runs a corpus programme and produces a trace.
 *
 * Two feeds:
 *  - `runDirect` — the programme writes into a buffer, which is then fed to the
 *    emulator. Deterministic: byte offsets are stable, so `expectations()` can
 *    name real offsets.
 *  - `runPty` — the programme runs as a child in a real pty and the pty's
 *    output is fed to the emulator. What a real session sees.
 *
 * Both produce the same `Trace`, differing only in `feed` and in the bytes
 * themselves (ConPTY rewrites some sequences — see OPS.md).
 */
import { Writable } from 'node:stream';
import { Recorder } from './recorder.js';
import type { Programme, ProgrammeIo, Trace, Op, Frame } from './types.js';

/** A stdout the programme writes to, which counts bytes and records marks. */
class CountingSink extends Writable {
  readonly chunks: Buffer[] = [];
  private count = 0;
  readonly marks = new Map<string, number>();

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.chunks.push(Buffer.from(chunk));
    this.count += chunk.length;
    cb();
  }

  get offset(): number {
    return this.count;
  }

  mark(name: string): void {
    this.marks.set(name, this.count);
  }

  get raw(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function makeIo(
  sink: CountingSink,
  cols: number,
  rows: number,
  inputHandlers: Array<(d: string) => void>,
): ProgrammeIo {
  return {
    out: { write: (s: string) => sink.write(Buffer.from(s, 'utf8')) },
    mark: (name) => sink.mark(name),
    offset: () => sink.offset,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    onInput: (h) => inputHandlers.push(h),
    cols,
    rows,
  };
}

export interface RunResult {
  trace: Trace;
  /** Marks the programme recorded, resolved to byte offsets. */
  marks: Record<string, number>;
}

/** Run in-process: capture the programme's bytes, then feed them to the emulator. */
export async function runDirect(
  programme: Programme,
  opts: { chunkSize?: number } = {},
): Promise<RunResult> {
  const cols = programme.cols ?? 80;
  const rows = programme.rows ?? 24;
  const sink = new CountingSink();
  const inputHandlers: Array<(d: string) => void> = [];
  const io = makeIo(sink, cols, rows, inputHandlers);

  await programme.run(io);
  await new Promise<void>((r) => sink.end(() => r()));

  const raw = sink.raw;
  const recorder = new Recorder({ cols, rows });
  await recorder.writeChunked(Buffer.from(raw, 'utf8'), opts.chunkSize ?? 32);
  recorder.capture('end');

  const marks = Object.fromEntries(sink.marks);
  const trace = assemble(programme, recorder, raw, 'direct', marks, cols, rows);
  recorder.dispose();
  return { trace, marks };
}

/**
 * Run the programme as a child process in a real pty and feed the pty's output
 * to the emulator.
 *
 * Uses `spawn` from node-pty directly rather than the repo's `PtySession`,
 * because the recorder needs the bytes themselves, not a session abstraction.
 */
export async function runPty(
  programme: Programme,
  opts: { settleMs?: number; timeoutMs?: number } = {},
): Promise<RunResult> {
  const cols = programme.cols ?? 80;
  const rows = programme.rows ?? 24;
  const settleMs = opts.settleMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 15000;

  // The programme is authored as a function, so to run it in a child we write a
  // driver that imports it by id and runs it against real stdout.
  // The driver is authored in TypeScript and run under tsx, so hand the child
  // the real `.ts` path rather than the `.js` specifier its own imports use.
  const { fileURLToPath } = await import('node:url');
  const { spawn } = await import('node-pty');
  const driverPath = fileURLToPath(new URL('./child-driver.ts', import.meta.url));

  const pty = spawn(process.execPath, ['--import', 'tsx', driverPath, programme.id], {
    cols,
    rows,
    encoding: null as never,
    cwd: process.cwd(),
  });

  const sink = new CountingSink();
  const recorder = new Recorder({ cols, rows });
  const inputHandlers: Array<(d: string) => void> = [];

  let settled: (() => void) | null = null;
  const done = new Promise<void>((r) => {
    settled = r;
  });
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => settled?.(), settleMs);
  };
  arm();

  pty.onData((chunk: unknown) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    sink.write(bytes);
    void recorder.write(bytes);
    arm();
  });

  const killer = setTimeout(() => {
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
    settled?.();
  }, timeoutMs);

  await done;
  clearTimeout(killer);
  clearTimeout(timer);
  recorder.capture('end');

  const raw = sink.raw;
  // In pty mode the programme ran in a child, so it could not call `mark`.
  // Derive marks the only honest way available: match the labelled text the
  // programme emitted. See OPS.md "marks in pty mode".
  const marks: Record<string, number> = {};
  for (const name of knownMarks(programme)) {
    const idx = raw.indexOf(name);
    if (idx >= 0) marks[name] = idx;
  }

  const trace = assemble(programme, recorder, raw, 'pty', marks, cols, rows);
  recorder.dispose();
  try {
    pty.kill();
  } catch {
    /* already exited */
  }
  return { trace, marks };
}

/** Mark names a programme can produce, recovered by scanning its own text. */
function knownMarks(programme: Programme): string[] {
  // Ask the programme for its expectations against a mark table that records
  // every name asked for; those names are what we then look for in the bytes.
  const asked = new Set<string>();
  const proxy = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        asked.add(prop);
        return 0;
      },
    },
  ) as Record<string, number>;
  programme.expectations(proxy);
  return [...asked];
}

function assemble(
  programme: Programme,
  recorder: Recorder,
  raw: string,
  feed: 'direct' | 'pty',
  marks: Record<string, number>,
  cols: number,
  rows: number,
): Trace {
  const ops: Op[] = recorder.ops;
  const frames: Frame[] = recorder.frames;
  return {
    version: 1,
    id: programme.id,
    category: programme.category,
    summary: programme.summary,
    feed,
    cols,
    rows,
    platform: process.platform,
    recordedAt: new Date().toISOString(),
    expectations: programme.expectations(marks),
    ops,
    frames,
    textLog: recorder.textLog,
    bytes: recorder.bytesWritten,
    raw,
  };
}
