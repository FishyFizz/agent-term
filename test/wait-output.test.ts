/**
 * Waiting for a pattern, against a real pty.
 *
 * The subject is `node -e`, not a shell, so the bytes are ours: a prompt on the
 * current row, nothing while it works, one line of answer per input. That is
 * the shape the wait exists for -- and it is the shape `fixtures/life` has, so
 * what is asserted here is what an agent driving that subject depends on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSession, type OutputWaitResult } from '../src/session.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Prints a prompt and nothing else, for as long as it is left running. */
const QUIET = "process.stdout.write('READY> ');setInterval(()=>{},1000)";

/** A prompt, then one line of answer per input, then the prompt again. */
const REACTIVE =
  "let n=0;process.stdout.write('PROMPT> ');" +
  "process.stdin.on('data',()=>{n++;process.stdout.write('GOT-'+n+'\\r\\n');" +
  "setTimeout(()=>process.stdout.write('PROMPT> '),150)});";

function probe(script: string): TerminalSession {
  return new TerminalSession('wait-output', {
    command: process.execPath,
    args: ['-e', script],
    cols: 60,
    rows: 12,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return false;
}

test('a row already on screen is not new output: the baseline decides', async (t) => {
  const session = probe(QUIET);
  t.after(() => session.dispose());

  assert.ok(await waitFor(() => session.pty.bytesRead > 0), 'the prompt arrived');
  const settled = await session.waitForIdle({ idleMs: 60, timeoutMs: 5000 });
  assert.equal(settled.reason, 'idle', 'and the subject went quiet');
  const afterPrompt = session.pty.bytesRead;

  // This is the bug the baseline exists for. The prompt is on the screen, and
  // it was there before the caller started waiting; a wait that matched the
  // state rather than the change would resolve instantly, on a row the program
  // printed before the caller typed anything.
  const stale = await session.waitForOutput({
    pattern: /^READY>$/,
    sinceByte: afterPrompt,
    timeoutMs: 250,
  });
  assert.equal(stale.reason, 'timeout', 'a row from before the baseline is not a match');
  assert.equal(stale.match, null);
  assert.equal(stale.sinceByte, afterPrompt, 'and the result says which baseline was used');

  // Same row, same wait, earlier baseline: now it is content the caller has not
  // had, and it matches without anything new being produced.
  const fresh: OutputWaitResult = await session.waitForOutput({
    pattern: /^READY>$/,
    sinceByte: 0,
    timeoutMs: 2000,
  });
  assert.equal(fresh.reason, 'matched', 'and it is a match against the same screen');
  assert.ok(fresh.match);
  assert.equal(fresh.match!.surface, 'screen');
  assert.equal(fresh.match!.text, 'READY>', 'reported as it was matched, with the padding gone');
  assert.equal(fresh.match!.row, 0);
  assert.ok(fresh.match!.atByte > 0 && fresh.match!.atByte <= afterPrompt, 'after the baseline');
});

test('a prompt is not a completed line, so text alone never sees it', async (t) => {
  const session = probe(QUIET);
  t.after(() => session.dispose());

  assert.ok(await waitFor(() => session.pty.bytesRead > 0), 'the prompt arrived');
  await session.waitForIdle({ idleMs: 60, timeoutMs: 5000 });

  // The cursor is still sitting on the prompt row, so no linefeed ever
  // completed it and the text log has no such line (`text-log.ts`). A caller
  // that asked for text only gets an honest timeout rather than a wrong match.
  const result = await session.waitForOutput({
    pattern: /^READY>$/,
    surface: 'text',
    sinceByte: 0,
    timeoutMs: 250,
  });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.match, null);
});

test('a completed line is matched from the wait onward', async (t) => {
  const session = probe(QUIET);
  t.after(() => session.dispose());

  assert.ok(await waitFor(() => session.pty.bytesRead > 0), 'the prompt arrived');

  // Registered before the bytes are fed, and the feed is what resolves it: no
  // polling anywhere in this test.
  const waiting = session.waitForOutput({ pattern: /BANANA/, surface: 'text', timeoutMs: 5000 });
  await session.feed(Buffer.from('\r\nBANANA\r\n', 'utf8'));
  const result = await waiting;

  assert.equal(result.reason, 'matched');
  assert.ok(result.match);
  assert.equal(result.match!.surface, 'text');
  assert.equal(result.match!.row, null, 'a line has no row: it may have scrolled off');
  assert.equal(result.match!.text, 'BANANA');
});

test('an exit ends a pattern wait: no future byte can match', async (t) => {
  // Writes its prompt and returns, so the pty exits on its own.
  const session = probe("process.stdout.write('READY> ')");
  t.after(() => session.dispose());

  const result = await session.waitForOutput({ pattern: /NEVER-SEEN/, timeoutMs: 10000 });
  assert.equal(result.reason, 'exited', 'the process is gone and its output is parsed');
  assert.ok(result.state.exit !== null, 'with the exit facts on it');
  assert.ok(result.waitedMs < 10000, `it did not sit out the timeout (waited ${result.waitedMs}ms)`);
});

test('a pattern that never appears times out, saying what it saw', async (t) => {
  const session = probe(QUIET);
  t.after(() => session.dispose());

  assert.ok(await waitFor(() => session.pty.bytesRead > 0), 'the prompt arrived');

  const result = await session.waitForOutput({ pattern: /NEVER-SEEN/, timeoutMs: 200 });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.match, null);
  assert.ok(result.waitedMs >= 200, 'the bound was the caller’s, not an invented interval');
  assert.ok(result.state.idleMs !== null, 'with the facts, for the caller to judge');
});

test('the default baseline is the last input, so the echo is not the answer', async (t) => {
  const session = probe(REACTIVE);
  t.after(() => session.dispose());

  assert.ok(await waitFor(() => session.pty.bytesRead > 0), 'the first prompt arrived');
  await session.waitForIdle({ idleMs: 80, timeoutMs: 5000 });

  session.pty.write('hello\r\n');
  const typedAt = session.lastInputByte;
  assert.ok(typedAt > 0, 'writing input stamps the watermark a wait starts from');

  // The tty echoes `hello`, so the prompt row becomes `PROMPT> hello` -- new
  // content by every measure. The anchored pattern is what keeps the echo from
  // resolving the wait before the program has answered, and the baseline is
  // what keeps the *old* prompt row from doing it.
  const result = await session.waitForOutput({ pattern: /^PROMPT>$/, timeoutMs: 10000 });
  assert.equal(result.reason, 'matched');
  assert.ok(result.match);
  assert.equal(result.match!.surface, 'screen');
  assert.equal(result.match!.text, 'PROMPT>', 'the bare prompt, not the echoed line');
  assert.equal(result.sinceByte, typedAt, 'no sinceByte given, so the last input is the baseline');
  assert.ok(result.match!.atByte > typedAt, 'and what matched was produced after it');
});
