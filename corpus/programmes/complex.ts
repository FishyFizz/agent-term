/**
 * Synthesized complex cases.
 *
 * Each combines behaviours in a way that has historically broken a plausible
 * design: journeys that change mode mid-stream, interleaving that defeats
 * spatial reasoning, and pathological volume.
 *
 * These are the regression suite for the failure modes recorded in
 * CLASSIFIER.md §4 and §6.
 */
import type { Programme } from '../src/types.js';
import { BURST_PAUSE_MS, FRAME_PAUSE_MS, INTERACTION_PAUSE_MS } from '../src/types.js';

const CRLF = '\r\n';

/**
 * Success criterion 3: shell output → full-screen TUI → more shell output.
 *
 * The whole journey must be reconstructable in order, with each mode and each
 * screen state. Alt-screen enter/exit are what make this fall out structurally
 * (CLASSIFIER.md §3.4).
 */
export const shellTuiShell: Programme = {
  id: 'complex.shell-tui-shell',
  category: 'complex',
  summary: 'Shell output, then a full-screen TUI on the alt screen, then back to shell output.',
  cols: 60,
  rows: 8,
  async run(io) {
    io.mark('shell1');
    io.out.write(`$ git log --oneline${CRLF}`);
    io.out.write(`a1b2c3d fix parser${CRLF}`);
    io.out.write(`d4e5f6g add tests${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('tuiEnter');
    io.out.write('\x1b[?1049h\x1b[H'); // git opens its pager
    for (let i = 0; i < 6; i++) io.out.write(`commit line ${i}${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('tuiBody');
    // Repaint as if scrolling inside the pager.
    io.out.write('\x1b[H');
    for (let i = 0; i < 6; i++) {
      io.out.write('\x1b[2K');
      io.out.write(`commit line ${i + 6}${CRLF}`);
    }
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('tuiExit');
    io.out.write('\x1b[?1049l'); // quit the pager
    io.mark('shell2');
    io.out.write(`$ echo done${CRLF}done${CRLF}`);
    io.mark('end');
  },
  expectations(m) {
    return [
      { from: m['shell1'] ?? 0, to: m['tuiEnter'] ?? 0, kind: 'writing', why: 'shell output before the TUI' },
      {
        from: m['tuiEnter'] ?? 0,
        to: m['tuiExit'] ?? 0,
        kind: 'drawing',
        why: 'a full-screen TUI on the alt screen; its content is destroyed on exit, so capture while live is mandatory (L0.3)',
      },
      { from: m['shell2'] ?? 0, to: m['end'] ?? 0, kind: 'writing', why: 'shell output resumes after the TUI exits' },
    ];
  },
};

/**
 * The interleaved case: a progress bar *and* a log line in the same update,
 * repeatedly. Mixed is not a verdict — it is two segments in time order.
 */
export const interleaved: Programme = {
  id: 'complex.interleaved',
  category: 'complex',
  summary: 'A log line and a repainted status bar interleaved in the same update, repeatedly.',
  cols: 60,
  rows: 8,
  async run(io) {
    io.mark('start');
    io.out.write(`deploying...${CRLF}`);
    for (let i = 1; i <= 6; i++) {
      // 1. a log line appends (writing)
      io.out.write(`  uploaded shard ${i}/6${CRLF}`);
      await io.wait(BURST_PAUSE_MS);
      // 2. the status row is repainted (drawing) — same update, later segment
      io.out.write('\x1b[s');
      io.out.write(`\x1b[${io.rows};1H\x1b[2K`);
      io.out.write(`status: ${Math.round((i / 6) * 100)}% complete`);
      io.out.write('\x1b[u');
      await io.wait(BURST_PAUSE_MS);
    }
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        // Both, not one. Coalesced to job granularity the burst nets to seven
        // rows of text, which reads as pure writing -- but the status row was
        // repainted six times and only its last state survives. That is the
        // one thing a coalesced job cannot show, and it is what `collapsed`
        // and a replay are for.
        also: 'writing',
        why: 'contains both kinds: appending log lines and repainting the status row. "Mixed" is the structural fact that there are segments of both kinds in one update, not a third verdict (CLASSIFIER.md §2)',
      },
    ];
  },
};

/**
 * Resize while a TUI is running.
 *
 * A resize reflows every row, so it changes the entire screen — but it is a
 * structural event, not a repaint (CLASSIFIER.md §6). Classifying it as a
 * drawing would be a false positive on an enormous scale.
 */
