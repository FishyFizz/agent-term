/**
 * The text log — the classifier's first sink.
 *
 * These pin the recorded measurements, because each one is a claim
 * the history design rests on: if the log stops being lossless past the
 * scrollback horizon, history's "page back to any earlier part of that build"
 * quietly stops being satisfiable, and nothing else would notice.
 *
 * They drive `ScreenModel.feed` rather than a bare `TextLog`, because capture
 * is not a property of the log alone any more: a line is *triggered* by a
 * completion signal and *judged* against the diff of the feed that carries it.
 * A test that writes to the terminal directly exercises neither the second
 * trigger nor the judgement, and would pass while both were broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel, type ScreenFacts } from '../src/screen.js';
import type { TextLine } from '../src/text-log.js';

/** Feed a screen and hand back the lines that feed produced. */
function feed(screen: ScreenModel, data: string | Buffer): Promise<TextLine[]> {
  return screen.feed(data).then((facts: ScreenFacts) => facts.text);
}

test('every completed line is captured, in order', async () => {
  const screen = new ScreenModel(20, 5);
  const lines = await feed(screen, 'alpha\r\nbeta\r\ngamma\r\n');

  assert.deepEqual(
    lines.map((l) => l.text),
    ['alpha', 'beta', 'gamma'],
  );
  screen.dispose();
});

test('repeated lines are kept — this is a log, not a set', async () => {
  const screen = new ScreenModel(20, 5);
  const lines = await feed(screen, 'Compiling a\r\nCompiling a\r\nCompiling a\r\n');

  assert.equal(lines.length, 3, 'a build log that repeats a line is the common case');
  assert.deepEqual(
    lines.map((l) => l.text),
    ['Compiling a', 'Compiling a', 'Compiling a'],
  );
  screen.dispose();
});

test('lines survive a scrollback overflow', async () => {
  // The decisive case: the buffer is deliberately far too small to hold the
  // output, so anything reading the grid loses it. This is why the trigger is a
  // per-line signal and cannot be the diff -- a before/after comparison of the
  // whole run would see only the last five rows.
  const screen = new ScreenModel(20, 5, 10);

  const N = 200;
  const lines: TextLine[] = [];
  for (let i = 0; i < N; i++) lines.push(...(await feed(screen, `line ${i}\r\n`)));

  assert.equal(lines.length, N, `captured every line, though the buffer holds only ${screen.terminal.buffer.active.length}`);
  assert.equal(lines[0]?.text, 'line 0', 'the oldest line is the one the buffer dropped first');
  assert.equal(lines[N - 1]?.text, `line ${N - 1}`);
  assert.equal(new Set(lines.map((l) => l.text)).size, N, 'none dropped, none duplicated');
  assert.ok(
    screen.terminal.buffer.active.length <= 15,
    `the buffer really did overflow (length ${screen.terminal.buffer.active.length})`,
  );

  screen.dispose();
});

test('a line ended by cursor positioning is captured, not only by a linefeed', async () => {
  // The Windows case, and the reason the trigger is not just `onLineFeed`.
  // ConPTY terminates a program's output by positioning the cursor, so the
  // linefeed count for the feed is zero:
  //
  //   echo RAW-CHECK<LF> <ESC>[?25l RAW-CHECK <ESC>[7;1H prompt><ESC>[?25h
  //
  // The line reaches the screen either way, so a log that missed it would
  // disagree with the screen -- the one thing it must never do.
  const screen = new ScreenModel(40, 8);
  await feed(screen, 'PS> echo RAW-CHECK\r\n');
  const lines = await feed(screen, '\x1b[?25lRAW-CHECK\x1b[7;1HPS> \x1b[?25h');

  assert.deepEqual(
    lines.map((l) => l.text),
    ['RAW-CHECK'],
    'the output line is captured even though nothing emitted a linefeed for it',
  );
  assert.ok(
    screen.snapshot().lines.some((l) => l.trim() === 'RAW-CHECK'),
    'and the screen agrees it is there',
  );
  screen.dispose();
});

test('the first paint is text; a repaint of the same rows is not', async () => {
  // A program drawing onto blank cells is indistinguishable from appending, so
  // it is recorded -- the agent sees the full draw either way. A frame that
  // rewrites rows it already wrote is a repaint, and the screen diff says so.
  const screen = new ScreenModel(24, 5);
  const paint = (tag: string): string => {
    let frame = '\x1b[?1049h';
    for (let row = 0; row < 5; row++) frame += `\x1b[${row + 1};1H\x1b[2K${tag} ${row}`;
    return frame;
  };

  const first = await feed(screen, paint('row'));
  assert.deepEqual(
    first.map((l) => l.text),
    ['row 0', 'row 1', 'row 2', 'row 3'],
    'rows above the cursor arrived on blank cells: that is text',
  );

  const second = await feed(screen, paint('other'));
  assert.deepEqual(second, [], 'rewriting rows that already held content is a repaint');
  screen.dispose();
});

test('lines written on the alt screen are captured, and marked', async () => {
  // A corollary: the alt screen is not a verdict, and a program can write
  // on it exactly as on the normal screen. That content is destroyed when the
  // program leaves the alt screen, so this sink is the only record of it.
  const screen = new ScreenModel(24, 5);
  await feed(screen, '\x1b[?1049h');
  const lines = await feed(screen, 'alt one\r\nalt two\r\n');

  assert.deepEqual(
    lines.map((l) => l.text),
    ['alt one', 'alt two'],
  );
  assert.ok(
    lines.every((l) => l.buffer === 'alternate'),
    'the buffer is recorded as context, so a caller can tell the two apart',
  );

  const after = await feed(screen, '\x1b[?1049l');
  assert.deepEqual(after, [], 'leaving the alt screen completes no line of its own');
  screen.dispose();
});

test('byte stamps locate a line in the delivery that produced it', async () => {
  const screen = new ScreenModel(20, 5);
  await feed(screen, 'first\r\n'); // 7 bytes
  const lines = await feed(screen, 'second\r\n'); // 8 more

  assert.deepEqual(
    lines.map((l) => l.byte),
    [15],
    'a line carries the offset its delivery ended at',
  );
  screen.dispose();
});

test('a line is reported once, by the feed that completed it', async () => {
  const screen = new ScreenModel(20, 5);
  const first = await feed(screen, 'one\r\n');
  assert.equal(first.length, 1);

  const second = await feed(screen, '\r\n');
  assert.deepEqual(
    second.map((l) => l.text),
    [''],
    'the second feed reports its own blank line and does not repeat the first',
  );
  screen.dispose();
});
