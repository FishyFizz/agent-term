/**
 * End to end: a real shell, real pty bytes, through the emulator and the
 * classifier.
 *
 * The unit tests feed hand-written escape sequences. These feed whatever a
 * real PowerShell/sh actually emits, which is the only way to know the
 * classifier survives contact with a program nobody wrote for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSession } from '../src/session.js';
import { applyDelta } from '../src/delta.js';
import { HistoryStore } from '../src/history.js';
import { SessionHost } from '../src/host.js';
import type { PtyExitInfo } from '../src/pty.js';

const isWindows = process.platform === 'win32';
const command = isWindows ? 'powershell.exe' : '/bin/sh';
const args = isWindows ? ['-NoLogo', '-NoProfile'] : [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a live session over a real shell.
 *
 * `TerminalSession` constructs its own pty, so the registry is not used to
 * spawn here -- using both would start two shells per test and leave one
 * alive at teardown.
 *
 * The session wires pty data to its own classifier, so subscribing is all a
 * caller does; there is no separate feed step to forget.
 */
function harness() {
  const session = new TerminalSession('test-session', { command, args, cols: 100, rows: 24 });
  const updates: Awaited<ReturnType<TerminalSession['feed']>>[] = [];
  session.onUpdate((u) => updates.push(u));
  return { session, updates };
}

function waitFor(
  predicate: () => boolean,
  { timeoutMs = 10000, label = 'condition' } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(25);
    }
    console.log(`       (timed out waiting for ${label})`);
    return false;
  })();
}

test('a real shell session reports its output as ordered writing segments', async (t) => {
  const { session, updates } = harness();
  t.after(() => session.dispose());

  assert.ok(session.pty.alive, 'session is live');

  session.pty.write('echo AGENTTERM-E2E\r\n');
  const got = await waitFor(
    () => updates.some((u) => u.screen.lines.some((l) => l.includes('AGENTTERM-E2E'))),
    { label: 'echo output' },
  );
  assert.ok(got, 'the echo appeared on the screen');

  // Sequence numbers are ordered and start at 1.
  assert.ok(updates.length > 0, 'at least one update');
  const seqs = updates.map((u) => u.seq);
  assert.equal(seqs[0], 1, 'first update is seq 1');
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    'sequence numbers are ordered',
  );

  // Byte ranges are contiguous and never go backwards.
  for (let i = 1; i < updates.length; i++) {
    assert.equal(updates[i]!.fromByte, updates[i - 1]!.toByte, 'updates tile the byte stream');
  }

  // Every segment carries evidence, and the screen is present.
  for (const u of updates) {
    assert.ok(u.segments.length > 0, `update ${u.seq} has segments`);
    for (const s of u.segments) {
      assert.ok(s.toByte >= s.fromByte, 'segment range well-formed');
      assert.ok(Array.isArray(s.evidence.ops), 'evidence attached');
    }
    assert.equal(u.screen.lines.length, 24, 'screen is a full grid');
    for (const line of u.screen.lines) assert.equal(line.length, 100, 'row is full width');
  }

  // L1.3: the watermark is present and monotonic.
  assert.ok(updates.at(-1)!.io.bytesRead > 0, 'bytes watermark advanced');
  for (let i = 1; i < updates.length; i++) {
    assert.ok(updates[i]!.io.bytesRead >= updates[i - 1]!.io.bytesRead, 'watermark monotonic');
  }
});

test('the screen model tracks what the shell actually shows', async (t) => {
  const { session, updates } = harness();
  t.after(() => session.dispose());

  session.pty.write('echo MARKER-XYZ\r\n');
  await waitFor(() => updates.some((u) => u.screen.lines.some((l) => l.includes('MARKER-XYZ'))), {
    label: 'marker',
  });

  const last = updates.at(-1)!;
  const text = last.screen.lines.join('\n');
  assert.ok(text.includes('MARKER-XYZ'), 'marker visible on the captured screen');
  assert.ok(
    text.includes('PS ') || text.includes('$') || text.includes('>'),
    'a shell prompt is on the screen',
  );
});

test('a command producing many lines is classified without drowning', async (t) => {
  const { session, updates } = harness();
  t.after(() => session.dispose());

  // A firehose: 200 lines, more than the 24-row screen.
  session.pty.write('1..200 | % { $_ }\r\n');
  await waitFor(() => session.seq > 0 && updates.at(-1)!.io.bytesRead > 500, {
    label: 'bulk output',
    timeoutMs: 15000,
  });

  assert.ok(updates.length > 0, 'updates arrived');
  const totalSegments = updates.reduce((n, u) => n + u.segments.length, 0);
  // The point of coalescing: bounded, not one segment per echoed line.
  assert.ok(
    totalSegments < updates.length * 40,
    `segment count stays bounded (${totalSegments} segments / ${updates.length} updates)`,
  );

  // And the screen remained a consistent grid throughout.
  for (const u of updates) {
    assert.equal(u.screen.lines.length, 24);
    assert.equal(u.screen.rows, 24);
    assert.equal(u.screen.cols, 100);
  }
});

