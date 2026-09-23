/**
 * The timeline against the whole corpus.
 *
 * The unit tests drive the timeline with screens built by hand, which are
 * exactly the shapes their author thought of. This replays every recorded
 * programme through the real emulator and checks the one claim the storage
 * design rests on: that a screen read back from keyframes and deltas is the
 * screen the session actually had, at every single record.
 *
 * A single mis-encoded delta would corrupt every later read of that history
 * while leaving the keyframe beside it looking perfectly correct, so the check
 * has to be exhaustive rather than sampled -- and it has to run where the
 * shapes are real, not where they are convenient.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel, type ScreenSnapshot } from '../src/screen.js';
import { classify, frameOf } from '../src/classify.js';
import { gridDelta } from '../src/delta.js';
import { SessionHistory, type HistoryRecord } from '../src/history.js';
import { loadTraces, splitOnDrawOps } from './helpers/corpus.js';
import type { TextLine } from '../src/text-log.js';

/** Every record across every epoch, oldest first. */
function allRecords(history: SessionHistory): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  let page = history.read({ limit: 200 });
  for (let guard = 0; guard < 10_000; guard++) {
    out.push(...page.records);
    if (!page.next) return out;
    page = history.read({ from: page.next, limit: 200 });
  }
  throw new Error('paging did not terminate');
}

/**
 * Replay one trace into a timeline, the way a session would.
 *
 * Deliberately mirrors `TerminalSession.feed` -- same snapshot, same drain, same
 * delta -- so what is verified here is the code path the server runs, not a
 * parallel one written for the test.
 */
async function replayIntoHistory(history: SessionHistory, trace: ReturnType<typeof loadTraces>[number]) {
  const screen = new ScreenModel(trace.cols, trace.rows);
  const resizes = [...trace.resizes].sort((a, b) => a.offset - b.offset);
  const expected = new Map<number, ScreenSnapshot>();

  let nextResize = 0;
  let seq = 0;
  let prevTo = 0;
  let previous: ScreenSnapshot | null = null;

  for (const chunk of splitOnDrawOps(trace.raw)) {
    const chunkEnd = prevTo + Buffer.byteLength(chunk, 'utf8');
    while (nextResize < resizes.length && resizes[nextResize]!.offset <= chunkEnd) {
      const r = resizes[nextResize]!;
      screen.resize(r.cols, r.rows);
      history.resize(r.cols, r.rows);
      nextResize++;
    }

    const before = frameOf(screen);
    await screen.feed(chunk);
    const after = frameOf(screen);
    const ops = [...screen.ops.recorded];
    const toByte = screen.ops.bytesFed;
    screen.ops.clear();

    const snap = screen.snapshot();
    const text: TextLine[] = screen.text.drain();
    const segments = classify({ before, after, ops, fromByte: prevTo, toByte }).segments;

    seq++;
    history.push({
      seq,
      at: seq,
      fromByte: prevTo,
      toByte,
      segments,
      text,
      grid: previous ? gridDelta(previous, snap) : null,
      screen: snap,
    });
    expected.set(seq, snap);
    previous = snap;
    prevTo = toByte;
  }
  return expected;
}

test('every corpus trace reconstructs exactly through the timeline', async () => {
  const traces = loadTraces('direct');
  assert.ok(traces.length >= 23, `expected the full corpus, got ${traces.length}`);

  let checkedRecords = 0;
  let checkedTraces = 0;
  for (const trace of traces) {
    const history = new SessionHistory(trace.id);
    const expected = await replayIntoHistory(history, trace);

    const records = allRecords(history);
    assert.equal(records.length, expected.size, `${trace.id}: every delivery was recorded`);

    for (const record of records) {
      checkedRecords++;
      const want = expected.get(record.seq);
      assert.ok(want, `${trace.id}: seq ${record.seq} came from somewhere`);
      const got = history.screenAt({ seq: record.seq });
      assert.ok(got, `${trace.id}: seq ${record.seq} is readable`);
      assert.deepEqual(
        got.lines,
        want.lines,
        `${trace.id}: the screen at seq ${record.seq} is the screen the session had`,
      );
      assert.equal(got.cols, want.cols, `${trace.id}: seq ${record.seq} keeps its width`);
      assert.equal(got.rows, want.rows, `${trace.id}: seq ${record.seq} keeps its height`);
    }
    checkedTraces++;
  }

  assert.equal(checkedTraces, traces.length);
  assert.ok(checkedRecords > 1000, `checked a real number of records (${checkedRecords})`);
});

test('the corpus resize programme yields three epochs, each at its own size', async () => {
  const trace = loadTraces('direct').find((t) => t.id === 'complex.resize-epochs');
  assert.ok(trace, 'the resize programme is in the corpus');

  const history = new SessionHistory(trace.id);
  await replayIntoHistory(history, trace);

  const epochs = history.epochs();
  assert.equal(epochs.length, 3, 'two resizes, three epochs');
  assert.deepEqual(
    epochs.map((e) => `${e.cols}x${e.rows}`),
    ['60x8', '30x6', '48x10'],
    'each size the programme ran at',
  );
  assert.ok(
    epochs[0]!.closedAt !== null && epochs[1]!.closedAt !== null,
    'the first two were closed by the boundaries that followed',
  );
  assert.equal(epochs[2]!.closedAt, null, 'and the last is still open');

  // Each epoch answers at its own size, which is the delivered rule: frozen
  // history reports the size it was produced at, and nothing is ever reflowed.
  for (const epoch of epochs) {
    const page = history.read({ from: `h1.${epoch.index}.0`, limit: 1 });
    assert.equal(page.epoch.cols, epoch.cols);
    assert.equal(page.epoch.rows, epoch.rows);
    const first = page.records[0];
    assert.ok(first, `epoch ${epoch.index} has records`);
    const screen = history.screenAt({ seq: first.seq });
    assert.equal(screen?.cols, epoch.cols, `epoch ${epoch.index} reads back at its own width`);
    assert.equal(screen?.rows, epoch.rows);
    assert.equal(screen?.lines.length, epoch.rows);
  }
});
