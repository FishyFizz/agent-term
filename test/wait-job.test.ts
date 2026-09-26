/**
 * Waiting for a job, against a real pty.
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

function open(script: string, jobPolicy?: { gapMs: number; maxBytes?: number } | false) {
  const session = new TerminalSession('wait-job', {
    command: process.execPath,
    args: ['-e', script],
    cols: 50,
    rows: 8,
    ...(jobPolicy === undefined ? {} : { jobPolicy }),
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

test('a job wait ends on a job, and returns it whole', async (t) => {
  const { session } = open(MENU_SCRIPT);
  t.after(() => session.dispose());

  const result = await session.waitForJob({ timeoutMs: 10000 });
  assert.equal(result.reason, 'job', 'the menu drew');
  assert.ok(result.job !== null, 'and says which job');
  assert.ok(result.screen, 'and carries the screen, so no second read is needed');
  assert.ok(result.seq > result.sinceSeq, 'ending at a state after the baseline');

  // The point of hanging on the update rather than on the job's close: the
  // job, its screen and why it closed all arrive in one call. At close time
  // none of them exists yet -- feed is async and queued.
  assert.ok(result.collapsed, 'with what was merged');
  assert.equal(result.collapsed!.reason, 'gap', 'the program went quiet on its own');
  assert.ok(
    session.screen.snapshot().lines.some((l) => l.includes('alpha')),
    'and the screen is the one the job produced',
  );
});

test('the baseline decides, so a job from before the input cannot satisfy it', async (t) => {
  const { session } = open(MENU_SCRIPT);
  t.after(() => session.dispose());

  const first = await session.waitForJob({ timeoutMs: 10000 });
  assert.equal(first.reason, 'job');

  // The bug this prevents is the one `sinceByte` prevents for a pattern: with
  // no baseline, a job that closed before the caller asked would be handed
  // back as if it were the answer to this call.
  const seen = first.seq;
  const again = await session.waitForJob({ sinceSeq: seen, timeoutMs: 10000 });
  assert.ok(
    again.reason !== 'job' || again.seq > seen,
    'a job already seen is not offered again',
  );
});

test('without grouping every update is its own job, so the wait still ends', async (t) => {
  const { session } = open(MENU_SCRIPT, false);
  t.after(() => session.dispose());

  assert.equal(session.grouping, false, 'opened with grouping off');
  // Not an error, and not a hang: with no detector there is no boundary to
  // group to, so each update is a job of one. Ending on it is the honest
  // answer -- the caller asked for the next act of output and there is no
  // grouping that could say what one act is.
  const result = await session.waitForJob({ timeoutMs: 10000 });
  assert.equal(result.reason, 'job');
  assert.equal(result.collapsed, null, 'and nothing was merged, which is the truth');
});

test('a disposed session ends the wait with a reason, not a timeout', async (t) => {
  const { session } = open('setInterval(()=>{},1000)');
  t.after(() => session.dispose());

  // `dispose()` clears the listener lists before it wakes anyone, so a waiter
  // subscribed only to updates would be silently unsubscribed and would sit
  // out its deadline -- indistinguishable from a timeout.
  const waiting = session.waitForJob({ timeoutMs: 10000 });
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

  const result = await session.waitForJob({ timeoutMs: 10000 });
  assert.equal(result.reason, 'job', 'it returns rather than hanging');
  assert.ok(result.collapsed);
  assert.ok(
    result.collapsed!.reason === 'bytes' || result.collapsed!.reason === 'chunks',
    `cut by a cap, not by silence (got ${result.collapsed!.reason})`,
  );
  assert.ok(result.collapsed!.chunks > 1, 'and it merged what it cut');
});
