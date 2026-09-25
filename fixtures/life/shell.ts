/**
 * The three shell-shaped actions: one reply, a reply spread over several lines,
 * and nothing at all.
 *
 * The input line is deliberately ignored -- the subject is testing whether the
 * driver waits, not whether it can read. What it must get right is that the
 * prompt only comes back when the program is idle; between lines there is
 * silence and nothing else.
 */

import { CRLF, type LifeCtx } from './ctx.js';
import type { Rng } from './rng.js';

export type ShellActionKind = 'reply' | 'multiline' | 'silent' | 'menu' | 'chat';

export function nextAction(rng: Rng): ShellActionKind {
  return rng.weighted<ShellActionKind>([
    ['reply', 34],
    ['multiline', 24],
    ['silent', 10],
    ['menu', 16],
    ['chat', 16],
  ]);
}

export function isShellAction(value: string): value is ShellActionKind {
  return value === 'reply' || value === 'multiline' || value === 'silent' || value === 'menu' || value === 'chat';
}

const SHORT_REPLIES: readonly string[] = [
  'ok',
  'done',
  'no changes',
  'already up to date',
  '1 file changed',
  'nothing to do',
  'exit 0',
  'cached',
  '0 errors, 0 warnings',
  'locked',
];

const STEPS: readonly string[] = [
  'reading index',
  'resolving 14 objects',
  'fetching pack',
  'unpacking 14 objects',
  'linking ./dist/app.js',
  'writing 3 targets',
  'checking integrity',
  'pruning stale entries',
  'compiling shim',
  'verifying checksums',
  'cleaning temp',
  'done',
];

export async function runShellAction(kind: 'reply' | 'multiline' | 'silent', ctx: LifeCtx): Promise<void> {
  const { rng, pacer } = ctx;

  if (kind === 'silent') {
    await pacer.pause();
    return;
  }

  if (kind === 'reply') {
    await pacer.pause();
    const count = rng.int(1, 3);
    for (let i = 0; i < count; i++) {
      ctx.out.write((rng.pick(SHORT_REPLIES) ?? 'ok') + CRLF);
    }
    return;
  }

  await pacer.pause();
  const count = rng.int(3, 6);
  for (let i = 0; i < count; i++) {
    ctx.out.write((rng.pick(STEPS) ?? 'working') + CRLF);
    if (i < count - 1) await pacer.pause();
  }
}
