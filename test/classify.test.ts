/**
 * Classification (L0.1, CLASSIFIER.md §3.3).
 *
 * Each test is one of the cases from GOAL.md's success criteria, driven
 * through the real emulator: a build log, a TUI, a pager, a REPL, a progress
 * bar. The claim under test is that the server -- not the agent -- decides,
 * and that it decides from structure rather than from a tuned threshold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel } from '../src/screen.js';
import { classify, frameOf } from '../src/classify.js';
import type { Segment } from '../src/classify.js';

/** Run one update through the model and classify it. */
async function update(
  s: ScreenModel,
  bytes: string,
): Promise<{ segments: Segment[]; changedRows: number[]; screen: ScreenModel }> {
  const before = frameOf(s);
  const fromByte = s.ops.bytesFed;
  const facts = await s.feed(bytes);
  const after = frameOf(s, facts.after);
  const from = { ...before };
  const classified = classify({
    before: from,
    after,
    fromByte,
    toByte: s.ops.bytesFed,
    scrolledBy: facts.scrolledRows,
  });
  return { segments: classified.segments, changedRows: classified.changedRows, screen: s };
}

const kinds = (segments: Segment[]) => segments.map((x) => x.kind);

test('a scrolling build log is writing', async () => {
  const s = new ScreenModel(20, 5);
  await update(s, 'l1\r\nl2\r\nl3\r\nl4\r\n');
  // Force real scrolls across several updates.
  const r1 = await update(s, 'l5\r\n');
  const r2 = await update(s, 'l6\r\n');
  assert.deepEqual(kinds(r1.segments), ['writing']);
  assert.deepEqual(kinds(r2.segments), ['writing'], 'scroll is normalized, not a repaint');
  assert.equal(r2.segments[0]!.evidence.scrolledBy, 1, 'the scroll was detected');
});

test('taking over the screen is a surface change, not a repaint', async () => {
  // CLASSIFIER.md §3.4: the alt screen is a prior and a capture-urgency flag,
  // never a verdict. Entering it replaces the whole visible grid, which reads
  // as "erased" -- but nothing was erased, another surface came in front.
  //
  // The old form of this test asserted `drawing`, which is what the program
  // *meant* (ESC[2J, CUP) rather than what the screen did.
  const s = new ScreenModel(20, 5);
  await update(s, 'x\r\n');
  const r = await update(s, '\x1b[?1049h\x1b[2J\x1b[H\x1b[1;1Htop - 00:00:00\x1b[K');
  assert.ok(r.segments.length > 0, 'produced a segment');
  assert.equal(r.segments[0]!.evidence.altScreen, true, 'the alternate surface is in front');
  assert.equal(r.segments[0]!.kind, 'writing', 'a surface change is not a repaint');
});

test('a pager is drawing, and returning to the shell is writing', async () => {
  const s = new ScreenModel(20, 5);
  await update(s, 'shell output\r\n');
  const inPager = await update(s, '\x1b[?1049h\x1b[Hcommit abc123\x1b[K');
  assert.equal(
    inPager.segments[0]!.evidence.altScreen,
    true,
    'the pager took the alternate surface',
  );
  const back = await update(s, '\x1b[?1049l');
  assert.ok(back.segments.length > 0, 'exiting produced a segment');
  const after = await update(s, 'more shell output\r\n');
  assert.deepEqual(kinds(after.segments), ['writing'], 'back in the shell, appending is writing');
});

test('appending more lines than the grid can retain is still writing', async () => {
  // The case a frame diff cannot solve on its own: a burst larger than the grid
  // displaces every visible line, so no overlap survives to align against, and
  // comparing the frames row-for-row makes appending look exactly like a full
  // rewrite. The emulator reports the scroll, which is why this is a
  // screen-model fact rather than something inferred after the fact.
  const s = new ScreenModel(30, 6);
  const lines = (n: number, tag: string): string =>
    Array.from({ length: n }, (_, i) => `${tag}${i}\r\n`).join('');
  await update(s, lines(5, 'a'));
  const few = await update(s, lines(2, 'new'));
  assert.deepEqual(kinds(few.segments), ['writing'], 'a small append is writing');
  const many = await update(s, lines(8, 'more'));
  assert.deepEqual(
    kinds(many.segments),
    ['writing'],
    'a burst that pushes every visible line off is appending, not repainting',
  );
  assert.equal(many.segments[0]!.evidence.scrolledBy, 8, 'the scroll was measured');
});

test('a bare CR overwrite is drawing even with no control op', async () => {
  // CLASSIFIER.md §9 open item: `\r` + overwrite emits no CSI. The screen
  // model must catch it, or a progress line that never redraws with CUP is
  // silently misclassified as writing.
  //
  // No trailing newline, so the cursor is still on the row just written and
  // the CR returns to that row's start -- a genuine overwrite. With a newline
  // first, the write lands on an empty row and really is appending.
  const s = new ScreenModel(20, 5);
  await update(s, 'AAAA');
  const r = await update(s, '\rBBBB');
  assert.equal(r.screen.snapshot().lines[0]!.trimEnd(), 'BBBB', 'the row was overwritten');
  assert.deepEqual(
    kinds(r.segments),
    ['drawing'],
    'overwriting non-blank cells is drawing without any escape sequence',
  );
  assert.equal(r.segments[0]!.evidence.overwrote, true);
});

