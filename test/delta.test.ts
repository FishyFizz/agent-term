/**
 * Grid deltas — what changed between two screens.
 *
 * The load-bearing claim is that a delta reproduces the screen exactly. These
 * test it against real emulator output where they can, and against synthetic
 * grids for the cases the emulator cannot be made to produce on demand (a
 * saturated scrollback ring, in particular).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel, type ScreenSnapshot, type StyleRun } from '../src/screen.js';
import { applyDelta, gridDelta } from '../src/delta.js';

/** Feed `before`, snapshot, feed `after`, snapshot — a real pair from the emulator. */
async function pair(cols: number, rows: number, before: string, after: string) {
  const s = new ScreenModel(cols, rows);
  await s.feed(before);
  const b = s.snapshot();
  await s.feed(after);
  const a = s.snapshot();
  return { b, a };
}

/**
 * A hand-built snapshot, for shapes the emulator will not make on request.
 *
 * Padded to a full grid, and padded in **columns** rather than characters: a
 * delta's row runs and an epoch's row count are both read off this, so a short
 * array would test a screen the emulator cannot produce. `appearance` lets a
 * test give rows colour and wide glyphs.
 */
function snap(
  cols: number,
  rows: number,
  lines: string[],
  appearance: { styles?: StyleRun[][]; wide?: number[][] } = {},
): ScreenSnapshot {
  const wide = appearance.wide ?? [];
  const padded: string[] = [];
  for (let y = 0; y < rows; y++) {
    const raw = lines[y] ?? '';
    const starts = wide[y] ?? [];
    let columns = 0;
    for (let g = 0; g < raw.length; g++) columns += starts.includes(columns) ? 2 : 1;
    padded.push(raw + ' '.repeat(Math.max(0, cols - columns)));
  }
  return {
    lines: padded,
    styles: appearance.styles ?? padded.map(() => []),
    wide: wide.length ? wide : padded.map(() => []),
    cols,
    rows,
    buffer: 'normal',
    cursorX: 0,
    cursorY: 0,
    hasScrollback: true,
  };
}

function cells(delta: { runs: Array<{ text: string }> }): number {
  return delta.runs.reduce((n, r) => n + r.text.length, 0);
}

test('a delta round-trips to the exact screen', async () => {
  const { b, a } = await pair(20, 5, 'one\r\ntwo\r\n', 'three\r\nfour\r\n');
  const d = gridDelta(b, a);
  assert.ok(d, 'a delta was produced');
  assert.deepEqual(applyDelta(b, d).lines, a.lines);
});

test('nothing changed: an empty delta, at no cost', async () => {
  const { a } = await pair(20, 5, 'same\r\n', '');
  const d = gridDelta(a, a);
  assert.deepEqual(d, { scrollBy: 0, runs: [], rows: [] });
  assert.deepEqual(applyDelta(a, d!).lines, a.lines);
});

test('one new line in a scrolling log is a shift plus a run, not a full grid', async () => {
  // The case the whole design exists for. A naive row diff says nearly every
  // row changed, because the content shifted; that would retain a whole screen
  // per line of a build log.
  const { b, a } = await pair(20, 5, 'l1\r\nl2\r\nl3\r\nl4\r\nl5\r\n', 'l6\r\n');
  const differing = b.lines.filter((l, y) => l !== a.lines[y]).length;
  assert.ok(differing >= 4, `the naive diff really does look like a full repaint (${differing}/5 rows)`);

  const d = gridDelta(b, a);
  assert.ok(d);
  assert.ok(cells(d) <= 4, `encoded in ${cells(d)} cells, not ${20 * 5}`);
  assert.deepEqual(applyDelta(b, d).lines, a.lines);
});

test('a repaint confined to one row stays confined to one row', async () => {
  const base = Array.from({ length: 5 }, (_, i) => `row ${i}\r\n`).join('');
  const { b, a } = await pair(24, 5, base, '\x1b[5;1H\x1b[2Kstatus: 42%');
  const d = gridDelta(b, a);
  assert.ok(d);
  assert.equal(d.runs.length, 1, 'one run');
  assert.equal(d.runs[0]?.y, 4);
  assert.deepEqual(applyDelta(b, d).lines, a.lines);
});

test('a blanked row round-trips', async () => {
  const { b, a } = await pair(12, 3, 'abcdef\r\nghijkl\r\n', '\x1b[2;1H\x1b[2K');
  const d = gridDelta(b, a);
  assert.ok(d);
  assert.deepEqual(applyDelta(b, d).lines, a.lines);
  assert.equal(a.lines[1], ' '.repeat(12), 'the row really is blank now');
});

test('a wholly different screen is not worth a delta', () => {
  const before = snap(4, 2, ['aaaa', 'bbbb']);
  const after = snap(4, 2, ['cccc', 'dddd']);
  assert.equal(gridDelta(before, after), null, 'no delta smaller than the screen exists');
});

test('a different size or buffer is not a delta', async () => {
  const four = snap(8, 4, ['a', 'b', 'c', 'd']);
  const three = snap(8, 3, ['a', 'b', 'c']);
  assert.equal(gridDelta(four, three), null, 'a resize is a new epoch, not a change');

  const alt = { ...snap(8, 4, ['a', 'b', 'c', 'd']), buffer: 'alternate' as const };
  assert.equal(gridDelta(four, alt), null, 'a buffer swap is a wholesale replace');
});

