/**
 * Named keys, and the batch composed out of them.
 *
 * The expectation table below is written out by hand rather than derived from
 * `src/keys.ts`, and that is deliberate: a test that reads its expectations
 * from the thing under test checks that the code agrees with itself. These
 * bytes are the ones a terminal actually sends, and the point of the test is
 * that someone wrote them down independently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_NAMES,
  KEY_SUMMARY,
  KeyInputError,
  composeSteps,
  escapeBytes,
  isKey,
  type KeyModes,
  type Step,
} from '../src/keys.js';

const NORMAL: KeyModes = { applicationCursorKeys: false, bracketedPaste: false };
const APPLICATION: KeyModes = { applicationCursorKeys: true, bracketedPaste: false };
/** A program that has enabled bracketed paste: a paste step is wrapped. */
const PASTING: KeyModes = { applicationCursorKeys: false, bracketedPaste: true };

/** Send one step and return the bytes. */
function send(step: Step, modes: KeyModes = NORMAL): string {
  return composeSteps([step], modes).bytes;
}

/** `CSI A` and the other sequences, spelled so the table reads as terminals do. */
const ESC = '\x1b';
const CSI = `${ESC}[`;
const SS3 = `${ESC}O`;

/** Every key, with the bytes it sends in each cursor-key mode. */
const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
  // [name, normal, application-cursor-keys]
  ['up', `${CSI}A`, `${SS3}A`],
  ['down', `${CSI}B`, `${SS3}B`],
  ['right', `${CSI}C`, `${SS3}C`],
  ['left', `${CSI}D`, `${SS3}D`],
  ['home', `${CSI}H`, `${SS3}H`],
  ['end', `${CSI}F`, `${SS3}F`],
  // Mode-independent: DECCKM does not reach these.
  ['insert', `${CSI}2~`, `${CSI}2~`],
  ['delete', `${CSI}3~`, `${CSI}3~`],
  ['pgup', `${CSI}5~`, `${CSI}5~`],
  ['pgdn', `${CSI}6~`, `${CSI}6~`],
  // F1-F4 are SS3 regardless of DECCKM; F5-F12 are CSI. The numbering skips
  // 16 and 22, which no terminal sends.
  ['f1', `${SS3}P`, `${SS3}P`],
  ['f2', `${SS3}Q`, `${SS3}Q`],
  ['f3', `${SS3}R`, `${SS3}R`],
  ['f4', `${SS3}S`, `${SS3}S`],
  ['f5', `${CSI}15~`, `${CSI}15~`],
  ['f6', `${CSI}17~`, `${CSI}17~`],
  ['f7', `${CSI}18~`, `${CSI}18~`],
  ['f8', `${CSI}19~`, `${CSI}19~`],
  ['f9', `${CSI}20~`, `${CSI}20~`],
  ['f10', `${CSI}21~`, `${CSI}21~`],
  ['f11', `${CSI}23~`, `${CSI}23~`],
  ['f12', `${CSI}24~`, `${CSI}24~`],
  ['tab', '\x09', '\x09'],
  ['shift+tab', `${CSI}Z`, `${CSI}Z`],
  ['enter', '\x0d', '\x0d'],
  ['backspace', '\x7f', '\x7f'],
  ['esc', '\x1b', '\x1b'],
  ['space', '\x20', '\x20'],
  // The C0 chords. Ctrl+letter is the control character of the same ordinal.
  ...Array.from({ length: 26 }, (_, i): readonly [string, string, string] => {
    const letter = String.fromCharCode(0x61 + i);
    const byte = String.fromCharCode(0x01 + i);
    return [`ctrl+${letter}`, byte, byte];
  }),
  ['ctrl+\\', '\x1c', '\x1c'],
  ['ctrl+]', '\x1d', '\x1d'],
  ['ctrl+^', '\x1e', '\x1e'],
  ['ctrl+_', '\x1f', '\x1f'],
  ['ctrl+[', '\x1b', '\x1b'],
  ['ctrl+?', '\x7f', '\x7f'],
  ['alt+x', '\x1bx', '\x1bx'],
];

