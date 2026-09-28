/**
 * The pty traces — the half of the corpus nothing used to read.
 *
 * Every programme is recorded twice: once `direct`, its
 * bytes captured and fed to the emulator unaltered, and once through a real
 * child process behind ConPTY. Only the `direct` half was ever scored, because
 * the corpus's expectations are byte ranges taken from the programme's own
 * marks and ConPTY rewrites the bytes — the same offset does not mean the same
 * thing on a pty feed.
 *
 * So those 23 traces were recorded, committed, and never run. That is the feed
 * where things actually go wrong: ConPTY coalesces writes, splits others, and
 * terminates lines by positioning the cursor instead of a linefeed, which is
 * how a text log that had passed 157 tests was still losing lines on Windows.
 *
 * These tests ask questions that need no labels, so they hold on either feed.
 * They check the *artifact* — that a trace's bytes really do produce its frames
 * — and they run on the messy feed, which is the point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel } from '../src/screen.js';
import { loadTraces } from './helpers/corpus.js';

const ptyTraces = loadTraces('pty');

test('there is a pty trace for every programme, and they are complete', () => {
  const direct = loadTraces('direct').map((t) => t.id).sort();
  const pty = ptyTraces.map((t) => t.id).sort();
  assert.deepEqual(pty, direct, 'the two feeds cover the same programmes');
  assert.ok(pty.length >= 23, `expected the full corpus, got ${pty.length}`);

  for (const trace of ptyTraces) {
    assert.ok(trace.raw.length > 0, `${trace.id}: has bytes`);
    assert.equal(trace.bytes, Buffer.byteLength(trace.raw, 'utf8'), `${trace.id}: byte count matches`);
    assert.ok(trace.frames.length > 0, `${trace.id}: captured at least one frame`);
    assert.ok(trace.arrivals.length > 0, `${trace.id}: recorded when bytes arrived`);
    // Monotonic, because everything downstream addresses the stream by offset.
    for (let i = 1; i < trace.arrivals.length; i++) {
      assert.ok(
        trace.arrivals[i]!.offset > trace.arrivals[i - 1]!.offset,
        `${trace.id}: arrivals advance`,
      );
    }
  }
});

test('a pty trace replays to the frames it recorded', async () => {
  // The artifact check. A trace is only usable data if its bytes produce the
  // screens it says they did, and this is the feed where that is not obvious:
  // ConPTY rewrites sequences on the way through, so `raw` is not what the
  // programme wrote. Feeding it in chunks of the replayer's choosing must still
  // land on exactly the frames the recorder captured in chunks of the pty's.
  for (const trace of ptyTraces) {
    const screen = new ScreenModel(trace.cols, trace.rows);
    const resizes = [...trace.resizes].sort((a, b) => a.offset - b.offset);
    const raw = Buffer.from(trace.raw, 'utf8');
    let nextResize = 0;
    let checked = 0;

    // Split where the recorder did, so the resizes land in the same places.
    const boundaries = [...new Set(trace.frames.map((f) => f.at))].sort((a, b) => a - b);
    let previous = 0;
    for (const at of boundaries) {
      while (nextResize < resizes.length && resizes[nextResize]!.offset <= at) {
        const r = resizes[nextResize]!;
        screen.resize(r.cols, r.rows);
        nextResize++;
      }
      await screen.feed(raw.subarray(previous, at) as unknown as Buffer);
      previous = at;

      for (const frame of trace.frames.filter((f) => f.at === at)) {
        const lines = screen.snapshot().lines.map((l) => l.replace(/\s+$/, ''));
        assert.deepEqual(lines, frame.lines, `${trace.id}: replayed to the recorded frame`);
        checked++;
      }
    }
    assert.ok(checked > 0, `${trace.id}: compared at least one frame`);
    screen.dispose();
  }
});
