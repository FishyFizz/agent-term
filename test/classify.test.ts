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
): Promise<{ segments: Segment[]; screen: ScreenModel }> {
  const before = frameOf(s);
  const fromByte = s.ops.bytesFed;
  await s.feed(bytes);
  const after = frameOf(s);
  const ops = s.ops.recorded.filter((o) => o.byteOffset >= fromByte);
  s.ops.clear();
  const from = { ...before };
  return {
    segments: classify({
      before: from,
      after,
      ops,
      fromByte,
      toByte: s.ops.bytesFed,
    }).segments,
    screen: s,
  };
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

test('a full-screen TUI repaint is drawing', async () => {
  const s = new ScreenModel(20, 5);
  await update(s, 'x\r\n');
  const r = await update(s, '\x1b[?1049h\x1b[2J\x1b[H\x1b[1;1Htop - 00:00:00\x1b[K');
  const seg = r.segments.find((x) => x.kind === 'drawing');
  assert.ok(seg, 'a repaint is classified as drawing');
  assert.ok(seg!.evidence.ops.includes('CUP') || seg!.evidence.ops.includes('ED'));
});

test('a pager is drawing, and returning to the shell is writing', async () => {
  const s = new ScreenModel(20, 5);
  await update(s, 'shell output\r\n');
  const inPager = await update(s, '\x1b[?1049h\x1b[Hcommit abc123\x1b[K');
  assert.ok(
    inPager.segments.some((x) => x.kind === 'drawing'),
    'entering and painting the pager is drawing',
  );
  const back = await update(s, '\x1b[?1049l');
  assert.ok(back.segments.length > 0, 'exiting produced a segment');
  const after = await update(s, 'more shell output\r\n');
  assert.deepEqual(kinds(after.segments), ['writing'], 'back in the shell, appending is writing');
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

test('an update can contain both kinds, in order', async () => {
  // A log line and a status repaint in one burst. This is the "may be both"
  // clause of L0.1: the model admits mixtures rather than forcing a choice.
  const s = new ScreenModel(20, 5);
  await update(s, 'log1\r\nlog2\r\nlog3\r\nlog4\r\n');
  const r = await update(s, 'new line\r\n\x1b[5;1H[####------]\x1b[K');
  assert.ok(r.segments.length >= 2, 'the burst was split into segments');
  assert.ok(
    r.segments.some((x) => x.kind === 'writing') && r.segments.some((x) => x.kind === 'drawing'),
    `both kinds present in one update: ${JSON.stringify(kinds(r.segments))}`,
  );
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
  assert.ok(r.segments[0]!.evidence.ops.length >= 2, 'ops from the run are accumulated');
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