test('every named key sends the bytes a terminal sends', () => {
  for (const [name, normal, application] of EXPECTED) {
    assert.equal(send({ key: name }), normal, `${name} in normal mode`);
    assert.equal(send({ key: name }, APPLICATION), application, `${name} with DECCKM set`);
  }
});

test('the advertised names are all real, and every real name is advertised', () => {
  for (const name of KEY_NAMES) {
    assert.ok(isKey(name), `KEY_NAMES lists ${name}, so it must resolve`);
    // The summary advertises F1-F12 as a range rather than listing twelve
    // names, so a range member is covered by the range.
    assert.ok(
      KEY_SUMMARY.includes(name) || /^f\d+$/.test(name),
      `KEY_SUMMARY omits ${name}`,
    );
  }
  for (const [name] of EXPECTED) {
    if (name.startsWith('ctrl+') || name.startsWith('alt+')) continue;
    assert.ok(KEY_NAMES.includes(name), `${name} works but is not in KEY_NAMES`);
  }
  assert.match(KEY_SUMMARY, /f1\.\.f12/, 'the function keys are advertised as a range');
  assert.equal(isKey('dwn'), false, 'a name that is not a key is not one');
});

test('the byte identities hold, and the one that does not is not aliased', () => {
  // These are byte-identical, so either name is the same keystroke.
  assert.equal(send({ key: 'ctrl+i' }), send({ key: 'tab' }), 'Ctrl+I is Tab, byte for byte');
  assert.equal(send({ key: 'ctrl+m' }), send({ key: 'enter' }), 'Ctrl+M is Enter, byte for byte');
  assert.equal(send({ key: 'ctrl+[' }), send({ key: 'esc' }), 'Ctrl+[ is Escape, byte for byte');
  assert.equal(send({ key: 'ctrl+?' }), send({ key: 'backspace' }), 'Ctrl+? is DEL');

  // ...and this one is the trap: node's readline calls both of these
  // "backspace", but they are different bytes and different keys.
  assert.equal(send({ key: 'ctrl+h' }), '\x08', 'Ctrl+H is BS');
  assert.equal(send({ key: 'backspace' }), '\x7f', 'Backspace is DEL');
  assert.notEqual(send({ key: 'ctrl+h' }), send({ key: 'backspace' }), 'and they are not the same');

  assert.equal(send({ key: 'ctrl+c' }), '\x03', 'Ctrl+C is the interrupt byte');
  assert.equal(send({ key: 'ctrl+j' }), '\x0a', 'Ctrl+J is LF, which is not Enter');
  assert.notEqual(send({ key: 'ctrl+j' }), send({ key: 'enter' }), 'Enter is CR, not LF');
});

test('a key name is read the way a person would write it', () => {
  for (const spelling of ['Arrow-Down', 'arrow_down', 'ARROWDOWN', '  Down  ']) {
    assert.equal(send({ key: spelling }), `${CSI}B`, `${JSON.stringify(spelling)} is Down`);
  }
  assert.equal(send({ key: 'Escape' }), '\x1b', 'a long alias resolves');
  assert.equal(send({ key: 'backtab' }), `${CSI}Z`, 'shift+tab has an alias');
  assert.equal(send({ key: 'PageDown' }), `${CSI}6~`, 'pageup/pgdn spell out');
  assert.equal(send({ key: 'Control-C' }), '\x03', 'the modifier has a long form');
  assert.equal(send({ key: 'ctrl-c' }), '\x03', 'and a hyphen works');
});

