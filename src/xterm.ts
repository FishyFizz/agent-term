/**
 * Loading shim for `@xterm/headless`.
 *
 * v6.0.0 ships CJS only. Its `package.json` declares `"module": "lib/xterm.mjs"`,
 * but that file is not present in the published tarball -- only
 * `lib-headless/xterm-headless.{js,mjs}` exist. The `.mjs` build does export
 * `Terminal` as a named ESM export, but importing it by subpath bypasses the
 * package's own typings, so we get runtime that works and no types.
 *
 * Going through `createRequire` keeps the declared `@xterm/headless` specifier
 * for types (so `import type` resolves normally) while loading the CJS build the
 * package actually ships. Both halves work; neither is a hack that ignores the
 * package's declared surface.
 *
 * Also note: `terminal.buffer` is proposed API and throws unless the instance is
 * constructed with `allowProposedApi: true`.
 */
import { createRequire } from 'node:module';
import type {
  Terminal as XtermTerminal,
  IBufferCell,
  ITerminalOptions,
  ITerminalInitOnlyOptions,
} from '@xterm/headless';

type XtermModule = { Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => XtermTerminal };

const require = createRequire(import.meta.url);
const xterm = require('@xterm/headless') as XtermModule;

export type { XtermTerminal, IBufferCell };

/** Options AgentTerm always requires, regardless of caller intent. */
const BASE_OPTIONS = { allowProposedApi: true } as const;

/**
 * `cols` and `rows` are init-only (`ITerminalInitOnlyOptions`), not part of
 * `ITerminalOptions` -- they can only be set at construction, and afterwards
 * only via `resize()`. Accept both halves of the constructor's real
 * parameter type so callers can size a terminal as they create it.
 */
export type TerminalOptions = ITerminalOptions & ITerminalInitOnlyOptions;

export function createTerminal(options?: TerminalOptions): XtermTerminal {
  return new xterm.Terminal({ ...BASE_OPTIONS, ...options });
}
