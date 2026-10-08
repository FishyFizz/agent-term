/**
 * A read bounded by what the caller can carry, not by how much there is.
 *
 * The driver that comes back after a long gap is the case: three hundred
 * groups happened while it was away, and asking for all of them is asking to
 * have its context blown. The budget is in characters because that is the
 * budget a caller actually has — "do not blow up my context", not "fifty".
 *
 * Two properties are the whole point, and both are about honesty rather than
 * saving space:
 *
 *  1. The cut lands **at a whole seq**. A half screen would read as the state,
 *     which is a lie the caller cannot detect.
 *  2. What was left out is **counted and anchored**, never silently dropped.
 *     The screen at the cut is what makes the gap resumable instead of a hole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHistory } from '../src/history.js';
import { gridDelta } from '../src/delta.js';
import type { ScreenSnapshot } from '../src/screen.js';
import type { TextLine } from '../src/text-log.js';

function snapshot(cols: number, rows: number, lines: string[]): ScreenSnapshot {
  const padded: string[] = [];
  for (let y = 0; y < rows; y++) padded.push((lines[y] ?? '').padEnd(cols, ' '));
  return {
    lines: padded,
    styles: padded.map(() => []),
    wide: padded.map(() => []),
    cols,
    rows,
    buffer: 'normal',
    cursorX: 0,
    cursorY: 0,
    hasScrollback: true,
  };
}

/**
 * Feed `n` deliveries, each with a single text line of a known length, so the
 * cost of each is exactly `lineLength` and the budget arithmetic is checkable
 * by hand rather than measured.
 */
function feed(history: SessionHistory, n: number, lineLength: number): void {
  let previous: ScreenSnapshot | null = null;
  let byte = 0;
  for (let i = 0; i < n; i++) {
    const text = 'x'.repeat(lineLength);
    const lines = [text];
    const screen = snapshot(40, 4, lines);
    const fromByte = byte;
    byte += text.length;
    const tl: TextLine[] = [{ byte: fromByte, buffer: 'normal', text }];
    history.push({
      seq: i + 1,
      group: i + 1,
      at: 1000 + i,
      fromByte,
      toByte: byte,
      text: tl,
      scrolledRows: 0,
      grid: previous ? gridDelta(previous, screen) : null,
      screen,
    });
    previous = screen;
  }
}