test("every update's delta reproduces that update's screen exactly", async (t) => {
  const { session, updates } = harness();
  t.after(() => session.dispose());

  session.pty.write('1..200 | % { $_ }\r\n');
  await waitFor(() => session.seq > 0 && updates.at(-1)!.io.bytesRead > 500, {
    label: 'bulk output',
    timeoutMs: 15000,
  });

  // The invariant the timeline rests on. A delta is stored instead of a screen,
  // so if one encoding were wrong -- a missed scroll, a mis-aligned run -- every
  // later read of that history would be silently corrupt, and the screen stored
  // alongside it would look perfectly fine. Checking both together is the only
  // way to catch it here rather than three layers up.
  let checked = 0;
  for (let i = 1; i < updates.length; i++) {
    const previous = updates[i - 1]!;
    const current = updates[i]!;
    if (!current.grid) continue;
    checked++;
    const restored = applyDelta(previous.screen, current.grid);
    assert.deepEqual(
      restored.lines,
      current.screen.lines,
      `update ${current.seq}'s delta reconstructs its screen`,
    );
    assert.deepEqual(
      restored.styles,
      current.screen.styles,
      `update ${current.seq}'s delta reconstructs its colours`,
    );
    assert.deepEqual(restored.wide, current.screen.wide, `update ${current.seq}'s widths`);
  }
  assert.ok(checked > 0, `the run produced deltas to check (${checked})`);
});

test('a bulk run keeps the lines the grid cannot hold', async (t) => {
  const { session, updates } = harness();
  t.after(() => session.dispose());

  // 200 lines into a 24-row screen: the overwhelming majority cannot survive on
  // the grid, which is the whole reason the text log exists. Wait for the *last*
  // line rather than a count, so the assertions below run on a finished command
  // instead of racing one still producing output.
  session.pty.write('1..200 | % { "AGENTTERM-LINE-$_" }\r\n');
  const got = await waitFor(
    () => updates.some((u) => u.text.some((l) => l.text.includes('AGENTTERM-LINE-200'))),
    { label: 'the final line', timeoutMs: 15000 },
  );
  assert.ok(got, 'the run finished');

  const lines = updates.flatMap((u) => u.text.map((l) => l.text));
  assert.ok(lines.length >= 150, `captured ${lines.length} lines, far more than the 24 rows`);
  assert.ok(
    lines.some((l) => l.includes('AGENTTERM-LINE-1')),
    'including one the screen scrolled away long ago',
  );
  assert.ok(
    lines.some((l) => l.includes('AGENTTERM-LINE-200')),
    'and the most recent one',
  );
  assert.ok(new Set(lines).size >= 150, 'distinct lines, not collapsed into a set');
});

test('a resize is reported, and only after what was already queued', async (t) => {
  const { session } = harness();
  t.after(() => session.dispose());

  const seen: number[] = [];
  session.onResize((size) => seen.push(size.cols));

  session.resize(90, 20);
  // The resize itself is applied synchronously -- the program inside must be
  // told promptly -- but the boundary is queued behind anything in flight, so
  // it cannot be reported in the middle of a delivery.
  // `deepEqual(seen, [])` would narrow `seen` to never[] under node's assertion
  // signature, so the emptiness check is a length.
  assert.equal(seen.length, 0, 'not fired inline');
  assert.equal(session.screen.cols, 90, 'but the resize has already taken effect');

  const got = await waitFor(() => seen.length > 0, { label: 'resize notification' });
  assert.ok(got, 'the boundary was reported');
  assert.deepEqual(seen, [90]);

  const unsubscribe = session.onResize(() => seen.push(-1));
  unsubscribe();
  session.resize(95, 25);
  await waitFor(() => seen.length > 1, { label: 'second resize' });
  assert.deepEqual(seen, [90, 95], 'unsubscribing stops delivery');
});

test('the process exiting is reported, with its status', async (t) => {
  // The shell the harness already uses, told to leave -- rather than a
  // throwaway command, whose ConPTY teardown wedges on this platform.
  const { session } = harness();
  t.after(() => session.dispose());

  const seen: PtyExitInfo[] = [];
  session.onExit((info) => seen.push(info));
  session.pty.write('exit\r\n');

  const got = await waitFor(() => seen.length > 0, { label: 'exit' });
  assert.ok(got, 'the exit was reported');
  assert.equal(seen.length, 1, 'reported once');
  assert.equal(session.pty.alive, false, 'the session knows it is over');
  assert.ok(seen[0]?.exitCode !== undefined, 'with a status, not an absent one');
});

