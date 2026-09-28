/**
 * The interleaved timeline, and the resize rule it is built around.
 *
 * These drive the timeline directly, the same way a replay does, so they can
 * build the exact shapes that matter -- a resize with no output, a delivery
 * that crosses a resize before the boundary is reported -- without waiting for
 * a real terminal to produce them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHistory, type HistoryInput, type HistoryToken } from '../src/history.js';
import { gridDelta } from '../src/delta.js';
import type { ScreenSnapshot } from '../src/screen.js';
import type { Segment, Verdict } from '../src/classify.js';
import type { TextLine } from '../src/text-log.js';

/**
 * A screen shaped the way `ScreenModel.snapshot()` shapes one: exactly `rows`
 * lines, each exactly `cols` wide. Padding to the full grid is not cosmetic --
 * a delta's row runs and an epoch's row count are both read off this, so a
 * short array here would test a screen the emulator cannot produce.
 */
function snapshot(cols: number, rows: number, lines: string[]): ScreenSnapshot {
  const padded: string[] = [];
  for (let y = 0; y < rows; y++) padded.push((lines[y] ?? '').padEnd(cols, ' '));
  return {
    lines: padded,
    // All default, no wide glyphs: what these timeline tests are about.
    // Attributes have their own tests, and the corpus-wide one compares them.
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

/** Drive a timeline the way a session does, keeping the byte/seq clocks. */
function feeder(history: SessionHistory, cols = 20, rows = 4) {
  let seq = 0;
  let byte = 0;
  let at = 1000;
  let previous: ScreenSnapshot | null = null;

  return {
    write(
      lines: string[],
      opts: { text?: string[]; cols?: number; rows?: number } = {},
    ): number {
      seq++;
      const size = { cols: opts.cols ?? cols, rows: opts.rows ?? rows };
      const screen = snapshot(size.cols, size.rows, lines);
      const fromByte = byte;
      byte += 10;
      const text: TextLine[] = (opts.text ?? []).map((t, i) => ({
        byte: fromByte + i,
        buffer: 'normal',
        text: t,
      }));
      const input: HistoryInput = {
        seq,
        group: seq,
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

test('a delivered epoch reports the grid size its records were produced at', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['alpha'], { text: ['alpha'] });
  f.write(['alpha', 'beta'], { text: ['beta'] });

  const page = history.read();
  assert.equal(page.epoch.cols, 20);
  assert.equal(page.epoch.rows, 4);
  assert.equal(page.records.length, 2);
  assert.deepEqual(
    page.records.flatMap((r) => r.text.map((l) => l.text)),
    ['alpha', 'beta'],
  );
});

test('a resize freezes what came before and opens a new epoch', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['before'], { text: ['before'] });
  f.resize(40, 4);
  f.write(['after'], { text: ['after'], cols: 40 });

  const epochs = history.epochs();
  assert.equal(epochs.length, 2, 'two epochs, split at the resize');
  assert.deepEqual(
    epochs.map((e) => `${e.cols}x${e.rows}`),
    ['20x4', '40x4'],
  );
  assert.equal(epochs[0]?.records, 1, 'the first epoch kept its one record');
  assert.ok(epochs[0]?.closedAt !== null, 'and was closed by the boundary');
  assert.equal(epochs[1]?.records, 1);
});

test('a page never spans an epoch boundary', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['a']);
  f.write(['b']);
  f.resize(40, 4);
  f.write(['c'], { cols: 40 });

  const first = history.read({ limit: 100 });
  assert.equal(first.records.length, 2, 'stopped at the boundary despite the limit');
  assert.equal(first.stoppedAtEpochEnd, true);
  assert.equal(first.truncated, false, 'the limit was not what stopped it');
  assert.equal(first.epoch.cols, 20, 'and it reports the size its records were made at');
  assert.ok(first.next, 'a token continues into the next epoch');

  const second = history.read({ from: first.next!, limit: 100 });
  assert.equal(second.epoch.cols, 40, 'the next page is a different size, reported as such');
  assert.equal(second.records.length, 1);
  assert.equal(second.next, null, 'end of the timeline');
});

test('a record that crosses a resize splits the epoch before the boundary is reported', () => {
  // The real hazard: `feed` snapshots inside its queued callback while `resize`
  // applies synchronously, so a delivery can report the new size ahead of the
  // notification that would have opened the new epoch.
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['a']);
  f.write(['b'], { cols: 40 });

  assert.equal(history.epochs().length, 2, 'the records themselves split the epoch');

  f.resize(40, 4); // the notification finally arrives, for a size already in effect
  assert.equal(history.epochs().length, 2, 'and does not split it a second time');
  assert.equal(history.read().epoch.cols, 20, 'the first epoch still reads at its own size');
});

test('a resize that produces no output is still a boundary', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['a']);
  f.resize(60, 10);
  f.write(['b'], { cols: 60, rows: 10 });

  const epochs = history.epochs();
  assert.equal(epochs.length, 2);
  assert.equal(epochs[1]?.records, 1, 'a record-less epoch is still a real epoch');
  assert.equal(epochs[1]?.cols, 60);
});

test('a frozen epoch keeps answering at its own size', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['old one'], { text: ['old one'] });
  f.write(['old two'], { text: ['old two'] });
  f.resize(40, 8);
  f.write(['new'], { cols: 40, rows: 8 });

  // Seek into the frozen epoch by sequence and by byte, and check the shape.
  for (const address of [{ seq: 2 }, { byte: 15 }, { at: 1001 }] as const) {
    const screen = history.screenAt(address);
    assert.ok(screen, `resolved ${JSON.stringify(address)}`);
    assert.equal(screen.cols, 20, 'reported at the size it was produced at, never reflowed');
    assert.equal(screen.rows, 4);
    assert.equal(screen.lines.length, 4);
    for (const line of screen.lines) assert.equal(line.length, 20);
  }

  const now = history.screenAt(undefined);
  assert.equal(now?.cols, 40, 'and "now" is the new epoch');
  assert.equal(now?.rows, 8);
});