test('maxChars cuts at a whole delivery and returns the newest end', () => {
  const history = new SessionHistory('s');
  feed(history, 10, 20); // 10 deliveries, 20 chars each

  // Budget for 3 whole deliveries.
  const page = history.readBack({ level: 'text', maxChars: 60 });
  assert.equal(page.level, 'text');
  if (page.level !== 'text') throw new Error('unreachable');

  // The newest three, not the oldest three: an agent returning after a gap
  // can act on what just happened and cannot act on what it slept through.
  assert.equal(page.lines.length, 3);
  assert.deepEqual(
    page.lines.map((l) => l.text),
    ['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(20)],
  );

  // Omission is reported, never silent.
  assert.equal(page.omitted.count, 7);
  assert.equal(page.omitted.reason, 'budget');
  // The anchor is addressable, so the gap can be resumed by seq.
  assert.equal(page.omitted.fromSeq, 7);
  // And a screen comes with it.
  assert.ok(page.omitted.screen !== null);
});

test('maxChars never cuts inside a delivery', () => {
  const history = new SessionHistory('s');
  feed(history, 10, 20);

  // 61 is one char past three deliveries but short of four. If the cut were
  // allowed mid-delivery this would return 3.05 deliveries' worth of text.
  const page = history.readBack({ level: 'text', maxChars: 61 });
  if (page.level !== 'text') throw new Error('unreachable');
  assert.equal(page.lines.length, 3, 'the fourth does not fit, so it is not partly returned');
  assert.equal(page.omitted.count, 7);
});

test('a single delivery over the whole budget still comes back in full', () => {
  const history = new SessionHistory('s');
  feed(history, 3, 100);

  // Nothing fits, but returning nothing would be worse: the caller asked to
  // see this and a truncated screen would be unreadable.
  const page = history.readBack({ level: 'text', maxChars: 10 });
  if (page.level !== 'text') throw new Error('unreachable');
  assert.equal(page.lines.length, 1);
  assert.equal(page.lines[0]!.text.length, 100);
  assert.equal(page.omitted.count, 2);
});

test('no budget means nothing is omitted', () => {
  const history = new SessionHistory('s');
  feed(history, 5, 10);

  const page = history.readBack({ level: 'text' });
  assert.equal(page.omitted.count, 0);
  assert.equal(page.omitted.reason, 'none');
  assert.equal(page.omitted.screen, null);
  assert.equal(page.omitted.fromSeq, null);
  assert.equal(page.omitted.overBudget, false);
});

test('a budget that did not hold is reported, not left to be inferred', () => {
  const history = new SessionHistory('s');
  feed(history, 3, 100);

  // One delivery is bigger than the whole budget, and it comes back in full
  // rather than truncated -- half a screen would read as the state. The count
  // alone cannot say that: `count: 2` looks the same as a budget that fit.
  const page = history.readBack({ level: 'text', maxChars: 10 });
  if (page.level !== 'text') throw new Error('unreachable');
  assert.equal(page.omitted.overBudget, true, 'the budget did not hold');
  assert.equal(page.omitted.reason, 'budget', 'and re-reading with a bigger one is the fix');

  // The same read that fits says so.
  const fits = history.readBack({ level: 'text', maxChars: 400 });
  assert.equal(fits.omitted.overBudget, false, 'a budget that held is not a warning');
  assert.equal(fits.omitted.reason, 'none');
});

test('the budget counts the shape actually returned — a screen costs more than a line', () => {
  const history = new SessionHistory('s');
  feed(history, 10, 5); // 10 small text lines, but each screen is 40x4 = 160 chars

  // Same budget, two shapes. With `screen` on, the screen dominates, so fewer
  // deliveries fit than the text-only read would allow.
  const withText = history.readBack({ level: 'text', maxChars: 20 });
  const withScreen = history.readBack({ level: 'records', maxChars: 340, screen: true });

  assert.equal(withText.omitted.reason, 'budget');
  assert.equal(withScreen.omitted.reason, 'budget');
  // 340 chars / 160 per screen = 2 screens
  assert.equal(withScreen.omitted.count, 8);
});

/**
 * A span is the read a driver makes with a `collapsed.rawFrom..rawTo` in hand,
 * so it is the one an unbounded answer hurts most. It gets the same caps as a
 * page and reports them the same way — from the other end, because a span is
 * opened at an address the caller chose and read forward.
 */
test('a span is bounded too, and cut from the oldest end', () => {
  const history = new SessionHistory('s');
  feed(history, 10, 20);

  const span = history.span({ seq: 1 }, { seq: 10 }, { level: 'text', maxChars: 60 });
  assert.deepEqual(
    span.records.map((r) => r.seq),
    [1, 2, 3],
    'the beginning of the span, not the end: this read goes forward',
  );
  assert.equal(span.truncated, true);
  assert.equal(span.omitted.count, 7);
  assert.equal(span.omitted.reason, 'budget');
  // The first delivery that did not come back, so the rest resumes there.
  assert.equal(span.omitted.fromSeq, 4);
  assert.ok(span.omitted.screen !== null, 'with the anchor screen, so the gap is resumable');
});

test('a span honours `limit`, and says how much it left out', () => {
  const history = new SessionHistory('s');
  feed(history, 10, 20);

  const span = history.span({ seq: 1 }, { seq: 10 }, { limit: 4 });
  assert.deepEqual(span.records.map((r) => r.seq), [1, 2, 3, 4]);
  assert.equal(span.truncated, true, 'a cut is never silent');
  assert.equal(span.omitted.count, 6);
  assert.equal(span.omitted.reason, 'count', 'the count is what was cut, and the fix is a bigger one');
  assert.equal(span.omitted.fromSeq, 5);
});

test('a span with nothing to cut reports nothing omitted', () => {
  const history = new SessionHistory('s');
  feed(history, 3, 20);

  const span = history.span({ seq: 1 }, { seq: 3 });
  assert.equal(span.records.length, 3);
  assert.equal(span.truncated, false);
  assert.equal(span.omitted.reason, 'none');
  assert.equal(span.omitted.count, 0);
  assert.equal(span.omitted.screen, null);
  assert.equal(span.omitted.fromSeq, null);
});

test('a span over the whole budget still returns its first delivery in full', () => {
  const history = new SessionHistory('s');
  feed(history, 3, 100);

  const span = history.span({ seq: 1 }, { seq: 3 }, { level: 'text', maxChars: 10 });
  assert.equal(span.records.length, 1, 'one delivery is the floor, however big it is');
  assert.equal(span.records[0]!.text[0]!.text.length, 100, 'and it is not truncated');
  assert.equal(span.omitted.overBudget, true);
  assert.equal(span.omitted.fromSeq, 2);
});
