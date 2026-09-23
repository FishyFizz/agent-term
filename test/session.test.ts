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
    assert.deepEqual(
      applyDelta(previous.screen, current.grid).lines,
      current.screen.lines,
      `update ${current.seq}'s delta reconstructs its screen`,
    );
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