test('an unusable hint does not stop an exact encoding', () => {
  // The saturated-scrollback case. `IBuffer.baseY` freezes once the ring is
  // full, so the caller's viewport hint is 0 while the content keeps moving.
  // The shift is then found by search -- and, crucially, verified.
  const before = snap(10, 4, ['a1', 'a2', 'a3', 'a4']);
  const after = snap(10, 4, ['a2', 'a3', 'a4', 'a5']);

  const d = gridDelta(before, after, 0);
  assert.ok(d, 'encoded without a usable hint');
  assert.equal(d.scrollBy, 1, 'the search recovered the real shift');
  assert.deepEqual(applyDelta(before, d).lines, after.lines);
});

test('the shift chosen is whichever is cheapest, not necessarily the real one', () => {
  // A 3-line scroll across 4 rows can also be described as a smaller shift plus
  // more runs. Either is exact; the encoder takes the smaller. Safe because the
  // next delta is computed against the real screen, never against this.
  const before = snap(10, 4, ['a1', 'a2', 'a3', 'a4']);
  const after = snap(10, 4, ['a4', 'b1', 'b2', 'b3']);

  const d = gridDelta(before, after, 0);
  assert.ok(d);
  assert.ok(cells(d) < 4 * 10, 'cheaper than storing the grid');
  assert.deepEqual(applyDelta(before, d).lines, after.lines, 'and exact regardless of which shift it picked');
});

test('a correct hint is used as given', () => {
  const before = snap(10, 4, ['a1', 'a2', 'a3', 'a4']);
  const after = snap(10, 4, ['a2', 'a3', 'a4', 'a5']);
  assert.equal(gridDelta(before, after, 1)?.scrollBy, 1);
});

test('a delta survives a chain of applications', async () => {
  // Deltas are encoded pairwise against the real screen, so a long chain must
  // not drift. This is the cheap version of the corpus-wide round-trip.
  const s = new ScreenModel(20, 4);
  await s.feed('start\r\n');
  let current = s.snapshot();
  const original = current;
  for (let i = 0; i < 12; i++) {
    await s.feed(`line ${i}\r\n`);
    const next = s.snapshot();
    const d = gridDelta(current, next);
    assert.ok(d, `step ${i} encoded`);
    current = applyDelta(current, d);
    assert.deepEqual(current.lines, next.lines, `step ${i} still exact`);
  }
  assert.notDeepEqual(current.lines, original.lines, 'and the screen really did change');
});

test('a change of colour alone is not "nothing happened"', () => {
  // The trap, and the reason cost counts appearance. A restyle leaves every
  // glyph identical, so a text-only encoder finds no change, returns an empty
  // delta at zero cost -- and the recolour is silently gone. Worse, that is the
  // *cheap* path: the zero-cost answer short-circuits the search above.
  const before = snap(8, 2, ['same', 'text']);
  const after = snap(8, 2, ['same', 'text'], {
    styles: [[], [{ from: 0, to: 4, style: 'fg1' }]],
  });

  const d = gridDelta(before, after);
  assert.ok(d, 'the restyle was encoded rather than passed over');
  assert.deepEqual(d.runs, [], 'not one glyph changed');
  assert.equal(d.rows.length, 1, 'but the row did');
  assert.deepEqual(d.rows[0]?.styles, [{ from: 0, to: 4, style: 'fg1' }]);
  assert.deepEqual(applyDelta(before, d).styles, after.styles, 'and it round-trips');
});

test('a restyle is far cheaper than storing the grid', () => {
  const before = snap(40, 4, ['aaaa', 'bbbb', 'cccc', 'dddd']);
  const after = snap(40, 4, ['aaaa', 'bbbb', 'cccc', 'dddd'], {
    styles: [
      [{ from: 0, to: 40, style: 'bg1' }],
      [{ from: 0, to: 40, style: 'bg1' }],
      [{ from: 0, to: 40, style: 'bg1' }],
      [{ from: 0, to: 40, style: 'bg1' }],
    ],
  });
  const d = gridDelta(before, after);
  assert.ok(d, 'encoded');
  assert.equal(d.rows.length, 4, 'one payload per restyled row');
  assert.deepEqual(applyDelta(before, d).styles, after.styles);
});

test('colour is dropped from a row that goes back to default', () => {
  const before = snap(8, 2, ['red', ''], { styles: [[{ from: 0, to: 3, style: 'fg1' }], []] });
  const after = snap(8, 2, ['red', '']);
  const d = gridDelta(before, after);
  assert.ok(d, 'the removal of colour is a change too');
  assert.deepEqual(applyDelta(before, d).styles, [[], []], 'and it round-trips back to default');
});

test('a change introducing a wide glyph carries its column mapping', () => {
  const before = snap(8, 2, ['ab', '']);
  const after = snap(8, 2, ['a中', ''], { wide: [[1], []] });

  const d = gridDelta(before, after);
  assert.ok(d, 'encoded');
  assert.deepEqual(d.rows[0]?.wide, [1], 'the wide column is part of the change');

  const back = applyDelta(before, d);
  assert.deepEqual(back.lines, after.lines);
  assert.deepEqual(back.wide, after.wide, 'and the column mapping survives');
});

test('colour rides along a scroll, in the right rows', () => {
  // Appearance has to shift in lockstep with the glyphs, or a scrolling log
  // repaints its colours one row off for the rest of the session.
  const before = snap(8, 3, ['one', 'two', 'three'], {
    styles: [[{ from: 0, to: 3, style: 'fg1' }], [], [{ from: 0, to: 5, style: 'fg2' }]],
  });
  const after = snap(8, 3, ['two', 'three', 'four'], {
    styles: [[], [{ from: 0, to: 5, style: 'fg2' }], []],
  });

  const d = gridDelta(before, after, 1);
  assert.ok(d, 'encoded');
  const back = applyDelta(before, d);
  assert.deepEqual(back.lines, after.lines);
  assert.deepEqual(back.styles, after.styles, 'the colour moved with its row');
});
