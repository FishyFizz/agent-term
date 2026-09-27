/**
 * One surface over one timeline.
 *
 * Paging and playback were going to be two tools. They are the same operation:
 * both address the timeline and ask what is there, differing only in whether
 * the screen at each point is materialized and over how wide a span. These
 * tests are the ones that would not exist if they were two tools -- that a
 * span opens with any address kind, that the two ends need not match, that a
 * span crosses a resize while a page refuses to, and that `screen` is what
 * separates the two readings.
 *
 * Built the same way `history.test.ts` builds them: driven directly, so the
 * shapes that matter (a resize inside a span) can be made exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHistory, type HistoryInput, type HistoryReadResult } from '../src/history.js';
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

/** Narrow the result to the `records` projection, so no cast is needed. */
function asRecords(page: HistoryReadResult) {
  assert.equal(page.level, 'records');
  if (page.level !== 'records') throw new Error('unreachable');
  return page;
}

function feeder(history: SessionHistory, cols = 20, rows = 4) {
  let seq = 0;
  let byte = 0;
  let at = 1000;
  let previous: ScreenSnapshot | null = null;

  return {
    write(
      lines: string[],
      opts: { text?: string[]; cols?: number; rows?: number; group?: number } = {},
    ): number {
      seq++;
      const size = { cols: opts.cols ?? cols, rows: opts.rows ?? rows };
      const screen = snapshot(size.cols, size.rows, lines);
      const fromByte = byte;
      byte += 10;
      const text: TextLine[] = (opts.text ?? []).map((t, i) => ({
        byte: fromByte + i,
        buffer: 'normal' as const,
        text: t,
      }));
      const input: HistoryInput = {
        seq,
        group: opts.group ?? seq,
        at: at++,
        fromByte,
        toByte: byte,
        text,
        scrolledRows: 0,
        grid: previous ? gridDelta(previous, screen) : null,
        screen,
      };
      history.push(input);
      previous = screen;
      return seq;
    },
    resize(nextCols: number, nextRows: number): void {
      cols = nextCols;
      rows = nextRows;
      history.resize(nextCols, nextRows);
    },
  };
}

/** A timeline with two epochs: the second is at a different grid size. */
function twoEpochs() {
  const history = new SessionHistory('s');
  const f = feeder(history);
  const first = f.write(['one'], { text: ['one'] });
  f.write(['one', 'two'], { text: ['two'] });
  f.resize(40, 8);
  const third = f.write(['three'], { text: ['three'], cols: 40, rows: 8 });
  return { history, first, third };
}

test('a read addresses the timeline by seq, by time and by byte alike', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['a'], { text: ['a'] });
  const second = f.write(['a', 'b'], { text: ['b'] });
  f.write(['a', 'b', 'c'], { text: ['c'] });

  const bySeq = asRecords(history.readBack({ from: { seq: second } }));
  const byTime = asRecords(
    history.readBack({ from: { at: history.screenAt({ seq: second }) ? 1001 : 0 } }),
  );
  const byByte = asRecords(history.readBack({ from: { byte: 12 } }));

  assert.equal(bySeq.records.length, 2, 'from the second record on, two remain');
  assert.equal(byTime.records.length, 2, 'a timestamp lands on the same record as a seq');
  assert.equal(byByte.records.length, 2, 'a byte offset lands on the same record too');
  for (const page of [bySeq, byTime, byByte]) {
    assert.deepEqual(
      page.records.map((r) => r.seq),
      [second, second + 1],
      'the same window regardless of how it was addressed',
    );
  }
});

test('a span opens with any address kind, and the two ends need not match', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  const first = f.write(['a'], { text: ['a'] });
  f.write(['a', 'b'], { text: ['b'] });
  const last = f.write(['a', 'b', 'c'], { text: ['c'] });

  const mixed = history.deliveries({ seq: first }, { byte: 28 });
  assert.deepEqual(
    mixed.map((r) => r.seq),
    [first, first + 1, last],
    'a seq opens the span, a byte closes it',
  );

  const byToken = history.deliveries(history.tokenAt({ seq: first })!, { seq: last });
  assert.equal(byToken.length, 3, 'a token from a page opens a span too');
});