export const resizeDuringTui: Programme = {
  id: 'complex.resize-during-tui',
  category: 'complex',
  summary: 'A TUI running when the terminal is resized — reflow is an event, not a repaint.',
  cols: 40,
  rows: 8,
  async run(io) {
    io.mark('start');
    io.out.write('\x1b[?1049h\x1b[H');
    for (let i = 0; i < 6; i++) io.out.write(`row ${i}${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('preresize');
    // The harness resizes the emulator here; the program then redraws to fit.
    io.out.write('\x1b[H');
    for (let i = 0; i < 6; i++) {
      io.out.write('\x1b[2K');
      io.out.write(`row ${i} (reflowed)${CRLF}`);
    }
    io.mark('end');
    io.out.write('\x1b[?1049l');
  },
  expectations(m) {
    return [
      {
        from: m['preresize'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'the program redraws after the reflow; the resize itself is a structural event and must not be counted as the repaint',
      },
    ];
  },
};

/**
 * Two real resizes across a session: writing, a resize, more writing, a TUI, a
 * second resize, and a repaint.
 *
 * This is the material the history timeline needs and the corpus did not have.
 * `complex.resize-during-tui` is named for a resize that never happened -- its
 * programme says "the harness resizes the emulator here" and no harness ever
 * did, so its trace is a redraw at a constant size. Here the resize is real, in
 * both feeds: `io.resize` emits a request the harness acts on, and records the
 * byte offset it happened at so a replay reflows at the same point.
 *
 * What it exercises: an epoch boundary. History freezes everything produced
 * before a resize and reports it at the size it was produced at, so the three
 * sizes below must each be answerable independently.
 */
export const resizeEpochs: Programme = {
  id: 'complex.resize-epochs',
  category: 'complex',
  summary: 'Writing, a resize, more writing, a TUI, a second resize, then a repaint.',
  cols: 60,
  rows: 8,
  async run(io) {
    io.mark('start');
    for (let i = 0; i < 10; i++) io.out.write(`build step ${i} at ${io.cols} cols${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);

    io.mark('resize1');
    io.resize(30, 6);
    // The pty feed resizes through another process, so give it a moment before
    // drawing at a size it may not have taken yet.
    await io.wait(INTERACTION_PAUSE_MS);

    io.mark('narrow');
    for (let i = 0; i < 8; i++) io.out.write(`narrow step ${i} at ${io.cols} cols${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);

    io.mark('tui');
    io.out.write('\x1b[?1049h\x1b[H');
    for (let i = 0; i < 5; i++) io.out.write(`tui row ${i}${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);

    io.mark('resize2');
    io.resize(48, 10);
    await io.wait(INTERACTION_PAUSE_MS);

    io.mark('repaint');
    io.out.write('\x1b[H');
    for (let i = 0; i < 9; i++) {
      io.out.write('\x1b[2K');
      io.out.write(`redrawn row ${i} at ${io.cols} cols${CRLF}`);
    }
    io.mark('end');
    io.out.write('\x1b[?1049l');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['resize1'] ?? 0,
        kind: 'writing',
        why: 'plain appended lines at the original size, before any boundary',
      },
      {
        from: m['narrow'] ?? 0,
        to: m['tui'] ?? 0,
        kind: 'writing',
        why: 'the same kind of output at a new grid size — the epoch changed, the writing did not',
      },
      {
        from: m['repaint'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'a full-screen repaint after the second resize; the resize itself is a structural event and must not be counted as the repaint',
      },
    ];
  },
};

/**
 * A firehose: far more output than the screen can hold, delivered fast.
 *
 * Exercises bounded delivery without loss (success criterion 5). The text log
 * must still contain the lines that fell out of the grid.
 */
export const firehose: Programme = {
  id: 'complex.firehose',
  category: 'complex',
  summary: 'A firehose of output far exceeding the screen and the scrollback.',
  cols: 60,
  rows: 6,
  async run(io) {
    io.mark('start');
    // Burst with no delay: everything arrives in one coalescing window.
    let bulk = '';
    for (let i = 1; i <= 2000; i++) bulk += `firehose line ${i}${CRLF}`;
    io.out.write(bulk);
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'writing',
        why: '2000 lines in one burst; segmentation must still yield ordered segments because boundaries are stamped with byte offsets, and the text log must keep lines that fell out of the grid (CLASSIFIER.md §5)',
      },
    ];
  },
};

/**
 * A progress bar that scrolls: the canonical disproof of spatial bands.
 *
 * Deliberately reproduced from CLASSIFIER.md §4 so the trace matches the
 * documented one exactly: draw at row 4, append (scrolls the bar to row 3),
 * redraw at row 4.
 */