test('history reconstructs every screen of a live session', async (t) => {
  const { session, updates } = harness();
  const history = new HistoryStore().open(session);
  t.after(() => session.dispose());

  session.pty.write('1..40 | % { "HIST-$_" }\r\n');
  await waitFor(() => updates.some((u) => u.screen.lines.some((l) => l.includes('HIST-40'))), {
    label: 'the last line',
    timeoutMs: 15000,
  });

  const epochs = history.epochs();
  assert.equal(epochs.length, 1, 'no resize, so one epoch');
  assert.equal(epochs[0]?.cols, 100);

  // The whole point: a reader gets the screen back exactly, having stored
  // deltas rather than screens. Compared against the screens the session
  // actually reported, so this checks the timeline against the live emulator
  // and not against itself.
  const bySeq = new Map(updates.map((u) => [u.seq, u]));
  const page = history.read({ limit: 1000 });
  let checked = 0;
  for (const record of page.records) {
    const update = bySeq.get(record.seq);
    if (!update) continue;
    checked++;
    assert.deepEqual(
      history.screenAt({ seq: record.seq })?.lines,
      update.screen.lines,
      `the screen at seq ${record.seq} is the screen the session reported`,
    );
  }
  assert.ok(checked > 5, `compared real screens (${checked})`);
});

test('a live resize splits the timeline and freezes the old epoch at its size', async (t) => {
  const { session, updates } = harness();
  const history = new HistoryStore().open(session);
  t.after(() => session.dispose());

  session.pty.write('echo BEFORE-RESIZE\r\n');
  await waitFor(
    () => updates.some((u) => u.screen.lines.some((l) => l.includes('BEFORE-RESIZE'))),
    { label: 'pre-resize output' },
  );
  const beforeResize = session.seq;

  session.resize(60, 20);
  session.pty.write('echo AFTER-RESIZE\r\n');
  await waitFor(
    () => updates.some((u) => u.seq > beforeResize && u.screen.lines.some((l) => l.includes('AFTER-RESIZE'))),
    { label: 'post-resize output' },
  );

  const epochs = history.epochs();
  assert.ok(epochs.length >= 2, `the resize split the timeline (${epochs.length} epochs)`);
  assert.equal(epochs[0]?.cols, 100, 'what came before stays at the old size');
  assert.equal(epochs.at(-1)?.cols, 60, 'and after the boundary, history is new');

  // The delivered rule: asking for frozen history gives the size it was made at.
  const frozen = history.read({ limit: 100 });
  assert.equal(frozen.epoch.cols, 100);
  assert.ok(frozen.records.length > 0, 'the old epoch still has records');
  assert.ok(frozen.next, 'and a token leads into the new one');

  const fresh = history.read({ from: frozen.next!, limit: 100 });
  assert.equal(fresh.epoch.cols, 60, 'the next page reports the new size');
  assert.ok(fresh.records.length > 0);
});

test('the host starts recording the moment it opens a session', async (t) => {
  const host = new SessionHost();
  t.after(() => host.disposeAll());

  const { session, history } = host.open({ command, args, cols: 100, rows: 24 });
  assert.equal(history.sessionId, session.id, 'the timeline knows whose it is');
  assert.equal(host.historyFor(session.id), history, 'and is reachable by id');
  assert.equal(host.session(session.id), session);
  assert.equal(history.epochs().length, 1, 'epoch 0 exists before any output');

  session.pty.write('echo HOST-MARKER\r\n');
  const recorded = await waitFor(
    () => history.textSince(undefined, 200).lines.some((l) => l.text.includes('HOST-MARKER')),
    { label: 'recorded output' },
  );
  assert.ok(recorded, 'recorded without anyone having to ask it to');

  // Closing ends the session; it must not end the record.
  assert.equal(host.close(session.id), true);
  assert.equal(host.session(session.id), undefined, 'gone from the registry');
  const kept = host.historyFor(session.id);
  assert.ok(kept, 'still in the store');
  assert.ok(
    kept.textSince(undefined, 200).lines.some((l) => l.text.includes('HOST-MARKER')),
    'and still readable: that is what surviving the process means',
  );
  assert.ok(kept.epochs()[0]?.records, 'with its records intact');
});

test('resizing a live session keeps pty and screen in step', async (t) => {
  const { session, updates } = harness();
  t.after(() => session.dispose());

  session.resize(120, 40);
  assert.equal(session.pty.cols, 120);
  assert.equal(session.screen.cols, 120, 'screen resized with the pty');

  session.pty.write('echo AFTER-RESIZE\r\n');
  await waitFor(() => updates.some((u) => u.screen.lines.some((l) => l.includes('AFTER-RESIZE'))), {
    label: 'post-resize output',
  });
  const last = updates.at(-1)!;
  assert.equal(last.screen.cols, 120, 'updates report the new size');
  for (const line of last.screen.lines) assert.equal(line.length, 120, 'rows are the new width');
});
