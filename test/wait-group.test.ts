/**
 * Waiting for a group, against a real pty.
 *
 * The menu subject is the case the other two waits cannot serve: it repaints
 * with no stable text to anchor a pattern on, and it pauses between repaints
 * rather than stopping, so idle answers "it went quiet" without saying
 * whether a repaint happened at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSession, type SessionUpdate } from '../src/session.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const E = '\\x1b';

/** Paint a list, move the highlight through it with a clear gap, and stop. */
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
    await pause(200);
    draw(sel);
  }
  await pause(200);
  W('${E}[?1049l');
})();
`;

/** Writes flat out with no pause at all, so no gap ever opens. */
const FIREHOSE = `
const line = 'x'.repeat(511) + '\\n';
for (;;) process.stdout.write(line);
`;

function open(script: string, groupPolicy?: { gapMs: number; maxBytes?: number } | false) {
  const session = new TerminalSession('wait-group', {
    command: process.execPath,
    args: ['-e', script],
    cols: 50,
    rows: 8,
    ...(groupPolicy === undefined ? {} : { groupPolicy }),
  });
  const updates: SessionUpdate[] = [];
  session.onUpdate((u) => updates.push(u));
  return { session, updates };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return false;
}

test('a group wait ends on a group, and returns it whole', async (t) => {
  const { session } = open(MENU_SCRIPT);
  t.after(() => session.dispose());

  const result = await session.waitForGroup({ timeoutMs: 10000 });
  assert.equal(result.reason, 'group', 'the menu drew');
  assert.ok(result.group !== null, 'and says which group');
  assert.ok(result.screen, 'and carries the screen, so no second read is needed');
  assert.ok(result.seq > result.sinceSeq, 'ending at a state after the baseline');

  // The point of hanging on the update rather than on the group's close: the
  // group, its screen and why it closed all arrive in one call. At close time
  // none of them exists yet -- feed is async and queued.
  assert.ok(result.collapsed, 'with what was merged');
  assert.equal(result.collapsed!.reason, 'gap', 'the program went quiet on its own');
  assert.ok(
    session.screen.snapshot().lines.some((l) => l.includes('alpha')),
    'and the screen is the one the group produced',
  );
});

test('the baseline decides, so a group from before the input cannot satisfy it', async (t) => {
  const { session } = open(MENU_SCRIPT);
  t.after(() => session.dispose());

  const first = await session.waitForGroup({ timeoutMs: 10000 });
  assert.equal(first.reason, 'group');

  // The bug this prevents is the one `sinceByte` prevents for a pattern: with
  // no baseline, a group that closed before the caller asked would be handed
  // back as if it were the answer to this call.
  const seen = first.seq;
  const again = await session.waitForGroup({ sinceSeq: seen, timeoutMs: 10000 });
  assert.ok(
    again.reason !== 'group' || again.seq > seen,
    'a group already seen is not offered again',
  );
});

test('a group that closed before the wait began is still the answer', async (t) => {
  const { session, updates } = open(MENU_SCRIPT);
  t.after(() => session.dispose());

  // Let the act complete first, then ask about it. That is the round trip an
  // agent has between sending a key and waiting on it -- seconds, not
  // milliseconds -- so the program has finished repainting long before the
  // wait is issued. Measured in `feedbacks/edca2559`: two of three group waits
  // slept their whole deadline over an act `read_screen` returned on the next
  // call, because listening for the *next* group cannot hear one that already
  // closed.
  assert.ok(await waitFor(() => updates.length > 0), 'an act completed');

  const result = await session.waitForGroup({ timeoutMs: 10000 });
  assert.equal(result.reason, 'group', 'the act that already happened is the answer');
  assert.ok(
    result.waitedMs < 1000,
    `and it did not sleep to the deadline (waited ${result.waitedMs}ms)`,
  );
  assert.ok(result.screen, 'carrying the screen, so no second call is needed');
});

test('the catch-up still respects the baseline it is given', async (t) => {
  const { session, updates } = open(MENU_SCRIPT);
  t.after(() => session.dispose());

  // The catch-up must not become a way to be handed the same act forever: it
  // is the same `seq > sinceSeq` test the live listener makes, so naming the
  // state just seen rules it out.
  const first = await session.waitForGroup({ timeoutMs: 10000 });
  assert.equal(first.reason, 'group');
  assert.ok(await waitFor(() => updates.at(-1)!.seq > first.seq), 'a later act closed');

  const again = await session.waitForGroup({ sinceSeq: first.seq, timeoutMs: 10000 });
  assert.ok(
    again.reason !== 'group' || again.seq > first.seq,
    'a group already seen is not offered again',
  );
});

test('without grouping every update is its own group, so the wait still ends', async (t) => {
  const { session } = open(MENU_SCRIPT, false);
  t.after(() => session.dispose());

  assert.equal(session.grouping, false, 'opened with grouping off');
  // Not an error, and not a hang: with no detector there is no boundary to
  // group to, so each update is a group of one. Ending on it is the honest
  // answer -- the caller asked for the next act of output and there is no
  // grouping that could say what one act is.
  const result = await session.waitForGroup({ timeoutMs: 10000 });
  assert.equal(result.reason, 'group');
  assert.equal(result.collapsed, null, 'and nothing was merged, which is the truth');
});

test('a disposed session ends the wait with a reason, not a timeout', async (t) => {
  const { session } = open('setInterval(()=>{},1000)');
  t.after(() => session.dispose());

  // `dispose()` clears the listener lists before it wakes anyone, so a waiter
  // subscribed only to updates would be silently unsubscribed and would sit
  // out its deadline -- indistinguishable from a timeout.
  const waiting = session.waitForGroup({ timeoutMs: 10000 });
  await delay(50);
  session.dispose();
  const result = await waiting;

  assert.equal(result.reason, 'disposed', 'the session is gone, and says so');
  assert.ok(result.waitedMs < 5000, 'and it did not wait out the deadline');
});

test('a firehose is cut by a cap, and says the program has not stopped', async (t) => {
  // `bytes` and `chunks` are not failures: they are the "too much output,
  // return anyway" mechanism. What the caller must be told is that the
  // program is still writing.
  // A tight write loop, so no gap ever opens: `setInterval` at 1ms still
  // leaves a gap and closes on silence, which would test the wrong path.
  const { session } = open(FIREHOSE, { gapMs: 50, maxBytes: 4096 });
  t.after(() => session.dispose());

  const result = await session.waitForGroup({ timeoutMs: 10000 });
  assert.equal(result.reason, 'group', 'it returns rather than hanging');
  assert.ok(result.collapsed);
  assert.ok(
    result.collapsed!.reason === 'bytes' || result.collapsed!.reason === 'chunks',
    `cut by a cap, not by silence (got ${result.collapsed!.reason})`,
  );
  assert.ok(result.collapsed!.chunks > 1, 'and it merged what it cut');
});
