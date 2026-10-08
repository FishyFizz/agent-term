/**
 * Named keys, and the batch a caller composes out of them.
 *
 * A key is a *name*, not a byte sequence. The caller says `down`; the bytes are
 * this module's problem. That is the whole point: a transport between an agent
 * and this server can silently drop a C0 control character, and a raw `ESC`
 * typed as text is exactly the thing it drops: a driving run sent `\x1b[B`, the
 * escape byte did not survive, and the program received the inert text `[B`.
 * Naming the key removes the byte from the wire.
 *
 * ## Why the encoding depends on a mode
 *
 * The bytes for `up` are `CSI A` -- unless the program has set application
 * cursor keys (`CSI ? 1 h`, DECCKM), and then they are `SS3 A`. This is not a
 * detail: a full-screen program that has set DECCKM and receives `CSI A` sees
 * nothing at all. So the answer is read from the emulator, which parsed the
 * program's own output, rather than hardcoded from whichever program was tried
 * first. The caller passes in what was observed; this module never guesses.
 *
 * Only arrows and Home/End are mode-dependent. For everything else the mode is
 * reported as `null`, because reporting a mode whose value did not affect the
 * bytes would be a fact about a decision that was never made.
 *
 * ## Why a paste is a step of its own
 *
 * A paste is text, but it is not the same as typed text. A program that has
 * enabled bracketed paste (`CSI ? 2004 h`, DECSET 2004) receives the characters
 * wrapped in `CSI 200 ~` ... `CSI 201 ~`, and inserts them literally: a shell
 * with it on puts a multi-line paste into its editing buffer without running a
 * line of it, where the same characters sent as plain text would execute at
 * every newline. So `{paste}` is encoded from the mode the program has set,
 * exactly as `{key}` is -- the caller says *this is a paste*, and the mode, read
 * off the screen, decides whether that is a literal insertion or plain text.
 * With the mode off the two are the same bytes, and the batch says which it was.
 *
 * ## Why this is a leaf module
 *
 * It imports nothing -- no pty, no session, no emulator. `screen.ts` imports
 * `KeyModes` from here (not the other way round), so the mode's owner stays the
 * screen model and this file stays testable as a pure function.
 *
 * ## What a byte code may be, and why the range is small
 *
 * `{ byte: N }` is the escape hatch for anything the table does not name. The
 * faithful range is `0x01`-`0x7f`, and both boundaries were measured rather
 * than assumed: `0x00` sent through ConPTY arrives as nothing at all, and
 * `0x80`-`0xff` arrive as U+FFFD, because ConPTY carries input as UTF-8 text.
 * Bytes `0x01`-`0x7f` arrive exactly. Since every byte this module can produce
 * is in that range, and UTF-8 encodes it as one byte, a JS string is a lossless
 * carrier for a composed batch -- which is why `PtySession.write(string)` needs
 * no widening.
 */

/** The terminal modes a step's bytes depend on. Read from the emulator, never guessed. */
export interface KeyModes {
  /** DECCKM: `CSI ? 1 h`. Arrows and Home/End encode as SS3 when set. */
  readonly applicationCursorKeys: boolean;
  /** DECSET 2004: `CSI ? 2004 h`. A paste is wrapped in the bracketed-paste guards when set. */
  readonly bracketedPaste: boolean;
}

/** One step of a batch: exactly one of `text`, `paste`, `key` or `byte`. */
export interface Step {
  readonly text?: string;
  readonly paste?: string;
  readonly key?: string;
  readonly byte?: number | string;
  /** Preserved by the transport so a typo can be named. Never read. */
  readonly [extra: string]: unknown;
}

/** A step as it resolved, so a caller can see what each one became. */
export interface ComposedStep {
  readonly kind: 'text' | 'paste' | 'key' | 'byte';
  readonly text?: string;
  readonly key?: string;
  readonly byte?: number;
  /** For a paste: whether the bracketed-paste guards were written around it. */
  readonly wrapped?: boolean;
  /** Exactly what this step contributed, escaped. */
  readonly written: string;
}

