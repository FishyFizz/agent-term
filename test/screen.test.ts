/**
 * L0.2 — the screen is a faithful structured model, never a byte stream.
 *
 * These run against the real emulator with hand-written escape sequences, so
 * they are unit tests rather than end-to-end ones: the claim under test is
 * "our model of the grid is correct", and the differential conformance the
 * survey recommends (PRIOR-ART.md, "Decisions taken from this survey") is what
 * extends that to "faithful".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel, columnOf, glyphAtColumn, styleAt } from '../src/screen.js';

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

test('an unstyled screen carries no appearance at all', async () => {
  const s = await screen(10, 2, 'plain\r\ntext');
  const snap = s.snapshot();
  assert.deepEqual(snap.styles, [[], []], 'empty per row: the common case, and free');
  assert.deepEqual(snap.wide, [[], []]);
  assert.equal(snap.lines[0]!.length, 10, 'and a row is still exactly cols characters');
});

test('SGR attributes become canonical appearance keys', async () => {
  const s = await screen(12, 1, '\x1b[31mred\x1b[0m \x1b[1;32mbold\x1b[0m');
  const snap = s.snapshot();
  assert.equal(styleAt(snap, 0, 0), 'fg1', 'palette colour');
  assert.equal(styleAt(snap, 0, 3), '', 'reset returns to the default appearance');
  assert.equal(styleAt(snap, 0, 4), 'fg2 bold', 'flagged and coloured, in canonical order');
  assert.deepEqual(
    snap.styles[0],
    [
      { from: 0, to: 3, style: 'fg1' },
      { from: 4, to: 8, style: 'fg2 bold' },
    ],
    'runs cover the coloured spans and leave the default gap out',
  );
});

test('foreground, background and truecolour stay distinct', async () => {
  const s = await screen(12, 1, '\x1b[38;2;255;0;128mX\x1b[0m\x1b[48;2;0;16;255mY\x1b[0m');
  const snap = s.snapshot();
  assert.equal(styleAt(snap, 0, 0), 'fg#ff0080', 'a 24-bit foreground is not a palette index');
  assert.equal(styleAt(snap, 0, 1), 'bg#0010ff', 'and a background-only cell is not the default');
});

test('inverse is an attribute, not a colour', async () => {
  // What `cli.menu-selector` selects with, so this is real corpus material.
  const s = await screen(8, 1, '\x1b[7mselected\x1b[0m');
  assert.equal(styleAt(s.snapshot(), 0, 0), 'inverse');
});

test('appearance is indexed by column, not by glyph', async () => {
  const s = await screen(10, 1, '\x1b[31mab\x1b[0m中文');
  const snap = s.snapshot();
  assert.equal(snap.lines[0], 'ab中文    ', 'six glyphs: four written, two blank columns');
  assert.deepEqual(snap.styles[0], [{ from: 0, to: 2, style: 'fg1' }], 'columns 0-1 are red');
  assert.deepEqual(snap.wide[0], [2, 4], 'and the wide glyphs start at columns 2 and 4');
});

test('a double-width glyph takes two columns and one string index', async () => {
  const s = await screen(10, 1, 'ab中文cd');
  const snap = s.snapshot();

  // Ten columns, eight glyphs: two of them double-width.
  assert.equal(snap.lines[0], 'ab中文cd  ');
  assert.equal(snap.lines[0]!.length, 8);
  assert.deepEqual(snap.wide[0], [2, 4]);

  assert.equal(columnOf(snap, 0, 0), 0);
  assert.equal(columnOf(snap, 0, 2), 2, 'the first wide glyph starts at column 2');
  assert.equal(columnOf(snap, 0, 3), 4, 'and the next at 4, not 3');
  assert.equal(columnOf(snap, 0, 4), 6, 'so plain text after them is pushed right');

  assert.equal(glyphAtColumn(snap, 0, 1), 1);
  assert.equal(glyphAtColumn(snap, 0, 3), -1, 'column 3 is the tail of a wide glyph');
  assert.equal(glyphAtColumn(snap, 0, 6), 4, 'column 6 holds the fifth glyph');
  assert.equal(glyphAtColumn(snap, 0, 10), -1, 'and past the grid is nothing');
});

test('the cursor is a column number, which is what a wide row needs', async () => {
  const s = await screen(10, 1, 'ab中文cd');
  // Six glyphs, but eight columns: a cursor reported in glyphs would put the
  // next character in the wrong place.
  assert.equal(s.snapshot().cursorX, 8);
  assert.equal(s.snapshot().lines[0]!.length, 8, 'even though there are only 8 glyphs');
});

test('application cursor keys is read from the program, not assumed', async () => {
  // A key's bytes depend on this mode -- an arrow is CSI normally and SS3 when
  // the program has set DECCKM -- so the model has to report what the program
  // asked for rather than a default. `keys.ts` never guesses it.
  const s = new ScreenModel(20, 5);
  assert.equal(s.modes.applicationCursorKeys, false, 'off until the program says otherwise');

  await s.feed('\x1b[?1h');
  assert.equal(s.modes.applicationCursorKeys, true, 'CSI ? 1 h turns it on');

  await s.feed('\x1b[?1l');
  assert.equal(s.modes.applicationCursorKeys, false, 'and CSI ? 1 l turns it off again');
});

test('a mode set in the middle of output is reflected once it is parsed', async () => {
  // The honest caveat on `modes`: it reports what has been parsed, so a mode
  // that has been written but not yet fed is not in it. That is why the mode is
  // read after waiting for output rather than concurrently with it.
  const s = new ScreenModel(20, 5);
  const pending = s.feed('setting up\x1b[?1hmore');
  assert.equal(s.modes.applicationCursorKeys, false, 'not reflected before the feed resolves');

  await pending;
  assert.equal(s.modes.applicationCursorKeys, true, 'reflected after it');
});
