/**
 * The lifelike subject, checked.
 *
 * These are not classifier tests -- the corpus does that, against committed
 * traces. These check the subject's own contract: that a seed is a replay, that
 * the subject says nothing and shows no prompt while it is working, that a line
 * typed into that silence is answered rather than dropped, and that the two
 * modes give the shell back when they are left.
 *
 * Timings and exact screen bytes are deliberately not asserted. The subject is
 * random by design, and ConPTY rewrites escape bytes, so the
 * assertions are on the emulator's screen and text log.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionHost } from '../src/host.js';
import { createRng, Pacer } from '../fixtures/life/rng.js';
import { nextAction } from '../fixtures/life/shell.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Subject {
  session: ReturnType<SessionHost['open']>['session'];
  close(): void;
  lines(): string[];
  screen(): string;
  atPrompt(): boolean;
  buffer(): 'normal' | 'alternate';
  send(text: string): void;
}

function openSubject(args: readonly string[] = []): Subject {
  const host = new SessionHost();
  const { session } = host.open({
    command: process.execPath,
    args: ['--import', 'tsx', 'fixtures/life/index.ts', ...args],
    cols: 80,
    rows: 24,
  });

  const seen: string[] = [];
  session.onUpdate((update) => {
    for (const entry of update.text) seen.push(entry.text);
  });

  return {
    session,
    close: () => {
      session.dispose();
      host.disposeAll();
    },
    lines: () => seen.slice(),
    screen: () => session.screen.snapshot().lines.map((l) => l.replace(/\s+$/, '')).join('\n'),
    atPrompt: () =>
      session.screen
        .snapshot()
        .lines.some((l) => l.trimEnd().endsWith('$')),
    buffer: () => session.screen.snapshot().buffer,
    send: (text) => session.pty.write(text),
  };
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  console.log(`       (timed out waiting for ${label})`);
  return false;
}

test('one seed replays as one run', () => {
  const actions = (seed: number): string[] => {
    const rng = createRng(seed);
    return Array.from({ length: 12 }, () => nextAction(rng));
  };

  assert.deepEqual(actions(42), actions(42), 'the same seed must pick the same actions');
  assert.notDeepEqual(actions(42), actions(43), 'a different seed must pick differently');
});

test('gaps stay inside the range the subject promises', () => {
  const rng = createRng(7);
  const pacer = new Pacer(rng, 1);
  let longest = 0;
  let actionsWithTwoLongGaps = 0;

  for (let action = 0; action < 50; action++) {
    pacer.begin();
    let longGaps = 0;
    // A multiline reply is the widest action: one gap per line.
    for (let i = 0; i < 6; i++) {
      const gap = pacer.gap();
      assert.ok(gap >= 300 && gap <= 20_000, `gap ${gap} is outside the promised 300ms..20s`);
      if (gap > 5_000) longGaps++;
      longest = Math.max(longest, gap);
    }
    if (longGaps > 1) actionsWithTwoLongGaps++;
  }

  assert.equal(actionsWithTwoLongGaps, 0, 'at most one long gap per action, so a turn stays bounded');
  assert.ok(longest > 5_000, 'the long gap must actually occur, or nothing tests patience');
});

test('the subject shows no prompt while it is working', async (t) => {
  const subject = openSubject(['--seed', '1', '--speed', '10', '--pick', 'multiline']);
  t.after(() => subject.close());

  assert.ok(await waitFor('first prompt', () => subject.atPrompt()), 'a prompt before anything is typed');

  subject.send('one\r');
  const started = await waitFor('first output', () => subject.lines().length > 1);
  assert.ok(started, 'typing a line produces output');

  assert.equal(
    subject.atPrompt(),
    false,
    'no prompt while the reply is still arriving -- the prompt is the only readiness signal',
  );

  assert.ok(await waitFor('prompt returns', () => subject.atPrompt()), 'the prompt comes back when it is idle');
});

test('a line typed into a silence is answered, not dropped', async (t) => {
  const subject = openSubject(['--seed', '1', '--speed', '10', '--pick', 'multiline']);
  t.after(() => subject.close());

  assert.ok(await waitFor('first prompt', () => subject.atPrompt()));

  subject.send('one\r');
  assert.ok(await waitFor('first output', () => subject.lines().length > 1));

  // Still busy: type a second line anyway.
  assert.equal(subject.atPrompt(), false, 'still busy when the second line is typed');
  subject.send('two\r');

  assert.ok(await waitFor('both answered', () => subject.atPrompt()), 'the subject drains the queue and prompts once');
  assert.ok(
    subject.lines().some((l) => l.includes('two')),
    'the queued line was echoed rather than discarded',
  );
});

test('menu mode takes the alt screen and gives the shell back', async (t) => {
  const subject = openSubject(['--seed', '3', '--speed', '10', '--pick', 'menu']);
  t.after(() => subject.close());

  assert.ok(await waitFor('first prompt', () => subject.atPrompt()));

  subject.send('go\r');
  assert.ok(await waitFor('menu', () => subject.screen().includes('Select an item')), 'the menu opens');
  assert.equal(subject.buffer(), 'alternate', 'the menu draws on the alt screen');

  // Walk the highlight onto "back" rather than guessing how many items there are.
  const onBack = (): boolean =>
    subject
      .screen()
      .split('\n')
      .some((l) => l.includes('●') && l.includes('back'));
  for (let i = 0; i < 14 && !onBack(); i++) {
    subject.send('\x1b[B');
    await delay(80);
  }
  assert.ok(onBack(), 'the highlight reached "back"');

  subject.send('\r');
  assert.ok(await waitFor('shell returns', () => subject.atPrompt()), 'leaving the menu restores the prompt');
  assert.equal(subject.buffer(), 'normal', 'the shell is back on the normal screen');
});

test('a pattern wait finds the prompt without polling the screen', async (t) => {
  const subject = openSubject(['--seed', '1', '--speed', '10', '--pick', 'multiline']);
  t.after(() => subject.close());

  // What the eye was doing for itself, and what the tool replaces: `$` is the
  // subject's only readiness signal, and it sits on the row the cursor is left
  // on -- never a completed line, so a text-only wait could not see it at all.
  // Nothing below cycles over the screen or reads it back; the wait resolves on
  // the row the subject wrote.
  const first = await subject.session.waitForOutput({ pattern: /^\$$/, timeoutMs: 30_000 });
  assert.equal(first.reason, 'matched', 'the prompt arrives before anything is typed');
  assert.equal(first.match!.surface, 'screen');
  assert.equal(first.match!.text, '$', 'the prompt itself, blank after it trimmed off');

  subject.send('one\r');

  // While the reply is arriving there is no prompt -- only silence and step
  // lines -- so this cannot resolve early. The line just typed is echoed onto
  // the prompt row, which is new content too, and the anchor is what keeps it
  // from being read as the prompt returning.
  const after = await subject.session.waitForOutput({ pattern: /^\$$/, timeoutMs: 30_000 });
  assert.equal(after.reason, 'matched', 'and the prompt comes back when the subject is idle');
  assert.ok(after.match!.atByte > after.sinceByte, 'matching content produced after the line was typed');
  assert.ok(
    after.match!.atByte > first.match!.atByte,
    'and not the prompt that was already on screen when the wait began',
  );
});

test('chat mode answers and quits back to the shell', async (t) => {
  const subject = openSubject(['--seed', '5', '--speed', '10', '--pick', 'chat']);
  t.after(() => subject.close());

  assert.ok(await waitFor('first prompt', () => subject.atPrompt()));

  subject.send('go\r');
  assert.ok(
    await waitFor('chat', () => subject.screen().includes("type 'quit' to exit")),
    'the chat frame opens and says how to leave',
  );
  assert.equal(subject.buffer(), 'alternate', 'the frame draws on the alt screen');

  subject.send('hi\r');
  assert.ok(
    await waitFor('reply', () => subject.screen().includes('Got it - hi.')),
    'every send is answered with Got it - [message].',
  );

  subject.send('quit\r');
  assert.ok(await waitFor('shell returns', () => subject.atPrompt()), 'quit leaves the chat');
  assert.equal(subject.buffer(), 'normal', 'the shell is back on the normal screen');
});