/**
 * What a batch composed to, as facts.
 *
 * The two modes are reported per batch, each `null` when no step consulted it:
 * `null` rather than `false` for a batch of text or ctrl chords, because no
 * decision depended on it, and reporting `false` would answer a question nobody
 * asked. A mode a step *did* consult is reported with its value, `false`
 * included -- "the program had not asked for this" is the whole answer for a
 * step whose bytes depend on it.
 */
export interface Composed {
  /** The whole batch as one string, for one `pty.write` call. */
  readonly bytes: string;
  readonly steps: readonly ComposedStep[];
  /** DECCKM, consulted by an arrow or Home/End. */
  readonly applicationCursorKeys: boolean | null;
  /** DECSET 2004, consulted by a non-empty paste. */
  readonly bracketedPaste: boolean | null;
}

/** What went wrong with a batch, in a form the caller can act on. */
export class KeyInputError extends Error {
  /** Which step, or `null` when the problem is not step-specific. */
  readonly step: number | null;

  constructor(message: string, step: number | null = null) {
    super(step === null ? message : `step ${step}: ${message}`);
    this.name = 'KeyInputError';
    this.step = step;
  }
}

/** The two introducers a key sequence can start with, written once. */
const CSI = '\x1b[';
const SS3 = '\x1bO';

/** The bracketed-paste guards (DECSET 2004), written once. */
const PASTE_START = `${CSI}200~`;
const PASTE_END = `${CSI}201~`;

interface KeyDef {
  /** Canonical name, as shown in errors and results. */
  readonly name: string;
  readonly bytes: string;
  /** The application-cursor-keys form, for the keys where DECCKM changes it. */
  readonly app?: string;
  readonly aliases?: readonly string[];
  /**
   * A human note for why this entry is what it is, when the reason is not
   * obvious from the name. Shown in no output; it is here for the reader.
   */
  readonly why?: string;
}

/**
 * The table. Name -> bytes, in the order `KEY_SUMMARY` advertises them.
 *
 * Provenance is xterm.js's key evaluator for the navigation and function keys,
 * and the ASCII/C0 assignments for the rest. Where the emulator sends SS3
 * regardless of DECCKM (F1-F4) the entry has no `app` form, because offering a
 * mode-dependent variant that no terminal actually sends would be a fabrication.
 */
const TABLE: readonly KeyDef[] = [
  { name: 'up', bytes: `${CSI}A`, app: `${SS3}A` },
  { name: 'down', bytes: `${CSI}B`, app: `${SS3}B` },
  { name: 'right', bytes: `${CSI}C`, app: `${SS3}C` },
  { name: 'left', bytes: `${CSI}D`, app: `${SS3}D` },
  { name: 'home', bytes: `${CSI}H`, app: `${SS3}H` },
  { name: 'end', bytes: `${CSI}F`, app: `${SS3}F` },
  { name: 'insert', bytes: `${CSI}2~`, aliases: ['ins'] },
  { name: 'delete', bytes: `${CSI}3~`, aliases: ['del'] },
  { name: 'pgup', bytes: `${CSI}5~`, aliases: ['pageup'] },
  { name: 'pgdn', bytes: `${CSI}6~`, aliases: ['pagedown'] },
  // SS3 for F1-F4 is the legacy default and what xterm.js emits regardless of
  // DECCKM; F5-F12 are CSI. The numbering skips 16 and 22 -- no terminal sends
  // them, and filling the gaps would invent sequences nothing understands.
  { name: 'f1', bytes: `${SS3}P` },
  { name: 'f2', bytes: `${SS3}Q` },
  { name: 'f3', bytes: `${SS3}R` },
  { name: 'f4', bytes: `${SS3}S` },
  { name: 'f5', bytes: `${CSI}15~` },
  { name: 'f6', bytes: `${CSI}17~` },
  { name: 'f7', bytes: `${CSI}18~` },
  { name: 'f8', bytes: `${CSI}19~` },
  { name: 'f9', bytes: `${CSI}20~` },
  { name: 'f10', bytes: `${CSI}21~` },
  { name: 'f11', bytes: `${CSI}23~` },
  { name: 'f12', bytes: `${CSI}24~` },
  { name: 'tab', bytes: '\x09' },
  { name: 'shift+tab', bytes: `${CSI}Z`, aliases: ['backtab'] },
  { name: 'enter', bytes: '\x0d', aliases: ['return'] },
  {
    name: 'backspace',
    bytes: '\x7f',
    why: 'DEL, which is what a modern terminal\'s Backspace key sends -- not BS (0x08).',
  },
  { name: 'esc', bytes: '\x1b', aliases: ['escape'] },
  { name: 'space', bytes: '\x20' },
];