test('a span crosses a resize; a page does not', () => {
  const { history } = twoEpochs();

  const span = history.deliveries({ seq: 1 }, { seq: 3 });
  assert.equal(span.length, 3, 'what happened is not less true for the grid changing');
  assert.deepEqual(
    [...new Set(span.map((r) => r.epoch))],
    [0, 1],
    'and each record says which grid it was produced at',
  );
  assert.equal(span[0]!.screen.cols, 20);
  assert.equal(span[2]!.screen.cols, 40, 'the screen comes back at its own size');

  const page = history.readBack({ from: { seq: 1 } });
  assert.equal(page.stoppedAtEpochEnd, true, 'a page stops at the boundary');
  assert.equal(page.epoch.cols, 20, 'and reports one size');
  assert.equal(page.next, 'h1.1.0', 'resuming crosses into the next epoch');
});

test('a span that contains nothing is empty rather than the whole timeline', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  const first = f.write(['a'], { text: ['a'] });
  f.write(['a', 'b'], { text: ['b'] });

  assert.equal(history.deliveries({ seq: first + 1 }, { seq: first }).length, 0, 'to before from');

  // An address means "at or before" — the resolution limit `locate` documents,
  // and the same one `screenAt` obeys — so a span past the end clamps to the
  // last record rather than answering nothing. There is no address that means
  // "strictly after the end"; the nearest state to what was asked is the honest
  // answer, and it is the record the caller would have got from `screenAt`.
  assert.deepEqual(
    history.deliveries({ seq: 99 }, { seq: 100 }).map((r) => r.seq),
    [first + 1],
    'a span past the end is the last state, not silence',
  );
});

test('`screen` is what separates a page from a playback', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['alpha'], { text: ['alpha'] });
  f.write(['alpha', 'beta'], { text: ['beta'] });

  const paged = asRecords(history.readBack({ from: { seq: 1 } }));
  assert.equal(paged.screens, false, 'a page says it did not materialize screens');
  assert.ok(
    paged.records.every((r) => r.screen === undefined),
    'so an absent screen is never read as a missing one',
  );

  const played = asRecords(history.readBack({ from: { seq: 1 }, screen: true }));
  assert.equal(played.records.length, 2);
  assert.deepEqual(played.records[1]!.screen!.lines[1], 'beta'.padEnd(20, ' '), 'the state at that point');
});

test('a read at the `text` level returns lines, and at `groups` level verdicts', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['one'], { text: ['one'], group: 1 });
  f.write(['one', 'two'], { text: ['two'], group: 1 });
  f.write(['one', 'two', 'three'], { text: ['three'], group: 2 });

  const asText = history.readBack({ level: 'text' });
  assert.equal(asText.level, 'text');
  assert.deepEqual(asText.lines.map((l) => l.text), ['one', 'two', 'three']);

  const asJobs = history.readBack({ level: 'groups' });
  assert.equal(asJobs.level, 'groups');
  assert.deepEqual(asJobs.groups.map((j) => j.group), [1, 2], 'one entry per group, not per delivery');
  assert.equal(asJobs.groups[0]!.chunks, 2, 'and it remembers it swallowed two');
});

test('paging on `next` walks the whole timeline without repeating or skipping', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  for (let i = 0; i < 7; i++) f.write([`line-${i}`], { text: [`line-${i}`] });

  const seen: number[] = [];
  let page = asRecords(history.readBack({ limit: 2 }));
  seen.push(...page.records.map((r) => r.seq));
  let guard = 0;
  while (page.next && guard++ < 20) {
    page = asRecords(history.readBack({ from: page.next, limit: 2 }));
    seen.push(...page.records.map((r) => r.seq));
  }

  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7], 'every record once, in order');
  assert.equal(page.next, null, 'and it ends');
});
