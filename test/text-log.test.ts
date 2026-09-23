/**
 * The text log — CLASSIFIER.md §5's first sink.
 *
 * These pin the measurements HISTORY.md records, because each one is a claim
 * the history design rests on: if the log stops being lossless past the
 * scrollback horizon, L0.3's "page back to any earlier part of that build"
 * quietly stops being satisfiable, and nothing else would notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminal, type XtermTerminal } from '../src/xterm.js';
import { TextLog } from '../src/text-log.js';

/** Feed and wait, exactly as `ScreenModel.feed` does: count, then write. */
async function feed(terminal: XtermTerminal, log: TextLog, data: string | Buffer): Promise<void> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  log.noteBytes(bytes.length);
  await new Promise<void>((resolve) => terminal.write(new Uint8Array(bytes), () => resolve()));
}

test('every completed line is captured, in order', async () => {
  const terminal = createTerminal({ cols: 20, rows: 5 });
  const log = new TextLog(terminal);
  await feed(terminal, log, 'alpha\r\nbeta\r\ngamma\r\n');

  assert.deepEqual(
    log.drain().map((l) => l.text),
    ['alpha', 'beta', 'gamma'],
  );
  terminal.dispose();
  log.dispose();
});

test('repeated lines are kept — this is a log, not a set', async () => {
  const terminal = createTerminal({ cols: 20, rows: 5 });
  const log = new TextLog(terminal);
  await feed(terminal, log, 'Compiling a\r\nCompiling a\r\nCompiling a\r\n');

  const lines = log.drain();
  assert.equal(lines.length, 3, 'a build log that repeats a line is the common case');
  assert.deepEqual(
    lines.map((l) => l.text),
    ['Compiling a', 'Compiling a', 'Compiling a'],
  );
  terminal.dispose();
  log.dispose();
});

test('lines survive a scrollback overflow', async () => {
  // The decisive case: the buffer is deliberately far too small to hold the
  // output, so anything reading the grid loses it. The linefeed stream does not.
  const terminal = createTerminal({ cols: 20, rows: 5, scrollback: 10 });
  const log = new TextLog(terminal);

  const N = 200;
  for (let i = 0; i < N; i++) await feed(terminal, log, `line ${i}\r\n`);

  const lines = log.drain();
  assert.equal(lines.length, N, `captured every line, though the buffer holds only ${terminal.buffer.active.length}`);
  assert.equal(lines[0]?.text, 'line 0', 'the oldest line is the one the buffer dropped first');
  assert.equal(lines[N - 1]?.text, `line ${N - 1}`);
  assert.equal(new Set(lines.map((l) => l.text)).size, N, 'none dropped, none duplicated');
  assert.ok(
    terminal.buffer.active.length <= 15,
    `the buffer really did overflow (length ${terminal.buffer.active.length})`,
  );

  terminal.dispose();
  log.dispose();
});

test('a CUP-drawn screen writes nothing to the log', async () => {
  // Drawn content is the screen grid's to record. If a repaint landed here too,
  // every TUI frame would pollute the text of the session.
  const terminal = createTerminal({ cols: 24, rows: 5 });
  const log = new TextLog(terminal);

  let frame = '\x1b[?1049h';
  for (let row = 0; row < 5; row++) frame += `\x1b[${row + 1};1H\x1b[2Krow content ${row}`;
  await feed(terminal, log, frame);

  assert.deepEqual(log.drain(), [], 'a CUP-drawn screen completes no lines');
  terminal.dispose();
  log.dispose();
});

test('lines written on the alt screen are captured, and marked', async () => {
  // L0.1's corollary: the alt screen is not a verdict, and a program can write
  // on it exactly as on the normal screen. That content is destroyed when the
  // program leaves the alt screen, so this sink is the only record of it.
  const terminal = createTerminal({ cols: 24, rows: 5 });
  const log = new TextLog(terminal);

  await feed(terminal, log, '\x1b[?1049h');
  await feed(terminal, log, 'alt one\r\nalt two\r\n');

  const lines = log.drain();
  assert.deepEqual(
    lines.map((l) => l.text),
    ['alt one', 'alt two'],
  );
  assert.ok(
    lines.every((l) => l.buffer === 'alternate'),
    'the buffer is recorded as context, so a caller can tell the two apart',
  );

  await feed(terminal, log, '\x1b[?1049l');
  assert.deepEqual(log.drain(), [], 'leaving the alt screen completes no line of its own');
  terminal.dispose();
  log.dispose();
});

test('byte stamps locate a line in the delivery that produced it', async () => {
  const terminal = createTerminal({ cols: 20, rows: 5 });
  const log = new TextLog(terminal);

  await feed(terminal, log, 'first\r\n'); // 7 bytes
  await feed(terminal, log, 'second\r\n'); // 8 more

  const lines = log.drain();
  assert.deepEqual(
    lines.map((l) => l.byte),
    [7, 15],
    'each line carries the offset the delivery ended at',
  );
  terminal.dispose();
  log.dispose();
});

test('drain empties the log, so nothing is counted twice', async () => {
  const terminal = createTerminal({ cols: 20, rows: 5 });
  const log = new TextLog(terminal);
  await feed(terminal, log, 'one\r\n');

  assert.equal(log.drain().length, 1);
  assert.equal(log.drain().length, 0, 'a second drain has nothing left');
  terminal.dispose();
  log.dispose();
});