const BY_LOOKUP = new Map<string, KeyDef>();
for (const def of TABLE) {
  BY_LOOKUP.set(normalise(def.name), def);
  for (const alias of def.aliases ?? []) BY_LOOKUP.set(normalise(alias), def);
}

/** Canonical names, expanded -- every name a caller can use, minus the chords. */
export const KEY_NAMES: readonly string[] = TABLE.map((def) => def.name);

/**
 * The known set as one line, for an error message.
 *
 * A summary rather than an expansion of `KEY_NAMES`: 57 names in a row is not
 * more actionable than the ranges, and every name here resolves.
 */
export const KEY_SUMMARY =
  'up down left right home end insert delete pgup pgdn f1..f12 tab shift+tab ' +
  'enter backspace esc space ctrl+a..ctrl+z ctrl+\\ ctrl+] ctrl+^ ctrl+_ alt+<char>';

/** Lowercase, and drop everything that is not a letter or a digit. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Split `ctrl+shift+a` into its modifier and its key, or `null` if there is no `+`. */
function chord(name: string): { modifier: string; key: string } | null {
  const match = /^([a-z]+)\s*[+\-]\s*(.+)$/i.exec(name.trim());
  if (!match) return null;
  const modifier = normalise(match[1] ?? '');
  const key = (match[2] ?? '').trim();
  if (key === '') return null;
  return { modifier, key };
}

/** The byte a `ctrl+` chord denotes, or `null` when the key has no C0 assignment. */
function controlByte(key: string): number | null {
  // `ctrl+space` is the usual spelling of the same chord as `ctrl+@`.
  if (/^space$/i.test(key.trim())) return 0x00;
  const chars = [...key];
  if (chars.length !== 1) return null;
  const code = chars[0]?.codePointAt(0) ?? 0;
  // Ctrl+letter is the control character of the same ordinal; the punctuation
  // chords are the remaining C0 holes, all of which are reachable by name.
  if (code >= 0x41 && code <= 0x5a) return code - 0x40; // A-Z -> 0x01-0x1a
  if (code >= 0x61 && code <= 0x7a) return code - 0x60; // a-z -> 0x01-0x1a
  switch (key) {
    case '@':
    case ' ':
      return 0x00;
    case '[':
      return 0x1b;
    case '\\':
      return 0x1c;
    case ']':
      return 0x1d;
    case '^':
      return 0x1e;
    case '_':
      return 0x1f;
    case '?':
      return 0x7f;
    default:
      return null;
  }
}

/** True when `name` resolves to some key. */
export function isKey(name: string): boolean {
  return resolve(name) !== null;
}

interface Resolved {
  readonly canonical: string;
  readonly bytes: string;
  /** The application-cursor-keys form, or `null` when the mode does not apply. */
  readonly app: string | null;
}