test('the mode is reported only when a key actually consulted it', () => {
  const arrows = composeSteps([{ key: 'down' }], APPLICATION);
  assert.equal(arrows.applicationCursorKeys, true, 'an arrow consulted the mode');
  assert.equal(
    composeSteps([{ key: 'down' }], NORMAL).applicationCursorKeys,
    false,
    'and reports the mode it saw, not merely that it looked',
  );

  // Reporting `false` here would answer a question that was never asked: no
  // decision below depended on the mode.
  for (const step of [{ key: 'f5' }, { key: 'ctrl+c' }, { text: 'hi' }, { byte: 27 }] as Step[]) {
    assert.equal(
      composeSteps([step], APPLICATION).applicationCursorKeys,
      null,
      `${JSON.stringify(step)} does not depend on the mode, so it reports no mode`,
    );
  }
});

test('a batch composes to one string, in order, with each step reported', () => {
  const composed = composeSteps(
    [{ text: 'go' }, { key: 'down' }, { key: 'down' }, { key: 'enter' }],
    NORMAL,
  );
  assert.equal(composed.bytes, `go${CSI}B${CSI}B\r`, 'the whole batch is one string');
  assert.deepEqual(
    composed.steps.map((s) => s.written),
    ['go', '\\x1b[B', '\\x1b[B', '\\x0d'],
    'each step reports what it contributed, escaped',
  );
  assert.deepEqual(
    composed.steps.map((s) => s.kind),
    ['text', 'key', 'key', 'key'],
    'and what kind it was',
  );
  assert.deepEqual(
    composed.steps.filter((s) => s.kind === 'key').map((s) => s.key),
    ['down', 'down', 'enter'],
    'keys are reported canonically, so a spelling is visible in the result',
  );
});

test('a byte step sends that byte, from a number or from hex', () => {
  assert.equal(send({ byte: 27 }), '\x1b', 'a number');
  assert.equal(send({ byte: '1b' }), '\x1b', 'hex without a prefix');
  assert.equal(send({ byte: '0x1b' }), '\x1b', 'hex with a prefix');
  assert.equal(send({ byte: '0X1B' }), '\x1b', 'and case does not matter');
  assert.equal(send({ byte: 1 }), '\x01', 'the low boundary survives');
  assert.equal(send({ byte: 127 }), '\x7f', 'and so does the high one');

  const composed = composeSteps([{ byte: 27 }], NORMAL);
  assert.deepEqual(composed.steps, [{ kind: 'byte', byte: 27, written: '\\x1b' }]);
});

test('a byte outside the range ConPTY carries faithfully is refused, and says why', () => {
  // Both boundaries are measured facts, not policy: 0x00 is dropped by ConPTY,
  // and 0x80-0xff arrive as U+FFFD because ConPTY carries input as UTF-8 text.
  assert.throws(
    () => send({ byte: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'typed as a bad input');
      assert.match(error.message, /ConPTY/, 'names the transport that sets the limit');
      assert.match(error.message, /dropped/, 'and what it does to that byte');
      return true;
    },
  );
  assert.throws(
    () => send({ byte: 128 }),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'typed as a bad input');
      assert.match(error.message, /0x7f/, 'names the boundary');
      assert.match(error.message, /\{text\}/, 'and points at the way to send it instead');
      return true;
    },
  );
  assert.throws(() => send({ byte: 255 }), KeyInputError, 'above the range');
  assert.throws(() => send({ byte: -1 }), KeyInputError, 'below the range');
  assert.throws(() => send({ byte: 'zz' }), KeyInputError, 'not a byte at all');
  assert.throws(() => send({ byte: 1.5 }), KeyInputError, 'not a whole byte');
});

