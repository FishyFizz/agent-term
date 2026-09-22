/**
 * L1.3 — the read watermark is a *byte* count.
 *
 * The defect this guards: `node-pty` defaults to `encoding: 'utf8'`, which
 * decodes output to a string before handing it over. Taking `.length` of that
 * string counts UTF-16 code units, so any non-ASCII output is undercounted,
 * and every byte offset the classifier stamps (CLASSIFIER.md §3.1) and every
 * watermark the agent compares (L1.3) drifts.
 *
 * Runs a real program so the bytes come from a real pty, not a fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PtySession } from '../src/pty.js';

const isWindows = process.platform === 'win32';
const command = isWindows ? 'powershell.exe' : '/bin/sh';
const args = isWindows ? ['-NoLogo', '-NoProfile'] : [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the shell is genuinely ready to accept a command.
 *
 * Deliberately not `'>'`/`'$'`: PowerShell emits `\x1b[?9001h\x1b[?1004h`
 * during startup, so a `>` match fires immediately against the escape
 * sequence, before any prompt exists. A command written that early is
 * swallowed by startup and never runs. `PS ` appears only in a real prompt.
 */
async function waitForPrompt(session: PtySession): Promise<void> {
  const chunks: Buffer[] = [];
  const onData = (c: Buffer) => chunks.push(c);
  session.on('data', onData);
  const needle = isWindows ? 'PS ' : '$';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (Buffer.concat(chunks).toString('utf8').includes(needle)) break;
    await delay(25);
  }
  session.off('data', onData);
}

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return false;
}

/**
 * Echoes a multi-byte marker, then reports the byte length the *program*
 * computed for it.
 *
 * The marker is rebuilt from raw UTF-8 bytes inside the shell rather than
 * written as a literal: PowerShell 5.1 mangles non-ASCII characters arriving
 * on the command line, so a literal marker reaches the shell corrupted and
 * the two sides disagree for a reason unrelated to byte counting.
 */
function probe(marker: string): string {
  const octets = [...Buffer.from(marker, 'utf8')];
  if (isWindows) {
    const list = octets.join(',');
    return `$m = [Text.Encoding]::UTF8.GetString([byte[]](${list})); $b = [Text.Encoding]::UTF8.GetBytes($m); Write-Output "M:$m|B:$($b.Length)"`;
  }
  const hex = octets.map((b) => b.toString(16).padStart(2, '0')).join('\\x');
  return `m=$(printf '\\x${hex}'); printf 'M:%s|B:%s\\n' "$m" "$(printf '%s' "$m" | wc -c)"`;
}

test('bytesRead counts bytes, not characters', async (t) => {
  const session = new PtySession(randomUUID(), { command, args, cols: 200, rows: 24 });
  t.after(() => session.dispose());

  const chunks: Buffer[] = [];
  session.on('data', (c) => chunks.push(c));
  const seen = () => Buffer.concat(chunks).toString('utf8');

  await waitForPrompt(session);

  // 你好🔥 is 4 UTF-16 units but 10 UTF-8 bytes.
  const marker = '你好🔥';
  const expectedBytes = Buffer.byteLength(marker, 'utf8');
  assert.equal(expectedBytes, 10, 'marker is 10 bytes / 4 UTF-16 units');

  chunks.length = 0;
  const before = session.bytesRead;
  session.write(`${probe(marker)}\r\n`);

  // Match the marker, not a bare "|B:". The shell also echoes the command
  // being typed (with ANSI colour codes interleaved), where "$m" is literal
  // and no digits follow, so a loose needle matches the echo instead.
  const got = await until(() => seen().includes(`M:${marker}|B:`));
  assert.ok(got, `probe output seen; cmd=${JSON.stringify(probe(marker))}`);

  const reported = Number(new RegExp(`M:${marker}\\|B:(\\d+)`).exec(seen())?.[1] ?? -1);
  assert.equal(reported, expectedBytes, 'program agrees on the byte count');

  // The invariant: the watermark advances by exactly the bytes delivered.
  const arrived = Buffer.concat(chunks);
  assert.equal(session.bytesRead, before + arrived.length, 'watermark advances by exact bytes');

  // And bytes differ from characters for multi-byte output -- the whole point.
  const asText = arrived.toString('utf8');
  assert.notEqual(
    session.bytesRead - before,
    asText.length,
    'a byte count must differ from a character count here',
  );
});

test('data events deliver Buffers, monotonically ordered', async (t) => {
  const session = new PtySession(randomUUID(), { command, args });
  t.after(() => session.dispose());

  const chunks: Buffer[] = [];
  session.on('data', (c) => chunks.push(c));

  await waitForPrompt(session);

  session.write('echo ALPHA\r\n');
  await until(() => Buffer.concat(chunks).toString('utf8').includes('ALPHA'));
  session.write('echo BETA\r\n');
  await until(() => Buffer.concat(chunks).toString('utf8').includes('BETA'));

  assert.ok(chunks.length > 0, 'received data');
  for (const c of chunks) assert.ok(Buffer.isBuffer(c), 'every chunk is a Buffer');
  assert.equal(
    session.bytesRead,
    chunks.reduce((n, c) => n + c.length, 0),
    'watermark is the sum of delivered byte lengths',
  );
});