function resolve(name: string): Resolved | null {
  const plain = BY_LOOKUP.get(normalise(name));
  if (plain) {
    return { canonical: plain.name, bytes: plain.bytes, app: plain.app ?? null };
  }

  // `ArrowDown` is how many sources spell the key, and it is not the same word
  // as `down`. Stripping the prefix is a spelling rule, not a second table.
  const unarrowed = normalise(name).replace(/^arrow/, '');
  if (unarrowed !== '') {
    const def = BY_LOOKUP.get(unarrowed);
    if (def) return { canonical: def.name, bytes: def.bytes, app: def.app ?? null };
  }

  const parts = chord(name);
  if (!parts) return null;
  const { modifier } = parts;

  if (modifier === 'ctrl' || modifier === 'control') {
    const byte = controlByte(parts.key);
    if (byte === null) {
      throw new KeyInputError(
        `${JSON.stringify(name)} is not a ctrl chord this carries; ctrl+<letter> and ` +
          'ctrl+\\ ctrl+] ctrl+^ ctrl+_ ctrl+[ ctrl+? are',
      );
    }
    if (byte === 0x00) {
      // 0x00 is a real control character and a real chord, but it does not
      // reach the program -- see the module header. Refusing it is the honest
      // outcome; sending it would look like it worked.
      throw new KeyInputError(
        `${JSON.stringify(name)} is 0x00, which does not survive ConPTY (measured: it is ` +
          'dropped). The faithful range is 0x01-0x7f.',
      );
    }
    return { canonical: `ctrl+${parts.key.toLowerCase()}`, bytes: String.fromCharCode(byte), app: null };
  }

  if (modifier === 'alt' || modifier === 'meta') {
    const chars = [...parts.key];
    const code = chars.length === 1 ? chars[0]?.codePointAt(0) ?? 0 : 0;
    if (chars.length !== 1 || code < 0x21 || code > 0x7e) {
      throw new KeyInputError(
        `${JSON.stringify(name)} is not an alt chord this carries; alt+<char> takes one ` +
          'printable ASCII character, sent as ESC followed by that character',
      );
    }
    return { canonical: `alt+${parts.key}`, bytes: `\x1b${parts.key}`, app: null };
  }

  if (modifier === 'shift') {
    // Only one shift chord exists in the table. Anything else is a request for
    // a modified key this surface does not carry, and saying so is better than
    // silently sending the unmodified key.
    if (normalise(parts.key) === 'tab') {
      return { canonical: 'shift+tab', bytes: `${CSI}Z`, app: null };
    }
    throw new KeyInputError(
      `${JSON.stringify(name)} is not a shift chord this carries; shift+tab is the only one`,
    );
  }

  return null;
}

