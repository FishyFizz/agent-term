/**
 * Basic patterns — one terminal behaviour each, nothing mixed.
 *
 * These are the primitives the classifier's structural tests (CLASSIFIER.md
 * §3.3) are written against. If a basic case is misclassified, no composite
 * case can be trusted.
 */
import type { Programme } from '../src/types.js';
import { BURST_PAUSE_MS, FRAME_PAUSE_MS, INTERACTION_PAUSE_MS } from '../src/types.js';

const CRLF = '\r\n';

/** Append-only text with no control ops at all. The definition of writing. */
export const plainWrite: Programme = {
  id: 'basic.plain-write',
  category: 'basic',
  summary: 'Appends lines with no control operations — pure writing.',
  rows: 8,
  async run(io) {
    io.mark('start');
    for (let i = 1; i <= 5; i++) {
      io.out.write(`line ${i}${CRLF}`);
      await io.wait(BURST_PAUSE_MS);
    }
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'writing',
        why: 'text + linefeed only; cursor advances monotonically; nothing erased',
      },
    ];
  },
};

/** More lines than the screen holds: writing under scroll. */
export const scrollWrite: Programme = {
  id: 'basic.scroll-write',
  category: 'basic',
  summary: 'Appends more lines than the screen holds — writing that scrolls.',
  rows: 5,
  async run(io) {
    io.mark('start');
    for (let i = 1; i <= 20; i++) {
      io.out.write(`build step ${i}: compiling module_${i}.cpp${CRLF}`);
      await io.wait(BURST_PAUSE_MS);
    }
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'writing',
        why: 'every row changes, but only because of scroll; normalized against the scroll event it is N new lines at the bottom (CLASSIFIER.md §3.3)',
      },
    ];
  },
};

/** Cursor reposition + erase + rewrite in place. The definition of drawing. */
export const inPlaceRepaint: Programme = {
  id: 'basic.in-place-repaint',
  category: 'basic',
  summary: 'Repositions the cursor, erases a row, and rewrites it — drawing.',
  rows: 6,
  async run(io) {
    io.mark('start');
    io.out.write(`alpha${CRLF}beta${CRLF}gamma${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('repaint');
    io.out.write('\x1b[2;1H'); // CUP to row 2
    io.out.write('\x1b[2K'); // erase the line
    io.out.write(`BETA-REWRITTEN${CRLF}`);
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['repaint'] ?? 0,
        kind: 'writing',
        why: 'three plain lines appended',
      },
      {
        from: m['repaint'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'CUP + EL reaches back above the cursor and erases non-blank cells',
      },
    ];
  },
};

/** Carriage return + overwrite — a redraw with no cursor-up and no EL. */
export const crOverwrite: Programme = {
  id: 'basic.cr-overwrite',
  category: 'basic',
  summary: 'Rewrites the current row with \\r and no erase — drawing by overwrite.',
  rows: 6,
  async run(io) {
    io.mark('start');
    io.out.write(`progress: 0%${CRLF}`);
    await io.wait(FRAME_PAUSE_MS);
    io.mark('overwrite');
    io.out.write('\rprogress: 50%');
    await io.wait(FRAME_PAUSE_MS);
    io.out.write('\rprogress: 100%');
    io.mark('end');
  },
  expectations(m) {
    return [
      { from: m['start'] ?? 0, to: m['overwrite'] ?? 0, kind: 'writing', why: 'one plain line: "progress: 0%" plus its newline' },
      {
        from: m['overwrite'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: '\\r returns to column 0 and text lands on cells that were already non-blank; no erase op is emitted, so this must be caught by the screen model (CLASSIFIER.md §9 open item 2)',
      },
    ];
  },
};

/**
 * Writes sequentially *on the alternate screen*.
 *
 * The counterexample that killed "alt screen ⇒ drawing" (CLASSIFIER.md §3.4).
 * Must classify as writing despite `buffer.active.type === 'alternate'`.
 */
export const altScreenWrite: Programme = {
  id: 'basic.alt-screen-write',
  category: 'basic',
  summary: 'Appends sequential text on the alternate screen — writing, not drawing.',
  rows: 5,
  async run(io) {
    io.mark('start');
    io.out.write('\x1b[?1049h'); // enter alt screen
    io.out.write('\x1b[H'); // home
    io.mark('append');
    for (let i = 1; i <= 4; i++) {
      io.out.write(`alt line ${i}${CRLF}`);
      await io.wait(BURST_PAUSE_MS);
    }
    io.mark('end');
    io.out.write('\x1b[?1049l'); // leave alt screen — content is destroyed
  },
  expectations(m) {
    return [
      {
        from: m['append'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'writing',
        why: 'pure sequential append; indistinguishable from `cat`. Alt screen is a prior and a capture-urgency flag, never a verdict (CLASSIFIER.md §3.4)',
      },
    ];
  },
};

/** A spinner: repeated repaint of one cell region. Drawing, collapses to latest. */
export const spinner: Programme = {
  id: 'basic.spinner',
  category: 'basic',
  summary: 'Spins one character in place — continuous drawing that must collapse.',
  rows: 4,
  async run(io) {
    io.out.write(`working${CRLF}`);
    io.mark('spin');
    const frames = ['|', '/', '-', '\\'];
    for (let i = 0; i < 12; i++) {
      io.out.write(`\r${frames[i % frames.length]} working...`);
      await io.wait(FRAME_PAUSE_MS);
    }
    io.mark('end');
    io.out.write(`${CRLF}done${CRLF}`);
  },
  expectations(m) {
    return [
      {
        from: m['spin'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'same row rewritten 12 times; intermediate frames carry no information, so this collapses to the latest (CLASSIFIER.md §6)',
      },
    ];
  },
};

/** Full-screen clear then redraw — a structural event, not a repaint verdict. */
export const clearRedraw: Programme = {
  id: 'basic.clear-redraw',
  category: 'basic',
  summary: 'Clears the screen and redraws — ED is a structural event, not a repaint verdict.',
  rows: 6,
  async run(io) {
    io.mark('start');
    io.out.write(`one${CRLF}two${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('clear');
    io.out.write('\x1b[2J\x1b[H'); // ED + home
    io.out.write(`redrawn A${CRLF}redrawn B${CRLF}`);
    io.mark('end');
  },
  expectations(m) {
    return [
      { from: m['start'] ?? 0, to: m['clear'] ?? 0, kind: 'writing', why: 'two plain lines appended, no control ops involved' },
      {
        from: m['clear'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'ED erases the whole display; the frame is a repaint of the surface',
      },
    ];
  },
};

export const basicProgrammes: Programme[] = [
  plainWrite,
  scrollWrite,
  inPlaceRepaint,
  crOverwrite,
  altScreenWrite,
  spinner,
  clearRedraw,
];
