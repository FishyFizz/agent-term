/**
 * A view of a session, driven end to end: a real shell, a real pty, and the
 * screen it produces handed to a subscriber.
 *
 * The point of these is not the drawing -- there is no drawing here -- but the
 * two claims a viewer makes: that what it hands out is the session's screen,
 * and that what a human sent reached the session. Both are observable, so both
 * are asserted against a real program rather than a fake.
 *
 * The renderer is the one part tested without a session, because it is a pure
 * function of a snapshot and a shell has nothing to add to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSession } from '../src/session.js';
import { FakeClock } from '../src/groups.js';
import { SessionView, type ViewEvent } from '../src/view.js';
import { renderScreen, sgr, mirrorModes } from '../src/view-ansi.js';
import type { ScreenSnapshot } from '../src/screen.js';
import type { ViewPolicy } from '../src/view.js';

const isWindows = process.platform === 'win32';
const command = isWindows ? 'powershell.exe' : '/bin/sh';
const args = isWindows ? ['-NoLogo', '-NoProfile'] : [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * A live session with a view on it.
 *
 * `TerminalSession` builds its own pty, so no registry -- two shells per test
 * and one left alive at teardown otherwise. It waits for the shell's first
 * output before returning, so a command typed at it is its own act rather
 * than a race with startup.
 */
async function harness(policy: ViewPolicy = {}) {
  const session = new TerminalSession('view-test', { command, args, cols: 100, rows: 24 });
  await waitFor(() => session.pty.bytesRead > 0, { label: 'the shell prompt' });
  const view = new SessionView(session, policy);
  return { session, view };
}

/** Whether any screen a subscriber was handed carries `text`. */
function shown(events: ViewEvent[], text: string): boolean {
  return events.some((e) => e.type === 'screen' && e.screen.lines.some((l) => l.includes(text)));
}

test('a view hands a subscriber the screen, and says what a human sent', async (t) => {
  const { session, view } = await harness();
  t.after(() => session.dispose());

  const events: ViewEvent[] = [];
  const detach = view.attach((event) => events.push(event));
  t.after(detach);

  // Before any human input the facts are `null`, not zero: "nobody has typed"
  // and "we cannot say" are different facts.
  assert.deepEqual(view.facts, { attached: 1, lastInputAt: null, lastInputBytes: null });
  assert.equal(events.length, 0, 'attaching is not itself a change');

  // Named, not spelled: `enter` is the byte the key sends, composed against
  // the mode the program set.
  view.send([{ text: 'echo VIEW-HELLO' }, { key: 'enter' }]);
  const got = await waitFor(() => shown(events, 'VIEW-HELLO'), { label: 'the echoed line' });
  assert.ok(got, 'what the human typed reached the session and came back on the screen');

  const facts = view.facts;
  assert.equal(facts.attached, 1, 'the client is still attached');
  assert.ok(facts.lastInputAt !== null, 'the view says when a human typed');
  assert.ok((facts.lastInputBytes ?? 0) > 0, 'and how much');
});

test('a view paces what it hands out, and always ends on the newest screen', async (t) => {
  // A fake clock: the pacing is policy and injected, so a test moves time
  // rather than sleeping through it.
  const clock = new FakeClock();
  const { session, view } = await harness({ clock, maxFps: 10 });
  t.after(() => session.dispose());

  const events: ViewEvent[] = [];
  const detach = view.attach((event) => events.push(event));
  t.after(detach);

  view.send([{ text: 'echo VIEW-PACED' }, { key: 'enter' }]);
  const produced = await waitFor(() => session.seq > 0, { label: 'a delivery' });
  assert.ok(produced, 'the session produced output');

  // Queued, because the interval has not elapsed on the clock the view was
  // given -- which is what makes this deterministic rather than a race.
  assert.equal(events.length, 0, 'nothing goes out before the interval');

  clock.advance(100);
  assert.ok(events.length >= 1, 'the screen goes out once the interval elapses');
  const last = events[events.length - 1]!;
  assert.equal(last.type, 'screen');
  // Ends on the newest: a coalescing window that handed out an older frame
  // would leave the human looking at a screen the session has already left.
  assert.equal((last as { seq: number }).seq, session.seq, 'and it is the state the session is at');
});