test('a paste is wrapped in the bracketed-paste guards when the program enabled them', () => {
  // The programme's half: the guards are `CSI 200 ~` ... `CSI 201 ~`, spelled
  // here as a terminal sends them rather than read back from the module.
  const START = `${CSI}200~`;
  const END = `${CSI}201~`;

  // With the mode off a paste is the characters and nothing else -- which is
  // also what a terminal without bracketed paste sends for a paste.
  assert.equal(send({ paste: 'hello' }), 'hello', 'off: the characters, unwrapped');

  // With it on the characters are a literal insertion, so a multi-line paste
  // does not run at its newlines.
  const multi = 'line one\nline two\n';
  const composed = composeSteps([{ paste: multi }], PASTING);
  assert.equal(composed.bytes, `${START}${multi}${END}`, 'on: wrapped, content untouched');
  assert.deepEqual(
    composed.steps,
    [{ kind: 'paste', wrapped: true, written: `${escapeBytes(START)}${escapeBytes(multi)}${escapeBytes(END)}` }],
    'and the step reports itself as a wrapped paste, escaped like any other write',
  );
});

test('a paste reports the mode it consulted, and a plain text step does not', () => {
  assert.equal(composeSteps([{ paste: 'hi' }], PASTING).bracketedPaste, true, 'wrapped: the mode was on');
  assert.equal(
    composeSteps([{ paste: 'hi' }], NORMAL).bracketedPaste,
    false,
    'unwrapped: the mode was consulted and was off, which is the whole answer',
  );
  // No decision depended on it, so reporting `false` would answer a question
  // that was never asked.
  for (const step of [{ text: 'hi' }, { key: 'down' }, { byte: 27 }] as Step[]) {
    assert.equal(
      composeSteps([step], PASTING).bracketedPaste,
      null,
      `${JSON.stringify(step)} does not depend on bracketed paste, so it reports no mode`,
    );
  }
});

test('a paste may not contain the bracketed-paste terminator', () => {
  // Letting it through would end the paste early and the program would read the
  // rest as keystrokes -- the payload escaping the envelope it was put in.
  assert.throws(
    () => composeSteps([{ text: 'x' }, { paste: `before${CSI}201~after` }], PASTING),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'typed as a bad input');
      assert.equal(error.step, 1, 'and names the step');
      assert.match(error.message, /terminator/, 'says what the text contains');
      assert.match(error.message, /\{text\}/, 'and points at the way to send it instead');
      return true;
    },
  );
  // The guard is the terminator, not the introducer or a bare ESC: text that
  // merely looks like escape syntax is still a legitimate thing to paste.
  assert.equal(
    composeSteps([{ paste: `${CSI}200~not a terminator\x1b[` }], PASTING).bytes,
    `${CSI}200~${CSI}200~not a terminator\x1b[${CSI}201~`,
    'only the exact terminator is refused',
  );
});

test('an empty paste writes nothing, and is not fatal beside real steps', () => {
  // What a terminal sends for an empty selection is nothing at all -- not an
  // empty pair of guards, which would move the input watermark for no bytes.
  assert.equal(composeSteps([{ text: 'a' }, { paste: '' }], PASTING).bytes, 'a', 'contributes nothing');
  assert.throws(() => composeSteps([{ paste: '' }], PASTING), KeyInputError, 'and alone it is an empty batch');
});

test('an unknown key is refused with the step, a suggestion and the known set', () => {
  assert.throws(
    () => composeSteps([{ text: 'x' }, { key: 'dwn' }], NORMAL),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'typed as a bad input');
      assert.equal(error.step, 1, 'names which step');
      assert.match(error.message, /step 1/, 'and says so in the message');
      assert.match(error.message, /did you mean "down"/, 'suggests the likely intent');
      assert.match(error.message, /known keys:/, 'and always offers the known set');
      return true;
    },
  );
  // The known set is the actionable half; the suggestion is a courtesy, so an
  // unrecognisable name still gets the set.
  assert.throws(
    () => send({ key: 'zzzzzzzzz' }),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'still a typed failure');
      assert.match(error.message, /up down left right/, 'the known set is always there');
      assert.doesNotMatch(error.message, /did you mean/, 'with no guess when there is none');
      return true;
    },
  );
});

