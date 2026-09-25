/**
 * Matching a pattern against what a session produced.
 *
 * The two sinks a session keeps are not interchangeable, and a matcher that
 * pretended otherwise would be wrong on one of them. The screen is a *state*:
 * what is on it now, with the row the cursor is still writing -- which is where
 * a prompt lives, and a prompt is never a completed line (`text-log.ts`: "a
 * prompt the cursor is sitting on is not a completed line"). The text log is a
 * *stream*: lines that completed, in order, including the ones that scrolled
 * out of the viewport and are therefore no longer on any screen.
 *
 * So a pattern is offered both, and a hit says which one it came from.
 *
 * Rows are matched with trailing blanks removed, because a row is exactly the
 * columns the emulator holds (`screen.ts`) and the blanks past the last glyph
 * carry no information. The text log already trims (`translateToString(true)`),
 * so trimming here makes an anchored pattern mean the same thing on either
 * surface -- which is what lets `^\$ $` mean "a bare prompt" rather than
 * "a prompt followed by anything".
 */
import type { TextLine } from './text-log.js';

/** Where a pattern may be matched. */
export type MatchSurface = 'screen' | 'text' | 'both';

/** One place a pattern was seen. */
export interface OutputMatch {
  /** Which sink matched: a row on the screen, or a completed line. */
  surface: 'screen' | 'text';
  /** The text that was matched, after trimming. */
  text: string;
  /**
   * The byte watermark that produced it.
   *
   * For a row, the end of the delivery that wrote it; for a line, the byte the
   * line completed at (delivery-coarse, like `TextLine.byte`). Both are facts
   * about when the content arrived, not about when the match was noticed.
   */
  atByte: number;
  /** The screen row, for a screen match. `null` for a text match. */
  row: number | null;
  /** Which buffer it was on. Context, not a verdict (CLASSIFIER.md §3.4). */
  buffer: 'normal' | 'alternate';
}

/** Strip the blanks a row is padded with, leaving what the program drew. */
export function trimRow(text: string): string {
  return text.replace(/[ \t]+$/, '');
}

/**
 * Test a pattern, from the start of the text every time.
 *
 * A pattern carrying `g` or `y` remembers where its last match ended, so the
 * same text would match on one call and not the next. A matcher whose answer
 * depends on how many times it has been asked is not a measurement, so the
 * state is cleared before each test rather than left to the caller's flags.
 */
function matches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** Match a pattern against one screen row. */
export function matchRow(
  pattern: RegExp,
  row: number,
  text: string,
  atByte: number,
  buffer: 'normal' | 'alternate',
): OutputMatch | null {
  const trimmed = trimRow(text);
  return matches(pattern, trimmed)
    ? { surface: 'screen', text: trimmed, atByte, row, buffer }
    : null;
}

/** Match a pattern against one completed line. */
export function matchLine(pattern: RegExp, line: TextLine): OutputMatch | null {
  const text = trimRow(line.text);
  return matches(pattern, text)
    ? { surface: 'text', text, atByte: line.byte, row: null, buffer: line.buffer }
    : null;
}
