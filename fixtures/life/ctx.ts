/**
 * What every mode is handed. Nothing here reads argv or owns a loop -- the
 * entry point builds it once and passes it down.
 */

import type { StdinRouter } from './input.js';
import type { Pacer, Rng } from './rng.js';

export interface Size {
  cols: number;
  rows: number;
}

export interface LifeCtx {
  out: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  router: StdinRouter;
  rng: Rng;
  pacer: Pacer;
  /** Mutable so a resize is visible to whatever is drawing. */
  size: Size;
}

export const ALT_SCREEN_ON = '\x1b[?1049h';
export const ALT_SCREEN_OFF = '\x1b[?1049l';
export const CLEAR = '\x1b[2J';
export const HOME = '\x1b[H';
export const CRLF = '\r\n';

/** The one readiness signal: printed only when the subject is idle. */
export const PROMPT = '$ ';

export function write(ctx: LifeCtx, text: string): void {
  ctx.out.write(text);
}

export function line(ctx: LifeCtx, text: string): void {
  ctx.out.write(text + CRLF);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
