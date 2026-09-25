/**
 * Drive the lifelike subject through AgentTerm and print what comes back.
 *
 * Not a unit test: this is the harness you point at the subject to watch how it
 * behaves, and the thing to run before concluding anything about whether an
 * agent can drive it. Output is printed as the screen, because the screen is
 * what a driver actually sees.
 *
 * Run with: npx tsx scripts/life.ts [--seed 7] [--pick menu|chat|multiline] [--speed 4]
 */
import { SessionHost } from '../src/host.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
  const seed = flag('seed') ?? '1';
  const speed = flag('speed') ?? '4';
  const pick = flag('pick');

  const args = ['--import', 'tsx', 'fixtures/life/index.ts', '--seed', seed, '--speed', speed];
  if (pick !== undefined) args.push('--pick', pick);

  const host = new SessionHost();
  const { session } = host.open({ command: process.execPath, args, cols: 80, rows: 24 });

  const transcript: string[] = [];
  const kinds = { writing: 0, drawing: 0 };
  session.onUpdate((update) => {
    for (const entry of update.text) transcript.push(entry.text);
    for (const segment of update.segments) {
      if (segment.kind === 'writing') kinds.writing++;
      else if (segment.kind === 'drawing') kinds.drawing++;
    }
  });

  const screenText = (): string =>
    session.screen
      .snapshot()
      .lines.map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n+$/, '');

  const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(50);
    }
    console.log(`  (timed out waiting for ${label})`);
    return false;
  };

  const send = (text: string): void => {
    session.pty.write(text);
  };

  /** Clack marks the highlighted entry with a filled radio. */
  const selectedIsBack = (): boolean =>
    screenText()
      .split('\n')
      .some((l) => l.includes('●') && l.includes('back'));

  /** The prompt is the subject saying it is ready: a line that ends in `$`. */
  const atPrompt = (): boolean =>
    screenText()
      .split('\n')
      .some((l) => l.trimEnd().endsWith('$'));

  console.log(`subject: seed=${seed} speed=${speed} pick=${pick ?? '(random)'}`);

  await waitFor('banner', () => screenText().includes('lifelike shell'));
  await waitFor('first prompt', atPrompt);
  console.log('\n--- ready ---\n' + screenText());

  if (pick === 'menu') {
    send('go\r');
    await waitFor('menu', () => screenText().includes('Select an item'), 20_000);
    console.log('\n--- menu ---\n' + screenText());

    send('\x1b[B');
    await delay(200);
    send('\r');
    await delay(1_500);
    console.log('\n--- window ---\n' + screenText());

    // Answer whatever the window asked, then walk the highlight to "back".
    send('\r');
    await delay(1_500);
    for (let i = 0; i < 14 && !selectedIsBack(); i++) {
      send('\x1b[B');
      await delay(120);
    }
    send('\r');
    await delay(1_000);
    console.log('\n--- back at the shell ---\n' + screenText());
  } else if (pick === 'chat') {
    send('go\r');
    await waitFor('chat', () => screenText().includes("type 'quit' to exit"), 20_000);
    console.log('\n--- chat ---\n' + screenText());

    send('hello there\r');
    await delay(2_500);
    console.log('\n--- one exchange ---\n' + screenText());

    send('quit\r');
    await delay(800);
    console.log('\n--- back at the shell ---\n' + screenText());
  } else {
    send('one\r');
    await session.waitForIdle({ idleMs: 400, timeoutMs: 30_000 });
    send('two\r');
    await session.waitForIdle({ idleMs: 400, timeoutMs: 30_000 });
    console.log('\n--- after two lines ---\n' + screenText());
  }

  console.log(
    `\n--- classified: ${kinds.writing} writing segment(s), ${kinds.drawing} drawing segment(s) ---`,
  );
  console.log('\n--- transcript ---\n' + transcript.join('\n'));

  send('exit\r');
  await delay(400);
  session.dispose();
  host.disposeAll();
}

void main();