export const progressBarScroll: Programme = {
  id: 'complex.progress-bar-scroll',
  category: 'complex',
  summary: 'Draw bar, append a line, redraw bar — the trace that disproved spatial bands.',
  cols: 40,
  rows: 5,
  async run(io) {
    io.mark('start');
    const bar = (n: number): string => `[${'#'.repeat(n)}${'-'.repeat(10 - n)}]`;
    io.out.write(`log1${CRLF}log2${CRLF}log3${CRLF}`);
    io.mark('draw1');
    io.out.write(`${bar(5)}${CRLF}`); // bar lands on row 4 (0-indexed 3)
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('append');
    io.out.write(`log5${CRLF}`); // scrolls; the old bar is now one row up
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('redraw');
    io.out.write(`\x1b[${io.rows};1H\x1b[2K${bar(10)}`); // erase + redraw on the last row
    io.mark('end');
  },
  expectations(m) {
    return [
      { from: m['start'] ?? 0, to: m['draw1'] ?? 0, kind: 'writing', why: 'three initial log lines' },
      { from: m['draw1'] ?? 0, to: m['append'] ?? 0, kind: 'writing', why: 'the first bar is a new line' },
      { from: m['append'] ?? 0, to: m['redraw'] ?? 0, kind: 'writing', why: 'log5 appends and scrolls the bar up' },
      {
        from: m['redraw'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'erase + redraw of the bar row. The old bar and the new bar sit at different rows with a log line between them, so no spatial clustering links them — only the op stream does (CLASSIFIER.md §4)',
      },
    ];
  },
};

/**
 * Synchronized output (CSI ? 2026 h): a whole frame is written between the
 * begin/end markers and must be treated as one atomic update.
 */
export const synchronizedOutput: Programme = {
  id: 'complex.synchronized-output',
  category: 'complex',
  summary: 'A repaint wrapped in synchronized-output markers — atomic, one update.',
  cols: 50,
  rows: 8,
  async run(io) {
    io.mark('start');
    io.out.write('\x1b[?1049h');
    const frame = (n: number): void => {
      io.out.write('\x1b[?2026h'); // begin synchronized update
      io.out.write('\x1b[H');
      for (let i = 0; i < 5; i++) {
        io.out.write('\x1b[2K');
        io.out.write(`panel ${i}: ${n * i}${CRLF}`);
      }
      io.out.write('\x1b[?2026l'); // end
    };
    frame(1);
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('frames');
    for (const n of [2, 3]) {
      frame(n);
      await io.wait(INTERACTION_PAUSE_MS);
    }
    io.mark('end');
    io.out.write('\x1b[?1049l');
  },
  expectations(m) {
    return [
      {
        from: m['frames'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'whole-frame repaints; each synchronized block is atomic and must not be split into interleaved partial segments (CLASSIFIER.md §7.4)',
      },
    ];
  },
};

/**
 * Writes on the alt screen and *then* starts drawing, in one session.
 *
 * The alt-screen prior and the structural evidence disagree here; the positive
 * evidence must win (CLASSIFIER.md §3.4: a prior can always be overridden).
 */
export const altWriteThenDraw: Programme = {
  id: 'complex.alt-write-then-draw',
  category: 'complex',
  summary: 'Sequential append on the alt screen, then a repaint on the same screen.',
  cols: 50,
  rows: 6,
  async run(io) {
    io.mark('start');
    io.out.write('\x1b[?1049h\x1b[H');
    io.mark('append');
    for (let i = 1; i <= 3; i++) io.out.write(`boot ${i}${CRLF}`);
    await io.wait(INTERACTION_PAUSE_MS);
    io.mark('repaint');
    // Now start redrawing in place, still on the alt screen.
    for (const v of [1, 2, 3]) {
      io.out.write('\x1b[3;1H\x1b[2K');
      io.out.write(`status: ${v}`);
      await io.wait(10);
    }
    io.mark('end');
    io.out.write('\x1b[?1049l');
  },
  expectations(m) {
    return [
      {
        from: m['append'] ?? 0,
        to: m['repaint'] ?? 0,
        kind: 'writing',
        why: 'sequential append on the alt screen — the §3.4 counterexample; writing despite the alt screen',
      },
      {
        from: m['repaint'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'still on the alt screen, but now erasing and rewriting a row; the alt-screen prior is overridden by positive evidence in the same segment',
      },
    ];
  },
};

/**
 * A TUI that exits uncleanly — leaves the alt screen without restoring.
 *
 * Content on the alt screen is destroyed on exit; this checks the recorder
 * still has the last live frame.
 */
export const uncleanTuiExit: Programme = {
  id: 'complex.unclean-tui-exit',
  category: 'complex',
  summary: 'A TUI killed while on the alt screen — last live frame must be preserved.',
  cols: 50,
  rows: 6,
  async run(io) {
    io.mark('start');
    io.out.write('\x1b[?1049h\x1b[H');
    for (let i = 0; i < 4; i++) io.out.write(`tui row ${i}${CRLF}`);
    await io.wait(20);
    io.mark('lastFrame');
    // No `\x1b[?1049l`: the process dies here, as a killed TUI would.
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['lastFrame'] ?? 0,
        kind: 'drawing',
        why: 'alt-screen TUI output; the final state is only recoverable if it was captured while live (L0.3 capture urgency)',
      },
    ];
  },
};

export const complexProgrammes: Programme[] = [
  shellTuiShell,
  interleaved,
  resizeDuringTui,
  resizeEpochs,
  firehose,
  progressBarScroll,
  synchronizedOutput,
  altWriteThenDraw,
  uncleanTuiExit,
];
