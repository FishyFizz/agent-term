/**
 * The chat-shaped mode: a frame, the transcript above, the input pinned to the
 * bottom row. Every send is answered with "Got it - [message]."
 *
 * This one is hand-rolled rather than built on clack. A chat is a persistent
 * frame redrawn in place, and a prompt library is the wrong shape for that --
 * it renders a linear flow, one question at a time, and cannot hold a layout.
 * The frame is a full repaint of `rows` lines from the home position: cheap at
 * this size, and it keeps every scroll and resize honest.
 */

import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CLEAR,
  HOME,
  type LifeCtx,
  type Size,
} from './ctx.js';

interface Turn {
  who: 'you' | 'bot';
  text: string;
}

const EXIT_WORDS: readonly string[] = ['quit', 'exit', '/quit', '/exit', ':q'];

/** Shown in the frame itself, so the driver can see how to get back. */
const TITLE = ` chat · type 'quit' to exit `;

export async function runChat(ctx: LifeCtx): Promise<void> {
  const { out, stdin, rng, pacer, router } = ctx;

  const turns: Turn[] = [];
  const queued: string[] = [];
  let draft = '';
  let busy = false;

  const render = (): void => {
    const rows = buildFrame(ctx.size, turns, draft);
    out.write(HOME);
    for (let i = 0; i < rows.length; i++) {
      out.write('\x1b[2K');
      out.write(rows[i] ?? '');
      if (i < rows.length - 1) out.write('\r\n');
    }
  };

  const submit = async (message: string): Promise<void> => {
    busy = true;
    turns.push({ who: 'you', text: message });
    render();
    await pacer.wait(rng.range(300, 2_000));
    turns.push({ who: 'bot', text: `Got it - ${message}.` });
    render();
    busy = false;

    const next = queued.shift();
    if (next !== undefined) await submit(next);
  };

  out.write(ALT_SCREEN_ON);
  out.write(CLEAR + HOME);
  router.handOff();
  render();

  // A resize while chatting would otherwise leave a stale frame until the
  // next keypress.
  const onResize = (): void => {
    render();
  };
  out.on('resize', onResize);

  let rawSet = false;
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
    rawSet = true;
  }

  // Assigned by the executor below, which runs synchronously. Held outside the
  // promise so the finally block can remove the listener on every exit path.
  let done: (() => void) | null = null;

  const onData = (data: Buffer): void => {
    for (const ch of data.toString('utf8')) {
      if (ch === '\x03' || ch === '\x04') {
        done?.();
        return;
      }
      if (ch === '\r' || ch === '\n') {
        const message = draft;
        draft = '';
        if (EXIT_WORDS.includes(message.trim().toLowerCase())) {
          done?.();
          return;
        }
        if (message.trim() === '') {
          render();
          continue;
        }
        if (busy) queued.push(message.trim());
        else void submit(message.trim());
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        draft = draft.slice(0, -1);
        render();
        continue;
      }
      if (ch >= ' ') {
        draft += ch;
        render();
      }
    }
  };

  stdin.on('data', onData);

  try {
    await new Promise<void>((resolve) => {
      done = resolve;
    });
  } finally {
    stdin.off('data', onData);
    out.off('resize', onResize);
    if (rawSet && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    out.write(ALT_SCREEN_OFF);
    router.takeBack();
  }
}

function buildFrame(size: Size, turns: Turn[], draft: string): string[] {
  const cols = Math.max(20, size.cols);
  const rows = Math.max(6, size.rows);

  const top = border('┌', '┐', TITLE, cols);
  const sep = border('├', '┤', '', cols);
  const bottom = border('└', '┘', ' type a message, ⏎ to send ', cols);

  // One border, one separator, one input, one border below the body.
  const bodyRows = Math.max(1, rows - 4);

  const body: string[] = [];
  for (const turn of turns) {
    const prefix = turn.who === 'you' ? 'you: ' : 'bot: ';
    for (const piece of wrap(prefix + turn.text, Math.max(4, cols - 4))) body.push(piece);
  }
  const visible = body.slice(-bodyRows);
  while (visible.length < bodyRows) visible.push('');

  const fieldWidth = Math.max(1, cols - 6);
  const shown = draft.length > fieldWidth ? draft.slice(draft.length - fieldWidth) : draft;

  return [
    top,
    ...visible.map((text) => `│ ${pad(text, cols - 4)} │`),
    sep,
    `│ > ${pad(shown, fieldWidth)} │`,
    bottom,
  ];
}

function border(left: string, right: string, title: string, cols: number): string {
  const fill = Math.max(0, cols - 2 - title.length);
  return left + title + '─'.repeat(fill) + right;
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + ' '.repeat(width - text.length);
}

function wrap(text: string, width: number): string[] {
  if (text.length === 0) return [''];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}
