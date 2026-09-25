/**
 * The lifelike subject: launch it and it behaves like a shell -- a line in, a
 * chunk of output -- except that what it does next is chosen at random,
 * sometimes slowly, and sometimes it hands you a menu or a chat frame instead
 * of a reply.
 *
 * The input line is ignored on purpose. What is being tested is whether the
 * driver waits for the prompt, not whether it can compose a command.
 */

import { runChat } from './chat.js';
import { ALT_SCREEN_OFF, CRLF, PROMPT, type LifeCtx, type Size } from './ctx.js';
import { StdinRouter } from './input.js';
import { runMenu } from './menu.js';
import { createRng, Pacer, randomSeed } from './rng.js';
import { isShellAction, nextAction, runShellAction, type ShellActionKind } from './shell.js';

const HELP = `lifelike - an interactive subject for driving a terminal

  tsx fixtures/life/index.ts [options]

Options
  --seed <n>    Replay one exact run: same actions, same gaps.
  --pick <kind> Force every action to one of: reply, multiline, silent, menu, chat.
  --speed <n>   Divide every delay by n. Useful in tests.
  --help        This text.

While the subject is working there is no prompt. The prompt is the only signal
that it is ready for the next line.
`;

interface Args {
  seed: number | undefined;
  pick: ShellActionKind | undefined;
  speed: number;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { seed: undefined, pick: undefined, speed: 1, help: false };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--seed':
        args.seed = Number(value) >>> 0;
        i++;
        break;
      case '--speed': {
        const speed = Number(value);
        args.speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
        i++;
        break;
      }
      case '--pick':
        if (value !== undefined && isShellAction(value)) args.pick = value;
        i++;
        break;
      default:
        break;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = process.stdout;

  if (args.help) {
    out.write(HELP);
    return;
  }

  const seed = args.seed ?? randomSeed();
  const rng = createRng(seed);
  const pacer = new Pacer(rng, args.speed);
  const router = new StdinRouter(process.stdin);
  const size: Size = { cols: out.columns || 80, rows: out.rows || 24 };

  const ctx: LifeCtx = { out, stdin: process.stdin, router, rng, pacer, size };

  out.on('resize', () => {
    size.cols = out.columns || size.cols;
    size.rows = out.rows || size.rows;
  });

  let done = false;
  const finish = (code: number): void => {
    if (done) return;
    done = true;
    router.setRawMode(false);
    router.stop();
    out.write(ALT_SCREEN_OFF + CRLF + 'bye' + CRLF);
    process.exit(code);
  };

  // On a pipe, EOF lands while a reply is still pending. Exiting there would
  // swallow it, so let the pump drain first.
  const onEof = (): void => {
    if (busy) exitWhenIdle = true;
    else finish(0);
  };

  const queue: string[] = [];
  let busy = false;
  let exitWhenIdle = false;

  const act = async (input: string): Promise<void> => {
    const kind = args.pick ?? nextAction(rng);
    pacer.begin();

    if (kind === 'menu') {
      out.write('opening configuration...' + CRLF);
      await pacer.wait(rng.range(200, 800));
      await runMenu(ctx);
      return;
    }

    if (kind === 'chat') {
      out.write('opening chat...' + CRLF);
      await pacer.wait(rng.range(200, 800));
      await runChat(ctx);
      return;
    }

    await runShellAction(kind, ctx);
  };

  // One pump at a time. Everything typed while the subject is busy lands in
  // the queue and runs after, in order -- and the prompt is printed once, when
  // the queue has drained.
  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        if (next === 'exit' || next === 'quit') {
          finish(0);
          return;
        }
        if (next === '') {
          out.write(PROMPT);
          continue;
        }
        await act(next);
      }

      // EOF arrived mid-action: finish the reply, then go.
      if (exitWhenIdle) {
        finish(0);
        return;
      }

      out.write(PROMPT);
    } finally {
      busy = false;
    }
  };

  const bits = [`lifelike shell`, `seed ${seed}`];
  if (args.pick !== undefined) bits.push(`pick ${args.pick}`);
  if (args.speed !== 1) bits.push(`speed ${args.speed}`);
  bits.push(`'exit' or Ctrl-D to quit`);
  out.write(bits.join(' · ') + CRLF);
  out.write(PROMPT);

  router.start(
    (text) => {
      queue.push(text);
      void pump();
    },
    onEof,
  );

  process.stdin.on('end', onEof);
  process.on('SIGINT', () => {
    finish(130);
  });
}

void main();