test('a view forwards raw bytes, and refuses a write that is not one', async (t) => {
  const { session, view } = await harness();
  t.after(() => session.dispose());

  const events: ViewEvent[] = [];
  const detach = view.attach((event) => events.push(event));
  t.after(detach);

  // An empty write still moves the pty's input watermark, so it would be
  // reported as input that was not input.
  assert.throws(() => view.sendRaw(''), /not empty/);

  view.sendRaw('echo VIEW-RAW\r');
  const got = await waitFor(() => shown(events, 'VIEW-RAW'), { label: 'the raw line' });
  assert.ok(got, 'the bytes a human\'s keyboard produced went straight in');
  assert.ok((view.facts.lastInputBytes ?? 0) > 0);
});

test('a view resizes the session to the window a human has', async (t) => {
  const { session, view } = await harness();
  t.after(() => session.dispose());

  view.resize(120, 30);
  assert.deepEqual(view.size, { cols: 120, rows: 30 }, 'the view reports the grid it is showing');
  // One grid, not two: the emulator has to follow, or the program draws for a
  // width the screen being shown does not have.
  assert.equal(session.screen.cols, 120);
  assert.equal(session.screen.rows, 30);
});

test('a view ends with its session', async (t) => {
  const { session, view } = await harness();

  const events: ViewEvent[] = [];
  view.attach((event) => events.push(event));

  session.dispose();

  assert.ok(view.closed, 'the view is over');
  const last = events[events.length - 1]!;
  assert.equal(last.type, 'ended', 'and the client was told, rather than left waiting');
  // Killed rather than exited, so there is no exit fact to report -- `null`,
  // not a fabricated one.
  assert.equal((last as { exit: unknown }).exit, null);
});

// ---- the renderer, which needs no session -------------------------------

/** A snapshot with only what a test cares about filled in. */
function snapshot(part: Partial<ScreenSnapshot> & { lines: string[] }): ScreenSnapshot {
  return {
    styles: part.lines.map(() => []),
    wide: part.lines.map(() => []),
    cols: Math.max(...part.lines.map((l) => l.length)),
    rows: part.lines.length,
    buffer: 'normal',
    cursorX: 0,
    cursorY: 0,
    hasScrollback: true,
    ...part,
  };
}

test('the renderer paints a screen and leaves the cursor where the program put it', () => {
  const painted = renderScreen(
    snapshot({
      lines: ['hello', 'world'],
      styles: [[{ from: 0, to: 5, style: 'fg#ff0000 bold' }], []],
      cursorX: 2,
      cursorY: 1,
    }),
  );

  assert.ok(painted.startsWith('\x1b[?25l\x1b[H'), 'the cursor is hidden and the paint starts at home');
  assert.ok(painted.includes('\x1b[38;2;255;0;0;1mhello'), 'the run is painted with its appearance');
  assert.ok(painted.includes('\r\n'), 'rows are separated');
  assert.ok(painted.endsWith('\x1b[2;3H\x1b[?25h'), 'and the cursor is left on the row the program is on');
  // A newline after the last row would scroll the whole screen up on a terminal
  // the grid exactly fills, undoing the paint.
  assert.ok(!painted.includes('world\r\n'), 'the last row is not followed by a newline');
});

test('the renderer keeps a wide glyph in its two columns', () => {
  // 'a中b' is four columns: the CJK glyph is one character and two columns.
  const painted = renderScreen(
    snapshot({ lines: ['a中b'], wide: [[1]], cols: 4 }),
  );
  assert.ok(painted.includes('a中b'), 'the row is painted as its glyphs');
});

test('a style key becomes the SGR that produced it', () => {
  assert.equal(sgr(''), null, 'the default appearance is no sequence at all');
  assert.equal(sgr('fg7'), '\x1b[38;5;7m');
  assert.equal(sgr('bg#010203'), '\x1b[48;2;1;2;3m');
  assert.equal(sgr('bold underline'), '\x1b[1;4m');
});

test('the client is told to mirror the modes the program set', () => {
  // Without this the human's arrows are encoded for the terminal they are
  // sitting at rather than for the program reading them.
  assert.equal(
    mirrorModes({ applicationCursorKeys: true, bracketedPaste: false }),
    '\x1b[?1h\x1b[?2004l',
  );
  assert.equal(
    mirrorModes({ applicationCursorKeys: false, bracketedPaste: true }),
    '\x1b[?1l\x1b[?2004h',
  );
});
