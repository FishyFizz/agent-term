/**
 * The terminal client: a session, in the terminal you are already using.
 *
 *   npx tsx scripts/view.ts http://127.0.0.1:53142/v/<token>/
 *
 * It is the half of the viewer that is a real terminal window. It does not
 * launch one -- it *is* one: whatever the human has open, Windows Terminal or
 * iTerm or an ssh window, this runs inside it and paints the session's screen
 * over it. That is the point of it. A viewer that spawned a window would be
 * guessing at which terminal emulator is installed; one that runs in the
 * terminal the human is already sitting at cannot guess wrong.
 *
 * ## It paints, it does not parse
 *
 * The server sends `ScreenSnapshot` and nothing else, and `renderScreen` turns
 * that into the bytes that draw it. There is no VT parser here -- as everywhere
 * in this project, a second parser would be a second opinion about what is on
 * the screen, free to disagree with the one that owns the answer.
 *
 * ## Raw forwarding, and why it is safe
 *
 * Keystrokes are forwarded **verbatim** rather than decoded into key names and
 * recomposed. Decoding an escape sequence back into "the user pressed Down" is
 * guesswork, and the bytes are exactly what the keyboard sent.
 *
 * What makes that correct is mode mirroring: the session's terminal modes ride
 * along with every screen, and this emits them to the human's own terminal. So
 * when the program turns on application cursor keys, the human's terminal does
 * too, and the arrow it produces is the arrow the program asked for. Without
 * it, driving a full-screen program from here would send arrows the program
 * ignores -- which looks like a broken viewer and is really a mode mismatch.
 *
 * ## Detaching
 *
 * **Ctrl-]** leaves without touching the session. Every other key, Ctrl-C
 * included, belongs to the program: this is a window onto someone else's
 * terminal, and swallowing their Ctrl-C would be the viewer deciding what the
 * session means.
 */
import { renderScreen, mirrorModes } from '../src/view-ansi.js';
import type { ScreenSnapshot } from '../src/screen.js';
import type { KeyModes } from '../src/keys.js';

const ARG = process.argv[2];

if (!ARG || ARG === '--help' || ARG === '-h') {
  process.stderr.write(
    'usage: npx tsx scripts/view.ts <url>\n' +
      '\n' +
      'Attaches to a session\'s view and paints it in this terminal.\n' +
      'The url is what `open_view` returned. Ctrl-] detaches.\n',
  );
  process.exit(ARG ? 0 : 1);
}

/** The socket behind a view url: same host, `/ws` on the end. */
function socketUrl(arg: string): string {
  const url = new URL(arg);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/ws';
  return url.toString();
}

/** The bytes that end this client and give the terminal back. */
const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
/** Ctrl-]: the telnet/ssh escape, and not a key a program is likely to want. */
const DETACH = 0x1d;

const stdin = process.stdin as unknown as {
  setRawMode?: (mode: boolean) => void;
  isTTY?: boolean;
  resume(): void;
  pause(): void;
  on(event: string, listener: (chunk: Buffer) => void): unknown;
  off(event: string, listener: (chunk: Buffer) => void): unknown;
};
const stdout = process.stdout;

let raw = false;
let live = false;

function restore(): void {
  if (raw) {
    raw = false;
    stdin.setRawMode?.(false);
    stdin.pause();
  }
  if (live) {
    live = false;
    stdout.write(LEAVE_ALT + '\x1b[?25h');
  }
}

let modes: KeyModes | null = null;
let cols = stdout.columns ?? 0;
let rows = stdout.rows ?? 0;

const socket = new WebSocket(socketUrl(ARG));

function sendSize(): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (!cols || !rows) return;
  socket.send(JSON.stringify({ kind: 'size', cols, rows }));
}

function paint(screen: ScreenSnapshot, next: KeyModes): void {
  // The session's modes, mirrored into this terminal, before anything is
  // typed: see the header.
  if (!modes || modes.applicationCursorKeys !== next.applicationCursorKeys || modes.bracketedPaste !== next.bracketedPaste) {
    stdout.write(mirrorModes(next));
    modes = next;
  }
  stdout.write(renderScreen(screen));
}

socket.onopen = () => {
  // Taken over, and handed back on exit, so the human's own scrollback is
  // exactly as it was.
  stdout.write(ENTER_ALT);
  live = true;
  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
    raw = true;
  }
  stdin.resume();
  sendSize();
};

socket.onmessage = (event: MessageEvent) => {
  let message: { type?: string; screen?: ScreenSnapshot; modes?: KeyModes; message?: string };
  try {
    message = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (message.type === 'hello' || message.type === 'screen') {
    if (message.screen && message.modes) paint(message.screen, message.modes);
  } else if (message.type === 'closed') {
    socket.close();
  } else if (message.type === 'error') {
    // Painted over the grid rather than in the scrollback: the human is
    // looking at the screen, not at their shell.
    stdout.write('\x1b[2;1H\x1b[K\x1b[7m ' + (message.message ?? 'that input was refused') + ' \x1b[0m');
  }
};

stdin.on('data', (chunk: Buffer) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  for (const byte of chunk) {
    if (byte === DETACH) {
      restore();
      process.stderr.write('detached\n');
      socket.close();
      process.exitCode = 0;
      return;
    }
  }
  socket.send(JSON.stringify({ kind: 'raw', data: chunk.toString('base64') }));
});

stdout.on('resize', () => {
  cols = stdout.columns ?? cols;
  rows = stdout.rows ?? rows;
  sendSize();
});

const done = (why: string): void => {
  restore();
  process.stderr.write(`${why}\n`);
};
socket.onclose = () => {
  restore();
  process.stderr.write('the view closed\n');
  process.exit(process.exitCode ?? 0);
};
socket.onerror = () => done('could not reach the view');

process.on('SIGINT', () => {
  restore();
  process.exit(130);
});
process.on('exit', restore);
