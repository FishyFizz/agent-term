/**
 * A screen, rendered as ANSI for a terminal that is not the one it came from.
 *
 * This is the **terminal client's** half of the viewer: it takes the
 * `ScreenSnapshot` the server sent and produces the bytes that draw it. It is
 * the one place in the viewer that emits escape sequences, and what it emits is
 * *output*, never anything it read -- it does not parse, and there is nothing
 * here for a second parser to disagree with. The snapshot is already the
 * authority; this only paints it.
 *
 * The client using this runs inside whatever terminal the human already has
 * open -- Windows Terminal, iTerm, an ssh window -- so it draws by positioning
 * the cursor and writing cells rather than by clearing and hoping.
 *
 * ## What a cell's appearance becomes
 *
 * `ScreenSnapshot.styles` carries **canonical style keys** (`screen.ts`), one
 * string per run: `fg#rrggbb`, `fg7`, `bg#001122`, `bold`, `italic`, and so
 * on. Parsing them back into SGR is the inverse of the function that built
 * them, and it lives here so that function stays a one-way street.
 *
 * ## The one thing it cannot render
 *
 * `ScreenSnapshot` does not say whether the program wanted its cursor shown, so
 * the client always shows one at `cursorX`/`cursorY`. A human watching wants to
 * know where the cursor is; a program that hid it is the rarer case, and
 * inventing a field in the model to carry it would put a viewer's need into
 * L0.
 */
import { styleAt, type ScreenSnapshot } from './screen.js';
import type { KeyModes } from './keys.js';

/** The SGR sequence for one canonical style key, or `null` for the default. */
export function sgr(style: string): string | null {
  if (style === '') return null;
  const params: number[] = [];
  for (const part of style.split(' ')) {
    const parsed = sgrPart(part);
    if (parsed) params.push(...parsed);
  }
  return params.length === 0 ? null : `\x1b[${params.join(';')}m`;
}

/** One appearance attribute, as the SGR parameters that produce it. */
function sgrPart(part: string): number[] | null {
  if (part.startsWith('fg#')) return [38, 2, ...rgb(part.slice(3))];
  if (part.startsWith('bg#')) return [48, 2, ...rgb(part.slice(3))];
  if (part.startsWith('fg')) return [38, 5, palette(part.slice(2))];
  if (part.startsWith('bg')) return [48, 5, palette(part.slice(2))];
  switch (part) {
    case 'bold': return [1];
    case 'dim': return [2];
    case 'italic': return [3];
    case 'underline': return [4];
    case 'blink': return [5];
    case 'inverse': return [7];
    case 'invisible': return [8];
    case 'strike': return [9];
    case 'overline': return [53];
    default: return null;
  }
}

function rgb(hex: string): number[] {
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function palette(index: string): number {
  return Number.parseInt(index, 10);
}

/**
 * One row, as the bytes that draw it.
 *
 * Glyph space and column space are walked together, because they are two views
 * of the same cells and a wide glyph is one character occupying two columns --
 * writing the glyphs without tracking columns would put every run after a CJK
 * character one column to the left.
 */
function renderRow(snapshot: ScreenSnapshot, y: number): string {
  const line = snapshot.lines[y] ?? '';
  const wide = new Set(snapshot.wide[y] ?? []);
  let out = '';
  let column = 0;
  let applied = '';

  for (let glyph = 0; glyph < line.length && column < snapshot.cols; glyph++) {
    const style = styleAt(snapshot, y, column);
    if (style !== applied) {
      // Default is a reset rather than nothing: a run of default cells after a
      // coloured one has to stop the colour, and `0` is what does that.
      out += style === '' ? '\x1b[0m' : (sgr(style) ?? '');
      applied = style;
    }
    out += line[glyph]!;
    column += wide.has(column) ? 2 : 1;
  }
  if (applied !== '') out += '\x1b[0m';
  return out;
}

/**
 * The bytes that draw `snapshot` over whatever the client's terminal is
 * showing, and leave its cursor where the program's is.
 *
 * Full repaint, deliberately: a diff would have to know what the terminal is
 * currently showing, and a second copy of "what is on the screen" is exactly
 * the kind of state this project refuses to keep in two places. A frame is a
 * few kilobytes and the client is on the same machine.
 *
 * The cursor is hidden while painting and shown at the end, so the human never
 * sees it sweep down the grid. The last row is written **without** a trailing
 * newline: the grid fills the client's window, so a newline at the bottom row
 * would scroll the whole screen up one line and undo the paint.
 */
export function renderScreen(snapshot: ScreenSnapshot): string {
  const parts: string[] = ['\x1b[?25l', '\x1b[H'];
  for (let y = 0; y < snapshot.rows; y++) {
    parts.push(renderRow(snapshot, y));
    if (y < snapshot.rows - 1) parts.push('\r\n');
  }
  const cx = Math.min(Math.max(snapshot.cursorX, 0), snapshot.cols - 1);
  const cy = Math.min(Math.max(snapshot.cursorY, 0), snapshot.rows - 1);
  parts.push(`\x1b[${cy + 1};${cx + 1}H`, '\x1b[?25h');
  return parts.join('');
}

/**
 * The bytes that bring the client's own terminal to the modes the *program*
 * set, so that what the human's keyboard produces is what the program expects.
 *
 * This is the whole reason raw forwarding is safe. An arrow key is `CSI A` or
 * `SS3 A` depending on application cursor keys, and a paste is wrapped or not
 * depending on bracketed paste -- both decided by the session, not by the
 * terminal the human happens to be sitting at. Without this, a human driving a
 * full-screen program would send arrows the program does not recognise, and
 * the viewer would look broken in a way that is really a mode mismatch.
 */
export function mirrorModes(modes: KeyModes): string {
  return (
    (modes.applicationCursorKeys ? '\x1b[?1h' : '\x1b[?1l') +
    (modes.bracketedPaste ? '\x1b[?2004h' : '\x1b[?2004l')
  );
}
