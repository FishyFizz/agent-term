/**
 * Child-process driver for pty recording.
 *
 * `runPty` spawns this with `--import tsx`, passing a programme id. It looks the
 * programme up in the registry and runs it against real stdout in a real pty.
 */
import { findProgramme } from '../programmes/index.js';
import { resizeMarker } from './types.js';
import type { ProgrammeIo } from './types.js';

const id = process.argv[2];
if (!id) {
  process.stderr.write('child-driver: missing programme id\n');
  process.exit(2);
}

const programme = findProgramme(id);
if (!programme) {
  process.stderr.write(`child-driver: unknown programme ${id}\n`);
  process.exit(2);
}

const cols = programme.cols ?? 80;
const rows = programme.rows ?? 24;

let offset = 0;
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array): boolean => {
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
  offset += buf.length;
  return originalWrite(buf);
}) as typeof process.stdout.write;

const io: ProgrammeIo = {
  out: process.stdout,
  mark: () => {
    // In a child process there is nowhere to send marks; `runPty` recovers
    // them from the emitted text instead.
  },
  offset: () => offset,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  onInput: (handler) => {
    process.stdin.on('data', (d) => handler(d.toString('utf8')));
  },
  resize: (cols, rows) => {
    // The pty belongs to the parent, so this process cannot resize it. The
    // request goes out as text -- the one channel that certainly survives the
    // pty -- and the parent acts on it. Going through `process.stdout.write`
    // rather than `originalWrite` keeps the byte count honest.
    process.stdout.write(resizeMarker(cols, rows));
    io.cols = cols;
    io.rows = rows;
  },
  cols,
  rows,
};

programme
  .run(io)
  .then(() => {
    // Give the pty a moment to flush before the process ends.
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    process.stderr.write(`child-driver: ${String(err)}\n`);
    process.exit(1);
  });
