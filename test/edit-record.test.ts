/**
 * The edit record (CLASSIFIER.md §3.1) — control ops in order, with byte
 * offsets, from the same parser that produces the screen.
 *
 * The decisive case is the npm trace from §4: draw → append → redraw. A
 * screen diff cannot recover that ordering once output has scrolled; the op
 * stream can, because the boundary comes from the program's own operations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel } from '../src/screen.js';
import { modeKind } from '../src/edit-record.js';
import type { OpName } from '../src/edit-record.js';

const names = (s: ScreenModel): OpName[] => s.ops.recorded.map((o) => o.name);

test('plain text produces no ops', async () => {
  const s = new ScreenModel(20, 5);
  await s.feed('hello world\r\nmore text\r\n');
  assert.deepEqual(names(s), [], 'printable text does not pass through the handlers');
  assert.ok(s.ops.bytesFed > 0, 'bytes are still counted');
});

test('cursor addressing, erase and insert ops are recorded with params', async () => {
  const s = new ScreenModel(20, 5);
  await s.feed('ab');
  await s.feed('\x1b[3;5H');
  await s.feed('\x1b[K');
  await s.feed('\x1b[2J');
  await s.feed('\x1b[L');
  await s.feed('\x1b[M');
  await s.feed('\x1b[P');
  assert.deepEqual(names(s), ['CUP', 'EL', 'ED', 'IL', 'DL', 'DCH']);

  const cup = s.ops.recorded[0]!;
  assert.deepEqual(cup.params, [3, 5], 'CUP params preserved');
  // Handlers run *before* xterm applies the op, so the recorded cursor is
  // where the program was writing from, not where the op moved it to. That
  // is the useful value: it is the position an append would have continued at.
  assert.equal(cup.cursorY, 0, 'cursor before the move (row)');
  assert.equal(cup.cursorX, 2, 'cursor before the move (column), after "ab"');
  assert.equal(cup.at > 0, true, 'op carries a timestamp');

  // The ops themselves still took effect.
  const s2 = new ScreenModel(20, 5);
  await s2.feed('\x1b[3;5H');
  assert.equal(s2.snapshot().cursorY, 2, 'CUP applied');
  assert.equal(s2.snapshot().cursorX, 4);
});

test('byte offsets are monotonic and locate ops in the stream', async () => {
  const s = new ScreenModel(20, 5);
  await s.feed('aaaa');
  await s.feed('\x1b[H');
  await s.feed('bbbb');
  await s.feed('\x1b[2J');

  const ops = s.ops.recorded;
  assert.equal(ops.length, 2);
  assert.ok(ops[0]!.byteOffset >= 4, 'first op is after the bytes that preceded it');
  assert.ok(ops[1]!.byteOffset > ops[0]!.byteOffset, 'offsets increase');
  assert.equal(s.ops.bytesFed, 4 + 3 + 4 + 4, 'every fed byte is accounted for');
});

test('DEC private modes are recorded and alt-screen is flagged', async () => {
  const s = new ScreenModel(20, 5);
  await s.feed('\x1b[?1049h');
  await s.feed('x');
  await s.feed('\x1b[?25l');
  await s.feed('\x1b[?1049l');

  const ops = s.ops.recorded;
  assert.deepEqual(
    ops.map((o) => o.name),
    ['DECSET', 'DECRST', 'DECRST'],
    'no ops for the printable text between them',
  );
  assert.deepEqual(ops[0]!.params, [1049]);
  assert.deepEqual(ops[1]!.params, [25]);
  assert.deepEqual(ops[2]!.params, [1049], 'exiting the alt screen');
  assert.equal(modeKind(1049), 'alt-screen');
  assert.equal(modeKind(25), 'cursor-visibility');
  assert.equal(modeKind(1000), 'mouse-tracking');

  // altScreen is read before the op applies, so entering the alt screen is
  // itself recorded as false and the *next* op sees the new buffer.
  assert.equal(ops[0]!.altScreen, false, 'entering alt is recorded from the old buffer');
  assert.equal(ops[1]!.altScreen, true, 'the following op ran on the alternate buffer');
  assert.equal(s.snapshot().buffer, 'normal', 'the alt screen was exited');
});

test('save/restore cursor and reset are recorded', async () => {
  const s = new ScreenModel(20, 5);
  await s.feed('\x1b7');
  await s.feed('\x1b8');
  await s.feed('\x1bc');
  assert.deepEqual(names(s), ['DECSC', 'DECRC', 'RIS']);
});

test('the npm trace: draw, append, redraw is recoverable in order', async () => {
  // CLASSIFIER.md §4. A bar is drawn on the last row, a log line is appended
  // (which scrolls), then the bar is redrawn. Spatially the two bars are on
  // different rows with the new line between them, so no row-based diff can
  // tell "the status line moved" from "two unrelated lines changed". The op
  // stream records the actual sequence.
  const s = new ScreenModel(20, 5);
  // Fill all 5 rows so the next append is forced to scroll.
  await s.feed('log1\r\nlog2\r\nlog3\r\nlog4\r\nlog5');

  s.ops.clear();
  await s.feed('\x1b[5;1H[#####-----]\x1b[K'); // draw the bar on the last row
  const draw = names(s);
  s.ops.clear();

  await s.feed('\r\nlog6'); // plain append -- scrolls, no control ops
  const append = names(s);
  const afterAppend = s.snapshot().lines.map((l) => l.trimEnd());
  s.ops.clear();

  await s.feed('\x1b[5;1H\x1b[K[##########]'); // redraw at the (new) last row
  const redraw = names(s);

  assert.deepEqual(draw, ['CUP', 'EL'], 'drawing is CUP + erase');
  assert.deepEqual(append, [], 'appending emits no control ops at all');
  assert.deepEqual(redraw, ['CUP', 'EL'], 'redrawing is CUP + erase again');

  // The point of §4: the append scrolled, so the old bar moved up a row and
  // the new bar appeared below it. Both bars are on screen at once, at
  // different rows, with the new log line between them -- and nothing in a
  // row-based diff links row 3's past self to row 4's present self. The op
  // stream records the real order instead.
  assert.ok(afterAppend.includes('[#####-----]'), 'old bar survived the scroll');
  assert.equal(afterAppend[4], 'log6', 'the appended line is at the bottom');
  assert.equal(afterAppend[3], '[#####-----]', 'the old bar was pushed up by the scroll');

  const snap = s.snapshot().lines.map((l) => l.trimEnd());
  assert.equal(snap[4], '[##########]', 'new bar on the last row');
  assert.equal(snap[3], '[#####-----]', 'old bar still there, one row up -- row != identity');
  assert.equal(snap[2], 'log4', 'content above shifted up by the scroll');
  assert.equal(
    snap.filter((l) => l.startsWith('[')).length,
    2,
    'two bar-looking rows, no spatial evidence they are related',
  );
});

test('clear() drops recorded ops but keeps the byte count', async () => {
  const s = new ScreenModel(20, 5);
  await s.feed('\x1b[H');
  assert.equal(s.ops.recorded.length, 1);
  s.ops.clear();
  assert.equal(s.ops.recorded.length, 0);
  const fed = s.ops.bytesFed;
  await s.feed('\x1b[2J');
  assert.equal(s.ops.recorded.length, 1, 'still recording after clear');
  assert.ok(s.ops.bytesFed > fed, 'byte count is cumulative across clears');
});