test('a chord this surface does not carry says what it does carry', () => {
  for (const [name, hint] of [
    ['ctrl+shift+a', /ctrl\+<letter>/],
    ['shift+a', /shift\+tab/],
    ['alt+ab', /alt\+<char>/],
    ['ctrl+1', /ctrl\+<letter>/],
  ] as const) {
    assert.throws(
      () => send({ key: name }),
      (error: unknown) => {
        assert.ok(error instanceof KeyInputError, `${name} is a typed failure`);
        assert.match(error.message, hint, `${name} says what the surface does carry`);
        return true;
      },
    );
  }
});

test('Ctrl+@ is refused rather than sent as a byte that never arrives', () => {
  // 0x00 is a real chord with a real name, and it does not reach the program.
  // Accepting it would look like it worked.
  for (const name of ['ctrl+@', 'ctrl+space']) {
    assert.throws(
      () => send({ key: name }),
      (error: unknown) => {
        assert.ok(error instanceof KeyInputError, `${name} is a typed failure`);
        assert.match(error.message, /0x00/, 'names the byte');
        assert.match(error.message, /dropped/, 'and the measured reason');
        return true;
      },
    );
  }
});

test('a step must be exactly one of text, paste, key or byte', () => {
  assert.throws(
    () => composeSteps([{ key: 'down', byte: 27 }], NORMAL),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'two fields is a typed failure');
      assert.equal(error.step, 0, 'and names the step');
      assert.match(error.message, /found key and byte/, 'and says which two');
      return true;
    },
  );
  assert.throws(
    () => composeSteps([{ text: 'a' }, {}], NORMAL),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'no field is a typed failure');
      assert.equal(error.step, 1, 'and names the step');
      assert.match(error.message, /found none/, 'and says so');
      return true;
    },
  );
});

test('a step with a field this does not know names the field', () => {
  // The transport preserves unknown fields precisely so this can be said --
  // `keys` is the plausible typo, and "found none" alone would not help.
  assert.throws(
    () => composeSteps([{ keys: 'down' } as Step], NORMAL),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'a typed failure');
      assert.match(error.message, /unknown field "keys"/, 'names the field it did not recognise');
      return true;
    },
  );
});

test('a batch that would write nothing is refused', () => {
  // Not only tidiness: `pty.write('')` still stamps the input watermark, which
  // is the default baseline for every later wait_for_output. An empty batch
  // would move what the next wait considers new, while writing nothing.
  assert.throws(
    () => composeSteps([], NORMAL),
    (error: unknown) => {
      assert.ok(error instanceof KeyInputError, 'an empty batch is a typed failure');
      assert.match(error.message, /nothing would be written/, 'and says why it is refused');
      return true;
    },
  );
  assert.throws(() => composeSteps([{ text: '' }], NORMAL), KeyInputError, 'so is empty text');
  // A batch is refused when it composes to nothing, not when any one step is
  // empty: an empty step alongside real ones contributes nothing and is fine.
  assert.equal(composeSteps([{ text: 'a' }, { text: '' }], NORMAL).bytes, 'a', 'an empty step is not fatal');
});

test('escapeBytes renders what a human needs to compare against intent', () => {
  assert.equal(escapeBytes(`${CSI}B`), '\\x1b[B', 'the ESC is visible, the rest is legible');
  assert.equal(escapeBytes('\r\n'), '\\x0d\\x0a', 'a CRLF is two escapes, not a line break');
  assert.equal(escapeBytes('\x7f'), '\\x7f', 'DEL is escaped');
  assert.equal(escapeBytes('\x1bOB'), '\\x1bOB', 'an SS3 arrow');
  assert.equal(escapeBytes('plain text'), 'plain text', 'ordinary text is unchanged');
  assert.equal(escapeBytes('a\\b'), 'a\\\\b', 'a literal backslash cannot be mistaken for an escape');
  assert.equal(escapeBytes('中文'), '中文', 'and a wide character is left alone');
});
