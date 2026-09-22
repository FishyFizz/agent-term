/**
 * End-to-end check of the pty substrate against a real shell.
 *
 * Deliberately not a unit test: L0.5 claims the terminal is honest, and the
 * only way to check that is to run a real program in it. Asserts against
 * observable behaviour, never against a sleep.
 *
 * Run with: npx tsx scripts/smoke.ts
 */
import { SessionRegistry } from '../src/registry.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL';
  if (!ok) failures++;
  console.log(`[${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
}

/** Wait until `predicate` holds, or give up. Never a bare sleep as the check. */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8000, label = 'condition' } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  console.log(`       (timed out waiting for ${label})`);
  return false;
}

async function main(): Promise<void> {
  const registry = new SessionRegistry();

  const isWindows = process.platform === 'win32';
  // No `-Command -` on Windows: PowerShell 5.1 rejects it and exits immediately.
  const command = isWindows ? 'powershell.exe' : '/bin/sh';
  const args = isWindows ? ['-NoLogo', '-NoProfile'] : [];
  const marker = 'AGENTTERM-SMOKE-OK';

  const session = registry.create({ command, args, cols: 80, rows: 24 });
  check('session created', session.alive, `pid=${session.pid} id=${session.id.slice(0, 8)}`);
  check('size defaults applied', session.cols === 80 && session.rows === 24);

  const chunks: Buffer[] = [];
  session.on('data', (c) => chunks.push(c));
  const seen = () => Buffer.concat(chunks).toString('utf8');

  // Wait for the shell to actually be ready rather than assuming a delay.
  const promptSeen = await waitFor(
    () => seen().includes('>') || seen().includes('$'),
    { label: 'shell prompt' },
  );
  check('shell produced a prompt', promptSeen);

  // L1.3: the watermark is a byte count, and it must be a real byte count --
  // a decoded string would undercount non-ASCII output.
  const watermarkAfterPrompt = session.bytesRead;
  check('watermark counts bytes, not characters',
    watermarkAfterPrompt === Buffer.concat(chunks).length,
    `bytesRead=${watermarkAfterPrompt} concat=${Buffer.concat(chunks).length}`);
  check('data events deliver Buffers', chunks.length > 0 && Buffer.isBuffer(chunks[0]));

  // L0.5: a real program runs and its output comes back.
  chunks.length = 0;
  session.write(`echo ${marker}\r\n`);
  const echoed = await waitFor(() => seen().includes(marker), {
    label: `echo of ${marker}`,
  });
  check('program output returns through the pty', echoed);
  check('watermark advanced after output', session.bytesRead > watermarkAfterPrompt,
    `${watermarkAfterPrompt} -> ${session.bytesRead}`);

  // Resize is reported to the program, not just tracked locally.
  let resizeError: unknown = null;
  try {
    session.resize(120, 40);
  } catch (err) {
    resizeError = err;
  }
  check('resize accepted', resizeError === null, resizeError ? String(resizeError) : '120x40');
  check('resize reflected in session state', session.cols === 120 && session.rows === 40);

  let threw = false;
  try {
    session.resize(0, 10);
  } catch {
    threw = true;
  }
  check('invalid resize rejected', threw);

  // Isatty honesty: a program that asks must be told yes.
  //
  // The probe echoes a marker whose value is only correct if the child really
  // has a console. Matching on the marker alone would pass on echoed input
  // text -- PowerShell echoes what you type -- so the check requires the value,
  // and it must not appear before the probe was sent.
  chunks.length = 0;
  const ttyProbe = isWindows
    ? '$r = [Console]::IsOutputRedirected; Write-Output "TTYIS:$r"'
    : 'if [ -t 1 ]; then echo TTYIS:True; else echo TTYIS:False; fi';
  session.write(`${ttyProbe}\r\n`);
  const ttyAnswer = await waitFor(() => seen().includes('TTYIS:'), {
    label: 'tty probe result',
  });
  const ttyText = seen();
  const ttyValue = /TTYIS:(\w+)/.exec(ttyText)?.[1];
  check('tty probe answered', ttyAnswer, `raw=${JSON.stringify(ttyText.slice(0, 60))}`);
  check('program is NOT output-redirected (real tty)', ttyValue === 'False', `TTYIS:${ttyValue}`);

  // Exit reporting.
  let exitInfo: { exitCode: number | null; signal: number | null } | null = null;
  session.on('exit', (info) => {
    exitInfo = info;
  });

  session.write(isWindows ? 'exit\r\n' : 'exit\n');
  const exited = await waitFor(() => exitInfo !== null, { label: 'exit event', timeoutMs: 10000 });
  check('exit event fired', exited, exitInfo ? JSON.stringify(exitInfo) : '');
  check('alive flips false on exit', !session.alive);

  // Write after exit must not throw -- sessions are read-only-but-safe once gone.
  let writeAfterExitThrew = false;
  try {
    session.write('anything');
  } catch {
    writeAfterExitThrew = true;
  }
  check('write after exit is a no-op, not a throw', !writeAfterExitThrew);

  // Registry accounting.
  check('registry tracked the session', registry.size() === 1);
  check('registry remove returns true', registry.remove(session.id));
  check('registry remove is idempotent', registry.remove(session.id) === false);
  check('registry empty after removal', registry.size() === 0);

  // Two sessions at once must not interfere: L0.4 independence.
  const a = registry.create({ command, args });
  const b = registry.create({ command, args });
  const aChunks: Buffer[] = [];
  const bChunks: Buffer[] = [];
  a.on('data', (c) => aChunks.push(c));
  b.on('data', (c) => bChunks.push(c));
  const aSeen = () => Buffer.concat(aChunks).toString('utf8');
  const bSeen = () => Buffer.concat(bChunks).toString('utf8');

  await waitFor(() => aSeen().includes('>') || aSeen().includes('$'), {
    label: 'session a prompt',
  });
  aChunks.length = 0;
  bChunks.length = 0;
  a.write('echo ONLY-A\r\n');
  const aGot = await waitFor(() => aSeen().includes('ONLY-A'), { label: 'ONLY-A' });
  await delay(300);
  check('session a received its own output', aGot);
  check('session b did not receive it', !bSeen().includes('ONLY-A'));
  check('distinct ids', a.id !== b.id);

  // End the shell explicitly before disposing. `dispose()` alone only
  // releases listeners, and `kill()` on Windows forks a ConPTY helper that
  // can outlive us and hold the stdio pipe open -- the process then never
  // exits even though every check passed.
  a.kill();
  b.kill();
  registry.disposeAll();
  check('disposeAll empties registry', registry.size() === 0);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  // Flush, then leave. Orphaned node-pty children can keep the event loop
  // alive indefinitely on Windows; the result is already known.
  process.stdout.write('', () => process.exit(failures === 0 ? 0 : 1));
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 2000).unref();
}

main().catch((err) => {
  console.error('smoke aborted:', err);
  process.exit(1);
});
