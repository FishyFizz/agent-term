/**
 * L0.2 — the screen is a faithful structured model, never a byte stream.
 *
 * These run against the real emulator with hand-written escape sequences, so
 * they are unit tests rather than end-to-end ones: the claim under test is
 * "our model of the grid is correct", and the differential test against real
 * terminals (PRIOR-ART.md §8) is what extends that to "faithful".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel } from '../src/screen.js';

/** Feed and wait. `feed` is async because terminal.write is. */
async function screen(cols: number, rows: number, ...writes: string[]): Promise<ScreenModel> {
  const s = new ScreenModel(cols, rows);
  for (const w of writes) await s.feed(w);
  return s;
}

test('snapshot reflects a write only after feed resolves', async () => {
  const s = new ScreenModel(20, 5);
  await s.feed('hello');
  assert.equal(s.snapshot().lines[0], 'hello'.padEnd(20, ' '), 'content visible after await');

  // The async hazard this guards: reading before the callback fires.
  const s2 = new ScreenModel(20, 5);
  const pending = s2.feed('world');
  // Deliberately not awaited -- but we then must await before asserting, or we
  // are testing a race. The real guard is that feed() returns a promise at all.
  assert.ok(pending instanceof Promise, 'feed returns a promise callers must await');
  await pending;
  assert.equal(s2.snapshot().lines[0], 'world'.padEnd(20, ' '));
});

test('grid dimensions and padding are exact', async () => {
  const s = await screen(12, 3, 'ab');
  const snap = s.snapshot();
  assert.equal(snap.cols, 12);
  assert.equal(snap.rows, 3);
  assert.equal(snap.lines.length, 3, 'exactly rows lines');
  for (const line of snap.lines) assert.equal(line.length, 12, 'every row is cols wide');
  assert.equal(snap.lines[0], 'ab          ');
});

test('cursor position is reported', async () => {
  const s = await screen(20, 5, 'abc');
  const snap = s.snapshot();
  assert.equal(snap.cursorY, 0);
  assert.equal(snap.cursorX, 3, 'cursor sits after the written text');
});

test('scrolling appends and drops the top line', async () => {
  const s = new ScreenModel(20, 3);
  await s.feed('l1\r\nl2\r\nl3\r\nl4');
  const snap = s.snapshot();
  assert.deepEqual(
    snap.lines.map((l) => l.trimEnd()),
    ['l2', 'l3', 'l4'],
    'viewport scrolled by one; the oldest line left the viewport',
  );
  // On the normal buffer the line is still in scrollback, not destroyed.
  assert.equal(s.terminal.buffer.active.type, 'normal');
  assert.ok(
    s.terminal.buffer.active.length >= 3,
    'normal buffer retains scrollback beyond the viewport',
  );
});

test('alt screen is entered, has no scrollback, and restores on exit', async () => {
  const s = new ScreenModel(20, 5);
  await s.feed('base\r\n');
  const before = s.snapshot();
  assert.equal(before.buffer, 'normal');
  assert.ok(before.hasScrollback);

  await s.feed('\x1b[?1049h');
  assert.equal(s.snapshot().buffer, 'alternate', 'alt screen active');
  assert.equal(s.snapshot().hasScrollback, false, 'alt buffer has no scrollback');

  // CLASSIFIER.md §3.4: writing on the alt screen is still just writing.
  await s.feed('A1\r\nA2\r\nA3\r\nA4\r\nA5\r\nA6\r\nA7');
  const alt = s.snapshot();
  assert.equal(alt.buffer, 'alternate');
  assert.equal(
    s.terminal.buffer.alternate.length,
    5,
    'alt buffer length stays fixed at rows -- content beyond it is gone',
  );

  await s.feed('\x1b[?1049l');
  const after = s.snapshot();
  assert.equal(after.buffer, 'normal', 'normal buffer restored');
  assert.equal(after.lines[0], before.lines[0], 'pre-alt content survived');
  assert.ok(
    !after.lines.some((l) => l.includes('A1')),
    'alt content was destroyed on exit -- capture while live is mandatory',
  );
});

test('resize reflows and updates reported dimensions', async () => {
  const s = await screen(20, 5, 'hello');
  s.resize(40, 10);
  const snap = s.snapshot();
  assert.equal(snap.cols, 40);
  assert.equal(snap.rows, 10);
  assert.equal(snap.lines.length, 10);
  for (const line of snap.lines) assert.equal(line.length, 40);
  assert.equal(snap.lines[0], 'hello'.padEnd(40, ' '));
  assert.throws(() => s.resize(0, 10), RangeError);
});

test('snapshot captures the viewport, not the top of scrollback', async () => {
  // Regression: getLine(y) is an index into the whole buffer including
  // scrollback. Reading it as a viewport index silently returns the oldest
  // retained line instead of what is on screen, and scrolling then appears
  // not to happen at all.
  const s = new ScreenModel(20, 3);
  await s.feed('l1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7');
  const snap = s.snapshot();
  assert.deepEqual(
    snap.lines.map((l) => l.trimEnd()),
    ['l5', 'l6', 'l7'],
    'shows the newest 3 lines, not l1..l3',
  );
  assert.ok(
    s.terminal.buffer.active.viewportY > 0,
    'viewport has scrolled off the top of the buffer',
  );
});

test('erase and cursor addressing are honoured', async () => {
  const s = await screen(20, 3, 'aaaa');
  // CUP to row 1 col 1, then erase to end of line.
  await s.feed('\x1b[1;1H\x1b[K');
  assert.equal(s.snapshot().lines[0]!.trimEnd(), '', 'EL cleared the row');
  await s.feed('zz');
  assert.equal(s.snapshot().lines[0]!.trimEnd(), 'zz', 'content written after erase');
  assert.equal(s.snapshot().cursorX, 2);
});
