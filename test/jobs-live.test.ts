/**
 * Job detection against a real program, not a replay.
 *
 * The corpus cannot validate this: `corpus/traces` records op timestamps that
 * are a uniform ~15ms apart, because the recorder awaits each 32-byte write
 * and the await dominates whatever the programme was doing. The programme's
 * own pauses are gone from the record, so there is no gap left to detect.
 * Until arrival timing is recorded at the source, a real pty is the only
 * place the boundary can be shown to land where the programme drew it.
 *
 * So these spawn a real process that paints a menu and moves the highlight,
 * with enough of a pause between moves for a gap to be unambiguous.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSession, type SessionUpdate } from '../src/session.js';
import { HistoryStore, type SessionHistory } from '../src/history.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `\\x1b` so the child's source contains the two characters \ x 1 b, which it
// parses as ESC. Emitting a raw ESC into the child's source would work by luck.
const E = '\\x1b';

/** Paint a four-item list, move the highlight through it, and stop. */
const MENU_SCRIPT = `
const W = (s) => process.stdout.write(s);
const items = ['alpha', 'beta', 'gamma', 'delta'];
const draw = (sel) => {
  W('${E}[H');
  for (let i = 0; i < items.length; i++) {
    W('${E}[2K');
    W((i === sel ? '> ' : '  ') + items[i] + '\\r\\n');
  }
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  W('${E}[?1049h');
  draw(0);
  for (const sel of [1, 2, 3, 0]) {
    await pause(80);
    draw(sel);
  }
  await pause(500);
  W('${E}[?1049l');
})();
`;

const GAP_MS = 30;

function open(options: { jobPolicy?: { gapMs: number } | false } = {}): {
  session: TerminalSession;
  history: SessionHistory;
  updates: SessionUpdate[];
} {
  const session = new TerminalSession('jobs-live', {
    command: process.execPath,
    args: ['-e', MENU_SCRIPT],
    cols: 50,
    rows: 8,
    ...options,
  });
  const updates: SessionUpdate[] = [];
  session.onUpdate((u) => updates.push(u));
  // The stream is the timeline's, so playback is a read over it.
  const history = new HistoryStore().open(session);
  return { session, history, updates };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return false;
}

const line = (u: SessionUpdate, needle: string): boolean =>
  u.screen.lines.some((l) => l.includes(needle));

test('a real repaint burst is one job, and reads as drawing', async (t) => {
  const { session, updates } = open({ jobPolicy: { gapMs: GAP_MS } });
  t.after(() => session.dispose());

  const got = await waitFor(() => updates.some((u) => line(u, '> beta')));
  assert.ok(got, 'the highlight reached beta');

  const move = updates.find((u) => line(u, '> beta'))!;
  const kinds = move.segments.map((s) => s.kind);
  assert.ok(kinds.includes('drawing'), `the move should be drawing, got ${JSON.stringify(kinds)}`);

  // The point of the whole exercise: one update for the burst, carrying what
  // it swallowed, rather than one update per row the program happened to write.
  assert.ok(move.collapsed !== null, 'job mode reports what it merged');
  assert.ok(move.collapsed!.chunks >= 1);
  assert.equal(move.collapsed!.reason, 'gap', 'closed on silence, not on a cap');
});

test('every update in job mode carries its collapsed count', async (t) => {
  const { session, updates } = open({ jobPolicy: { gapMs: GAP_MS } });
  t.after(() => session.dispose());

  const got = await waitFor(() => updates.length >= 3);
  assert.ok(got, `expected several updates, got ${updates.length}`);
  for (const u of updates) {
    assert.ok(u.collapsed !== null, `update ${u.seq} should report what it merged`);
  }
});

test('merged updates report intermediates the consumer did not see', async (t) => {
  const { session, updates } = open({ jobPolicy: { gapMs: GAP_MS } });
  t.after(() => session.dispose());

  await waitFor(() => updates.some((u) => line(u, '> beta')));
  const merged = updates.find((u) => u.collapsed && u.collapsed.chunks > 1);

  // Not asserted unconditionally: whether the pty hands over one chunk per
  // write or coalesces them is the platform's choice, not ours. What must hold
  // is that when we do merge, the count says so, because a highlight that
  // moves and moves back nets to no visible change and the count is then the
  // only evidence anything happened.
  if (merged) {
    assert.ok(merged.collapsed!.chunks > 1);
    // The hint has to be in the payload, not only in the docs: a consumer
    // reading JSON should not have to know that `chunks > 1` is the question.
    assert.equal(merged.collapsed!.intermediates, true);
    console.log(`       merged ${merged.collapsed!.chunks} deliveries, ${merged.collapsed!.ops} ops`);
  } else {
    console.log('       pty coalesced every write; nothing to merge on this platform');
  }
});

test('a merged job can be played back: the states it swallowed are readable', async (t) => {
  // The whole reason `collapsed` exists. A job is classified over its span,
  // which is what makes a repaint legible, and what it nets to may be nothing
  // at all -- a highlight that moved out and back leaves no trace. The count
  // says something happened; this is the thing that shows what.
  const { session, history, updates } = open({ jobPolicy: { gapMs: GAP_MS } });
  t.after(() => session.dispose());

  await waitFor(() => updates.some((u) => u.collapsed && u.collapsed.chunks > 1));
  const job = updates.find((u) => u.collapsed && u.collapsed.chunks > 1)!;
  const { rawFrom, rawTo, chunks } = job.collapsed!;

  const playback = history.deliveries(rawFrom, rawTo);
  assert.equal(playback.length, chunks, 'one record per raw delivery the job swallowed');
  assert.ok(playback.length > 1, 'the job really did merge');

  const seqs = playback.map((r) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'in the order they arrived');
  for (const r of playback) {
    assert.equal(r.job, job.seq, 'tied to the job it was grouped into');
    assert.ok(r.screen, 'each one reconstructs to a screen');
  }
  assert.notDeepEqual(
    playback[0]!.screen.lines,
    job.screen.lines,
    'the first intermediate state is not the first state the job reported',
  );
  // The strongest check available: replay the whole job and the last
  // intermediate must land on the screen the job itself reported. If a single
  // delta in the chain were lossy, this would not match.
  assert.deepEqual(
    playback.at(-1)!.screen.lines,
    job.screen.lines,
    'replaying every intermediate lands on the screen the job reported',
  );
});

test('with grouping opted out, the session reports no merging rather than inventing one', async (t) => {
  const { session, updates } = open({ jobPolicy: false });
  t.after(() => session.dispose());

  const got = await waitFor(() => updates.length >= 1);
  assert.ok(got, 'expected at least one update');
  for (const u of updates) {
    assert.equal(u.collapsed, null, 'no job policy means nothing was merged');
  }
});