test('the screen at any record materializes exactly', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  const screens: ScreenSnapshot[] = [];
  const seqs: number[] = [];

  // A chain long enough that deltas accumulate and must not drift.
  let lines = ['start'];
  for (let i = 0; i < 10; i++) {
    seqs.push(f.write(lines, { text: [`line ${i}`] }));
    screens.push(snapshot(20, 4, lines));
    lines = [...lines.slice(-3), `line ${i}`].slice(-4);
  }

  const page = history.read({ limit: 100 });
  for (let i = 0; i < page.records.length; i++) {
    const record = page.records[i]!;
    const token = history.tokenAt({ seq: record.seq });
    assert.ok(token, `token for seq ${record.seq}`);
    const screen = history.screenAt(token);
    assert.ok(screen);
    assert.deepEqual(
      screen.lines,
      screens[i]!.lines,
      `the screen at seq ${record.seq} is exact`,
    );
  }
});

test('text is paged from the beginning, in order, and bounded', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['a'], { text: ['one'] });
  f.write(['b'], { text: ['two'] });
  f.write(['c'], { text: ['three'] });

  const all = history.textSince(undefined, 10);
  assert.deepEqual(
    all.lines.map((l) => l.text),
    ['one', 'two', 'three'],
  );
  assert.equal(all.truncated, false);

  const some = history.textSince(undefined, 2);
  assert.deepEqual(
    some.lines.map((l) => l.text),
    ['one', 'two'],
  );
  assert.equal(some.truncated, true, 'truncation is reported, never silent');

  // And the token the page hands back resumes where it stopped -- at or after
  // the record it addresses, the same inclusive reading `read()` uses.
  const rest = history.textSince(some.next!, 10);
  assert.deepEqual(
    rest.lines.map((l) => l.text),
    ['three'],
  );
});

test('a text page loses nothing and repeats nothing when it pages on', () => {
  // A token addresses a *record*, so a page that stopped inside one could only
  // be resumed by repeating the lines it already returned or by skipping them.
  // Both are wrong; skipping is the silent loss the contract forbids. The record is
  // therefore the unit: a page is `limit` lines rounded up to one, which is
  // what makes the second record here come back whole rather than halved.
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['a'], { text: ['one'] });
  f.write(['b'], { text: ['two', 'three'] });
  f.write(['c'], { text: ['four'] });

  const collected: string[] = [];
  const sizes: number[] = [];
  let token: HistoryToken | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const page = history.textSince(token, 2);
    sizes.push(page.lines.length);
    collected.push(...page.lines.map((l) => l.text));
    if (!page.next) break;
    token = page.next;
  }

  assert.deepEqual(collected, ['one', 'two', 'three', 'four'], 'every line, exactly once');
  assert.deepEqual(sizes, [1, 2, 1], 'and each record served whole');
});

test('a bounded read reports what the limit withheld', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  for (let i = 0; i < 5; i++) f.write([`l${i}`]);

  const page = history.read({ limit: 2 });
  assert.equal(page.records.length, 2);
  assert.equal(page.truncated, true, 'the limit stopped it, and says so');
  assert.equal(page.stoppedAtEpochEnd, false, 'not the epoch that stopped it');

  const next = history.read({ from: page.next!, limit: 10 });
  assert.equal(next.records.length, 3);
  assert.equal(next.truncated, false);
  assert.equal(next.records[0]?.seq, 3, 'resumes exactly where the last page stopped');
});

test('an ended session keeps its history, and says that it ended', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['last words'], { text: ['last words'] });
  history.end({ exitCode: 0, signal: null });

  assert.ok(history.ended, 'the end is recorded, not inferred from silence');
  assert.equal(history.ended?.exitCode, 0);

  const page = history.read();
  assert.equal(page.records.length, 1, 'and the history is still there');
  assert.deepEqual(
    history.textSince(undefined, 10).lines.map((l) => l.text),
    ['last words'],
  );
  assert.ok(history.epochs()[0]?.closedAt !== null, 'the final epoch was closed');
});

test('a malformed or out-of-range token is refused, not guessed at', () => {
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['a']);

  assert.throws(() => history.read({ from: 'not-a-token' }), RangeError);
  assert.throws(() => history.read({ from: 'h1.7.0' }), RangeError);
  assert.throws(() => history.read({ from: 'h1.0.99' }), RangeError);
});

test('a seek lands on the last state at or before the point asked for', () => {
  // "At or before" and not "exactly": seeking to a time or a byte offset asks
  // what the terminal was like then, and the honest answer is the last recorded
  // state at or before it -- delivery granularity is the resolution limit.
  const history = new SessionHistory('s');
  const f = feeder(history);
  f.write(['a']);
  f.write(['b']);

  const second = history.tokenAt({ seq: 2 });
  assert.equal(history.tokenAt({ seq: 99 }), second, 'past the end resolves to the last state');
  assert.equal(history.tokenAt({ byte: 999 }), second);
  assert.equal(history.tokenAt({ byte: -1 }), null, 'before anything recorded resolves to nothing');
  assert.equal(history.tokenAt({ seq: 0 }), null, 'and so does a sequence nothing reached yet');
});