test('the npm trace: draw, append, redraw yields ordered segments', async () => {
  const s = new ScreenModel(20, 5);
  await update(s, 'log1\r\nlog2\r\nlog3\r\nlog4\r\nlog5');

  const draw = await update(s, '\x1b[5;1H[#####-----]\x1b[K');
  const append = await update(s, '\r\nlog6');
  const redraw = await update(s, '\x1b[5;1H\x1b[K[##########]');

  assert.ok(
    draw.segments.some((x) => x.kind === 'drawing'),
    'drawing the bar is drawing',
  );
  assert.deepEqual(kinds(append.segments), ['writing'], 'appending a log line is writing');
  assert.ok(
    redraw.segments.some((x) => x.kind === 'drawing'),
    'redrawing the bar is drawing',
  );
});

test('a mixture appears across deliveries, in order, not inside one', async () => {
  // One segment per delivery: a segment cannot claim a finer range than the
  // thing it was measured over. So "may be both" (L0.1) is a fact about a
  // *sequence* of deliveries, not about one of them.
  //
  // The old form asserted both kinds inside a single update, which only held
  // because the op stream produced a second, competing segment.
  const s = new ScreenModel(20, 5);
  await update(s, 'log1\r\nlog2\r\nlog3\r\nlog4\r\n');
  const line = await update(s, 'new line\r\n');
  // Over an existing row, not the blank one the scroll just opened: a status
  // row drawn onto blank space is content arriving, however the program
  // thinks of it. Row 0 currently holds a log line.
  const status = await update(s, '\x1b[1;1H[####------]');
  assert.deepEqual(kinds(line.segments), ['writing'], 'the log line is writing');
  assert.deepEqual(kinds(status.segments), ['drawing'], 'the status repaint is drawing');
  assert.ok(status.segments[0]!.fromByte >= line.segments[0]!.toByte, 'in time order');
});

test('segments carry byte ranges that tile the update', async () => {
  const s = new ScreenModel(20, 5);
  await update(s, 'log1\r\n');
  const r = await update(s, 'a\r\n\x1b[5;1H[##]\x1b[Kb');
  for (const seg of r.segments) {
    assert.ok(seg.toByte >= seg.fromByte, 'range is well-formed');
  }
  const first = r.segments[0]!;
  const last = r.segments[r.segments.length - 1]!;
  assert.equal(first.fromByte, 6, 'starts where the previous update ended');
  assert.equal(last.toByte, r.segments[0]!.fromByte + 'a\r\n\x1b[5;1H[##]\x1b[Kb'.length);
});

test('a moved highlight reports the rows it moved, not the bytes it took', async () => {
  // The case a byte span cannot answer and a screen-to-screen comparison gets
  // wrong: the segment covers the region the repaint wrote, and the caller's
  // actual question is "which rows look different". One glyph moving is one or
  // two rows whether the program repainted a cell or the whole screen.
  const s = new ScreenModel(20, 5);
  await update(s, '> alpha\r\n  beta\r\n  gamma\r\n');

  // Repaint rows 0 and 1 with the highlight one line down: row 0 loses the
  // marker, row 1 gains it, row 2 is never touched.
  const r = await update(s, '\x1b[1;1H  alpha\x1b[2;1H> beta');
  assert.deepEqual(r.changedRows, [0, 1], 'exactly the two rows that differ');
  assert.ok(r.segments.length > 0, 'while the segment spans the write it took');
});

test('a cursor move that changes no cell reports no changed row', async () => {
  const s = new ScreenModel(20, 5);
  await update(s, 'hello\r\n');

  // Moving the cursor is an act that touches the grid, so it produces a
  // segment -- but it lands on no row, which is exactly what an empty
  // `changedRows` beside a non-empty `segments` says.
  const r = await update(s, '\x1b[1;1H');
  assert.deepEqual(r.changedRows, [], 'no cell moved, so no row changed');
});

test('typing into a shell with no output produces no phantom drawing', async () => {
  // What the user types is echoed by the pty but is not program output. It
  // must not be reported as a repaint.
  const s = new ScreenModel(20, 5);
  await update(s, 'PS> ');
  const r = await update(s, 'echo hi');
  assert.deepEqual(kinds(r.segments), ['writing'], 'echoed input is appended text');
});

test('consecutive same-kind ops coalesce into one segment', async () => {
  // Real shells and TUIs emit CUP per line they draw, so one repaint arrives
  // as a run of ops. One segment per op is noise; the run is the unit.
  const s = new ScreenModel(20, 5);
  await update(s, 'log1\r\nlog2\r\n');
  const r = await update(s, '\x1b[1;1Haaa\x1b[K\x1b[2;1Hbbb\x1b[K\x1b[3;1Hccc\x1b[K');
  assert.ok(
    r.segments.length <= 2,
    `a three-line repaint is one run, not six segments: ${JSON.stringify(kinds(r.segments))}`,
  );
});

test('resizing is not mistaken for a repaint', async () => {
  const s = new ScreenModel(20, 5);
  await update(s, 'line one\r\n');
  const before = s.snapshot().lines.length;
  s.resize(40, 10);
  const after = s.snapshot();
  assert.equal(after.lines.length, before + 5, 'grid grew');
  // Classification is not run on a resize: callers treat it as an event.
  // This pins that the model does not silently repaint content.
  assert.equal(
    after.lines[0]!.trimEnd(),
    'line one',
    'content preserved across the reflow',
  );
});
