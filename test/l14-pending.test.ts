/**
 * The pending prompt is not observable — so what gets built instead.
 *
 * Measured on this machine, four candidates all fail to distinguish a shell
 * blocked at a prompt from a shell busy on a builtin:
 *
 *   - process state: identical (same pid, same name, same thread count)
 *   - child processes: a busy builtin has none, so it looks like a prompt
 *   - echo probing: echoes in both states, and writes to the thing observed
 *   - node-pty: exposes no unread-byte query at all
 *
 * So there is no `atPrompt`, and these tests are the guard against one being
 * added later by someone who assumes it is just a matter of looking harder.
 * What is built instead is the two things that *are* facts:
 *
 *  1. `inputUnconsumed` — a byte count. How much went in with nothing back.
 *  2. `afterInput` — placement. Whether a group's bytes follow the last write.
 *
 * Neither says the program is waiting. Both are measurable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSession } from '../src/session.js';

const command = process.platform === 'win32' ? 'cmd.exe' : 'bash';
const args: string[] = [];

/** Poll until `ok`, or fail with the label — no bare sleeps in these tests. */
async function waitFor(ok: () => boolean, opts: { label: string; timeoutMs?: number }): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15000);
  while (Date.now() < deadline) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${opts.label}`);
}

/**
 * A real clock, not `FakeClock`: these waits run against a real pty and a fake
 * clock never advances on its own, so the wait would hang forever. The fake
 * one is for tests that drive time by hand.
 */
function harness() {
  const session = new TerminalSession('l14', { command, args, cols: 80, rows: 24 });
  return { session };
}

test('before any input the input watermark is null, not zero', async (t) => {
  const { session } = harness();
  t.after(() => session.dispose());

  // "nothing written" and "cannot say" are different facts. A 0 here
  // would be read as "it consumed everything", which is a claim.
  assert.equal(session.state().inputUnconsumed, null);
});

test('unconsumed input is counted, and clears once output comes back', async (t) => {
  const { session } = harness();
  t.after(() => session.dispose());

  await waitFor(() => session.pty.bytesRead > 0, { label: 'the first prompt' });

  // Output has arrived, so nothing written yet is unconsumed.
  assert.equal(session.state().inputUnconsumed, null, 'no input yet — null, not 0');

  session.pty.write('echo l14-probe\r');
  // Immediately after the write, and before the shell has echoed anything
  // back, the bytes are unconsumed.
  const justAfter = session.state().inputUnconsumed;
  assert.ok(justAfter !== null && justAfter > 0, `counted what went in (${justAfter})`);

  // Once the program produces output, the count returns to 0 — it is not a
  // high-water mark, it answers "has anything come back since".
  await waitFor(() => session.state().inputUnconsumed === 0, {
    label: 'output following the input',
  });
});

test('the count is what is pending, not everything ever written', async (t) => {
  const { session } = harness();
  t.after(() => session.dispose());

  await waitFor(() => session.pty.bytesRead > 0, { label: 'the first prompt' });

  // One write, answered. Those bytes are spent, and must not be carried into
  // the next count: the total ever written is a high-water mark, and this
  // field is documented as not being one.
  session.pty.write('echo l14-spent\r');
  await waitFor(() => session.state().inputUnconsumed === 0, { label: 'the first reply' });

  // A second write, unread. Read synchronously: no output can have been
  // processed in the same tick, so this is the count with only these bytes in
  // flight and the answered ones behind it.
  const pending = 'echo l14-pending\r';
  session.pty.write(pending);

  assert.equal(
    session.state().inputUnconsumed,
    Buffer.byteLength(pending),
    'only the second write is outstanding — the answered one is not added to it',
  );
});

test('a group wait reports whether its bytes follow the last input', async (t) => {
  const { session } = harness();
  t.after(() => session.dispose());

  await waitFor(() => session.pty.bytesRead > 0, { label: 'the first prompt' });

  // No input yet: placement is undefined, not false.
  const before = await session.waitForGroup({ timeoutMs: 3000 });
  assert.equal(before.afterInput, null, 'no input, so no placement to report');

  // Now send input and wait for the group it produces.
  session.pty.write('echo l14-after\r');
  const after = await session.waitForGroup({ timeoutMs: 15000 });
  assert.equal(after.reason, 'group');
  assert.equal(after.afterInput, true, 'the group contains bytes produced after the write');
});

test('a wait that ends without a group reports no placement rather than guessing', async (t) => {
  const { session } = harness();
  t.after(() => session.dispose());

  await waitFor(() => session.pty.bytesRead > 0, { label: 'the first prompt' });
  session.pty.write('echo l14-timeout\r');

  // Nothing new will arrive, so this times out. Placement is null: there is
  // no group to place, and false would mean "it was before your input",
  // which is a different claim and not one this wait can make.
  const result = await session.waitForGroup({
    timeoutMs: 60,
    sinceSeq: Number.MAX_SAFE_INTEGER,
  });
  if (result.reason !== 'group') {
    assert.equal(result.afterInput, null, 'no group, so no placement claimed');
  }
});

test('there is no atPrompt — the state exposes no verdict about waiting', async (t) => {
  const { session } = harness();
  t.after(() => session.dispose());

  await waitFor(() => session.pty.bytesRead > 0, { label: 'the first prompt' });
  const keys = Object.keys(session.state()).sort();

  // The guard. If someone adds `atPrompt`, `settled`, or `waiting` later,
  // this fails and the research has to be redone rather than assumed away.
  for (const banned of ['atPrompt', 'settled', 'waiting', 'blocked', 'ready']) {
    assert.ok(!keys.includes(banned), `no verdict field: ${banned}`);
  }
  assert.deepEqual(
    keys,
    ['bytesPending', 'drained', 'exit', 'idleMs', 'inputUnconsumed', 'running'],
    'measurements only',
  );
});
