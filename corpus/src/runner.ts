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
import { resizeMarker, takeResizeMarkers } from './types.js';
import type { Programme, ProgrammeIo, ResizeAt, Trace } from './types.js';

/** A stdout the programme writes to, which counts bytes and records marks. */
class CountingSink extends Writable {
  readonly chunks: Buffer[] = [];
  private count = 0;
  readonly marks = new Map<string, number>();
  /** Resizes asked for, with the offset the request ended at. */
  readonly resizes: ResizeAt[] = [];

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

  resize(cols: number, rows: number): void {
    this.resizes.push({ offset: this.count, cols, rows });
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
  const io: ProgrammeIo = {
    out: { write: (s: string) => sink.write(Buffer.from(s, 'utf8')) },
    mark: (name) => sink.mark(name),
    offset: () => sink.offset,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    onInput: (h) => inputHandlers.push(h),
    resize: (c, r) => {
      // Marker first: it is the request another process can see, and it puts
      // the resize at a byte offset a replay can reproduce.
      sink.write(Buffer.from(resizeMarker(c, r), 'utf8'));
      sink.resize(c, r);
      io.cols = c;
      io.rows = r;
    },
    cols,
    rows,
  };
  return io;
}

export interface RunResult {
  trace: Trace;
  /** Marks the programme recorded, resolved to byte offsets. */
  marks: Record<string, number>;
}

/**
 * Feed captured bytes in chunks, resizing where the programme asked.
 *
 * A trace has to be replayed at the size the programme was running at, or the
 * frames, the ops and the classifier all describe a terminal that never
 * existed. Resizes are applied before the chunk containing their offset, so the
 * replay sees the sequence the programme did -- including a resize whose marker
 * and the redraw that follows it land in the same chunk.
 */
async function writeChunkedWithResizes(
  recorder: Recorder,
  raw: Buffer,
  resizes: readonly ResizeAt[],
  chunkSize: number,
): Promise<void> {
  const pending = [...resizes].sort((a, b) => a.offset - b.offset);
  let at = 0;
  let i = 0;
  const applyDue = (upTo: number): void => {
    while (i < pending.length && pending[i]!.offset <= upTo) {
      const r = pending[i]!;
      recorder.resize(r.cols, r.rows);
      i++;
    }
  };
  while (at < raw.length) {
    const end = Math.min(at + chunkSize, raw.length);
    applyDue(end);
    await recorder.write(raw.subarray(at, end));
    at = end;
  }
  applyDue(Number.POSITIVE_INFINITY);
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
  await writeChunkedWithResizes(
    recorder,
    Buffer.from(raw, 'utf8'),
    sink.resizes,
    opts.chunkSize ?? 32,
  );
  recorder.capture('end');

  const marks = Object.fromEntries(sink.marks);
  const trace = assemble(programme, recorder, raw, 'direct', marks, cols, rows, sink.resizes);
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

  const resizes: ResizeAt[] = [];
  let markerTail = '';
  pty.onData((chunk: unknown) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    sink.write(bytes);
    void recorder.write(bytes);

    // A programme cannot resize the pty it is running inside, so the request
    // arrives as text and the parent acts on it (see `resizeMarker`). The tail
    // lets a marker split across two chunks match once it completes instead of
    // being missed -- the child emits it in one write, but the pty need not
    // deliver it in one read.
    const { sizes, rest } = takeResizeMarkers(markerTail + bytes.toString('utf8'));
    markerTail = rest.slice(-64);
    for (const size of sizes) {
      resizes.push({ offset: sink.offset, cols: size.cols, rows: size.rows });
      // Both halves: the pty, so the programme inside reflows, and the
      // recorder's own model, so the trace describes the terminal the programme
      // was actually in.
      recorder.resize(size.cols, size.rows);
      try {
        pty.resize(size.cols, size.rows);
      } catch {
        /* already gone; the request is still recorded */
      }
    }
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

  const trace = assemble(programme, recorder, raw, 'pty', marks, cols, rows, resizes);
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
  resizes: readonly ResizeAt[],
): Trace {
  // Ops are the live array until the trace owns them; copy, so a recorder
  // disposed right after this cannot have cleared what we just recorded.
  const { ops, frames, textLog } = recorder.recorded();
  return {
    version: 1,
    id: programme.id,
    category: programme.category,
    summary: programme.summary,
    feed,
    // The size the programme started at. What it was resized to is in
    // `resizes`, in order, because that is the only way to replay it.
    cols,
    rows,
    platform: process.platform,
    recordedAt: new Date().toISOString(),
    expectations: programme.expectations(marks),
    ops: [...ops],
    frames,
    textLog,
    resizes: [...resizes],
    bytes: recorder.bytesWritten,
    raw,
  };
}