/** Everything the caller could have meant, cheapest guess first. */
function suggest(name: string): string | null {
  const wanted = normalise(name);
  if (wanted === '') return null;

  let best: { name: string; distance: number } | null = null;
  for (const candidate of KEY_NAMES) {
    const distance = editDistance(wanted, normalise(candidate));
    if (distance <= 2 && (best === null || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  if (best) return best.name;

  const prefix = KEY_NAMES.find((candidate) => normalise(candidate).startsWith(wanted));
  return prefix ?? null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

const STEP_FIELDS = ['text', 'paste', 'key', 'byte'] as const;

/** How a step is spelled, said once so the two refusals below cannot drift apart. */
const STEP_SHAPE = 'a step is {text}, {paste}, {key} or {byte}';

/** The field names a step carries that this does not know about. */
function unknownFields(step: Step): string[] {
  return Object.keys(step).filter((k) => !(STEP_FIELDS as readonly string[]).includes(k));
}

/** Which of `text`/`paste`/`key`/`byte` are present. */
function presentFields(step: Step): string[] {
  return STEP_FIELDS.filter((field) => step[field] !== undefined);
}

/**
 * A byte code, from a number or from hex spelled as a string.
 *
 * The bounds are where they are because of measurement, not taste, so a refusal
 * says which measurement it is honouring.
 */
function parseByte(value: number | string, index: number): number {
  let n: number;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new KeyInputError(`byte ${value} is not a whole number`, index);
    }
    n = value;
  } else {
    const match = /^\s*(?:0x)?([0-9a-f]{1,2})\s*$/i.exec(value);
    if (!match) {
      throw new KeyInputError(
        `byte ${JSON.stringify(value)} is not a byte; write a number 0-127, or hex as ` +
          '"1b" or "0x1b"',
        index,
      );
    }
    n = Number.parseInt(match[1] ?? '', 16);
  }

  if (n === 0x00) {
    throw new KeyInputError(
      'byte 0 does not survive ConPTY (measured: it is dropped). The faithful range is ' +
        '0x01-0x7f.',
      index,
    );
  }
  if (n < 0x00 || n > 0x7f) {
    throw new KeyInputError(
      `byte ${n} is outside 0x01-0x7f. ConPTY carries input as UTF-8 text, so a byte above ` +
        '0x7f arrives as U+FFFD (measured). Send the character itself as {text}, or stay ' +
        'within the range.',
      index,
    );
  }
  return n;
}

/** Render bytes so a human can compare them with what they meant to send. */
export function escapeBytes(bytes: string): string {
  let out = '';
  for (const char of bytes) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += char;
  }
  return out;
}

/**
 * Compose a batch into the single string to write, and report what each step
 * became.
 *
 * One composed string means one `pty.write` call, which means one input
 * watermark (`PtySession`) and the best chance the program sees an ESC-prefixed
 * sequence whole rather than a bare ESC followed by the rest.
 *
 * Nothing here waits. A batch is a sequence of writes at one instant, not a
 * script with reactions -- a batch that waited between steps would be the
 * scripted-recipes non-goal wearing a different hat, and reactions belong in the
 * caller's loop.
 */
export function composeSteps(steps: readonly Step[], modes: KeyModes): Composed {
  if (steps.length === 0) {
    throw new KeyInputError(
      'the batch is empty, so nothing would be written. A batch needs at least one step.',
    );
  }

  const composed: ComposedStep[] = [];
  let bytes = '';
  let applicationCursorKeys: boolean | null = null;
  let bracketedPaste: boolean | null = null;

  steps.forEach((step, index) => {
    const present = presentFields(step);
    if (present.length === 0) {
      const unknown = unknownFields(step);
      const named = unknown.length > 0 ? ` (unknown field ${JSON.stringify(unknown[0])})` : '';
      throw new KeyInputError(`${STEP_SHAPE}; found none${named}`, index);
    }
    if (present.length > 1) {
      throw new KeyInputError(`${STEP_SHAPE}; found ${present.join(' and ')}`, index);
    }

    const field = present[0];
    if (field === 'text') {
      const text = step.text ?? '';
      bytes += text;
      composed.push({ kind: 'text', text, written: escapeBytes(text) });
      return;
    }

    if (field === 'paste') {
      const content = step.paste ?? '';
      if (content === '') {
        // What a terminal sends for an empty selection is nothing, not an empty
        // pair of guards: wrapping would be a paste of no bytes that still moved
        // the input watermark, and no decision depended on the mode.
        composed.push({ kind: 'paste', wrapped: false, written: '' });
        return;
      }
      if (content.includes(PASTE_END)) {
        throw new KeyInputError(
          'a paste cannot contain the bracketed-paste terminator (ESC [ 201 ~): the program ' +
            'would take it as the end of the paste and read the rest as keystrokes. Send ' +
            'the text as {text}, or paste it in pieces around the terminator.',
          index,
        );
      }
      const wrapped = modes.bracketedPaste;
      bracketedPaste = wrapped;
      const sent = wrapped ? `${PASTE_START}${content}${PASTE_END}` : content;
      bytes += sent;
      composed.push({ kind: 'paste', wrapped, written: escapeBytes(sent) });
      return;
    }

    if (field === 'key') {
      const name = step.key ?? '';
      const resolved = resolve(name);
      if (!resolved) {
        const guess = suggest(name);
        throw new KeyInputError(
          `unknown key ${JSON.stringify(name)}${guess === null ? '' : ` (did you mean ${JSON.stringify(guess)}?)`}` +
            ` -- known keys: ${KEY_SUMMARY}`,
          index,
        );
      }
      if (resolved.app !== null) applicationCursorKeys = modes.applicationCursorKeys;
      const sent = resolved.app !== null && modes.applicationCursorKeys ? resolved.app : resolved.bytes;
      bytes += sent;
      composed.push({ kind: 'key', key: resolved.canonical, written: escapeBytes(sent) });
      return;
    }

    const n = parseByte(step.byte as number | string, index);
    const sent = String.fromCharCode(n);
    bytes += sent;
    composed.push({ kind: 'byte', byte: n, written: escapeBytes(sent) });
  });

  if (bytes === '') {
    // Not only tidiness: an empty write still stamps the pty's input watermark,
    // which is the default baseline for every later `wait_for_output`. A batch
    // that moves that while writing nothing would silently change what the next
    // wait considers new.
    throw new KeyInputError('the batch composes to no bytes, so nothing would be written.');
  }

  return { bytes, steps: composed, applicationCursorKeys, bracketedPaste };
}
