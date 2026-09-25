/**
 * The matcher, on its own.
 *
 * A pattern wait is only as good as what it is handed: the two sinks a session
 * keeps hold different things, and a row is padded to the width of the
 * terminal. These check the trimming and the anchoring that make an agent's
 * `^...$` mean "this whole line" on either surface -- which is what tells a
 * prompt apart from the echo of a command typed at it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLine, matchRow, trimRow } from '../src/match.js';
import type { TextLine } from '../src/text-log.js';

const line = (text: string, byte = 0, buffer: 'normal' | 'alternate' = 'normal'): TextLine => ({
  byte,
  buffer,
  text,
});

test('trimRow removes the padding a row is drawn with, and nothing else', () => {
  assert.equal(trimRow('READY> '), 'READY>');
  assert.equal(trimRow('READY>        '), 'READY>');
  assert.equal(trimRow('  indented  '), '  indented');
  assert.equal(trimRow(''), '');
  assert.equal(trimRow('   '), '');
});

test('a row is matched against its trimmed text, which is what makes anchoring work', () => {
  const hit = matchRow(/^READY>$/, 3, 'READY>            ', 42, 'normal');
  assert.ok(hit, 'the padded row matched the anchored pattern');
  assert.equal(hit!.surface, 'screen');
  assert.equal(hit!.text, 'READY>', 'and the hit reports what was matched, not the padding');
  assert.equal(hit!.row, 3);
  assert.equal(hit!.atByte, 42);
  assert.equal(hit!.buffer, 'normal');
});

test('an anchored prompt pattern does not match the echo of a command typed at it', () => {
  // The case that decides whether this tool is usable: the tty echoes what was
  // typed, so the prompt row becomes `$ hello there` the moment a command is
  // sent. A bare `$ ` is still in there as a substring -- unanchored, the wait
  // would resolve before the program had done anything.
  assert.equal(matchRow(/\$ $/, 0, '$ hello there', 1, 'normal'), null, 'anchored: no match');
  assert.ok(matchRow(/\$ /, 0, '$ hello there', 1, 'normal'), 'unanchored: matches, as documented');

  // The prompt is printed as `$ `, with a trailing space, and trimming takes
  // that space with the padding after it -- so the bare prompt is a row whose
  // whole content is `$`. `^\$ $` would find nothing, which is why the tool
  // says trailing blanks are removed rather than leaving a caller to discover
  // it. `^\$$` is the pattern that means "a bare prompt".
  const prompt = matchRow(/^\$$/, 0, '$      ', 7, 'normal');
  assert.ok(prompt, 'the bare prompt matches on its content');
  assert.equal(prompt!.text, '$');
  assert.equal(matchRow(/^\$ $/, 0, '$      ', 7, 'normal'), null, 'the untrimmed form does not');
});

test('a completed line is matched as text, carrying the byte it completed at', () => {
  const hit = matchLine(/BUILD SUCCESSFUL/, line('BUILD SUCCESSFUL  ', 1234));
  assert.ok(hit);
  assert.equal(hit!.surface, 'text');
  assert.equal(hit!.row, null, 'a line has no row: it may have scrolled off');
  assert.equal(hit!.atByte, 1234);
  assert.equal(hit!.text, 'BUILD SUCCESSFUL');

  assert.equal(matchLine(/BUILD SUCCESSFUL/, line('unit tests failed', 9)), null);
});

test('a line keeps the buffer it was written on, as context and not as a verdict', () => {
  const hit = matchLine(/hello/, line('hello', 1, 'alternate'));
  assert.equal(hit!.buffer, 'alternate');
});

test('a global pattern does not remember where its last match ended', () => {
  // `test` on a `/g` pattern advances `lastIndex`, so the same row would match
  // on one call and not the next. A measurement that depends on how many times
  // it has been asked is not a measurement.
  const pattern = /READY/g;
  assert.ok(matchRow(pattern, 0, 'READY>', 1, 'normal'));
  assert.ok(matchRow(pattern, 0, 'READY>', 2, 'normal'), 'the second call matches too');
  assert.ok(matchRow(pattern, 0, 'READY>', 3, 'normal'), 'and so does the third');
});
