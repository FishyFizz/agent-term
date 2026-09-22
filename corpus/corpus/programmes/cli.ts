/**
 * Patterns that mimic real CLI programs.
 *
 * Each one reproduces the observable behaviour of a program the classifier will
 * meet in the wild, written by hand so it is deterministic and needs no
 * dependency installed.
 */
import type { Programme } from '../src/types.js';

const CRLF = '\r\n';

/**
 * The npm/cargo shape: log lines appended above, a progress bar repainted at
 * the bottom.
 *
 * This is the trace that killed spatial band decomposition (CLASSIFIER.md §4).
 * Draw, append, redraw: the old bar and the new bar end up at *different rows*
 * with a log line between them, so no spatial clustering can link them. The
 * verdict must come from the op stream, in time order.
 */
export const progressBar: Programme = {
  id: 'cli.progress-bar',
  category: 'cli',
  summary: 'Log lines appended above a progress bar that is repainted below — interleaved.',
  cols: 60,
  rows: 8,
  async run(io) {
    io.mark('start');
    const bar = (pct: number): string => {
      const filled = Math.round((pct / 100) * 20);
      return `[${'#'.repeat(filled)}${'-'.repeat(20 - filled)}] ${String(pct).padStart(3)}%`;
    };
    // Draw the bar once, at the bottom.
    io.out.write(`npm install${CRLF}`);
    io.out.write(`${bar(0)}${CRLF}`);
    await io.wait(10);
    io.mark('barDrawn');

    for (const pct of [25, 50, 75, 100]) {
      // A log line appends, scrolling the bar up by one row...
      io.out.write(`added package-${pct} in ${pct}ms${CRLF}`);
      await io.wait(8);
      // ...then the bar is redrawn on the bottom row.
      io.out.write('\x1b[s'); // save cursor
      io.out.write(`\x1b[${io.rows};1H`); // last row
      io.out.write('\x1b[2K'); // erase it
      io.out.write(bar(pct));
      io.out.write('\x1b[u'); // restore cursor
      await io.wait(8);
    }
    io.mark('end');
  },
  expectations(m) {
    return [
      { from: m['start'] ?? 0, to: m['barDrawn'] ?? 0, kind: 'writing', why: 'header and first bar, appended' },
      {
        from: m['barDrawn'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'each cycle is append-then-repaint; the bar is erased and redrawn at a moving row, so the writing and drawing parts are separate segments in time, not bands in space (CLASSIFIER.md §4)',
      },
    ];
  },
};

/** A REPL: prompt echoed, output appended, prompt repainted. */
export const repl: Programme = {
  id: 'cli.repl',
  category: 'cli',
  summary: 'A REPL — input echoed, results appended, prompt repainted after each.',
  cols: 60,
  rows: 8,
  async run(io) {
    io.mark('start');
    const prompt = '>>> ';
    io.out.write(prompt);
    await io.wait(10);

    for (const [cmd, result] of [
      ['1 + 1', '2'],
      ['print("hi")', 'hi'],
      ['exit()', ''],
    ] as const) {
      io.out.write(cmd); // what the user typed (echoed by the tty)
      await io.wait(5);
      io.mark(`submit:${cmd}`);
      io.out.write(CRLF);
      if (result) io.out.write(`${result}${CRLF}`);
      await io.wait(5);
      io.out.write(prompt); // prompt repainted
      await io.wait(5);
    }
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'writing',
        why: 'a REPL appends: echoed input, result, new prompt. Nothing is erased or rewritten, so despite feeling interactive it is append-only text',
      },
    ];
  },
};

/** A pager: fills the screen, then repaints on scroll. Alt screen on exit. */
export const pager: Programme = {
  id: 'cli.pager',
  category: 'cli',
  summary: 'A pager (less-like): fills the screen, repaints on scroll, restores on quit.',
  cols: 60,
  rows: 6,
  async run(io) {
    io.mark('start');
    io.out.write('\x1b[?1049h'); // pager takes the alt screen
    io.out.write('\x1b[H');
    const lines = Array.from({ length: 30 }, (_, i) => `log entry ${i + 1}`);
    for (let i = 0; i < io.rows - 1; i++) {
      io.out.write(`${lines[i]}${CRLF}`);
    }
    io.out.write('(END)'); // status line
    await io.wait(20);
    io.mark('firstPage');

    // Scroll: repaint the whole viewport from a new offset.
    for (const start of [5, 10]) {
      io.out.write('\x1b[H');
      for (let i = 0; i < io.rows - 1; i++) {
        io.out.write('\x1b[2K');
        io.out.write(`${lines[start + i] ?? ''}${CRLF}`);
      }
      io.out.write('\x1b[2K(END)');
      await io.wait(20);
    }
    io.mark('scrolled');
    io.out.write('\x1b[?1049l'); // quit: restore the shell underneath
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['firstPage'] ?? 0,
        to: m['scrolled'] ?? 0,
        kind: 'drawing',
        why: 'each scroll repaints every row from a new offset; rows are reused for different content',
      },
    ];
  },
};

/** A menu / selector: cursor moves within a fixed list, one row highlighted. */
export const menuSelector: Programme = {
  id: 'cli.menu-selector',
  category: 'cli',
  summary: 'A selector (fzf-like): a fixed list with a highlight that moves.',
  cols: 50,
  rows: 8,
  async run(io) {
    io.mark('start');
    io.out.write('\x1b[?1049h\x1b[H');
    const items = ['alpha', 'beta', 'gamma', 'delta'];
    const drawList = (sel: number): void => {
      io.out.write('\x1b[H');
      for (let i = 0; i < items.length; i++) {
        io.out.write('\x1b[2K');
        io.out.write(`${i === sel ? '\x1b[7m> ' : '  '}${items[i]}${i === sel ? '\x1b[0m' : ''}${CRLF}`);
      }
    };
    drawList(0);
    await io.wait(15);
    io.mark('moves');
    for (const sel of [1, 2, 3, 0]) {
      drawList(sel);
      await io.wait(15);
    }
    io.mark('end');
    io.out.write('\x1b[?1049l');
  },
  expectations(m) {
    return [
      {
        from: m['moves'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'every move erases and redraws the whole list; only the highlight changes, so intermediate states are states, not text',
      },
    ];
  },
};

/** Build output with colour, warnings, and a final summary. */
export const buildLog: Programme = {
  id: 'cli.build-log',
  category: 'cli',
  summary: 'A compiler-like build log with colour — long, noisy, append-only.',
  cols: 80,
  rows: 10,
  async run(io) {
    io.mark('start');
    io.out.write(`\x1b[1mBuilding 40 targets\x1b[0m${CRLF}`);
    for (let i = 1; i <= 40; i++) {
      const colour = i % 7 === 0 ? '\x1b[33m' : '\x1b[32m';
      io.out.write(`${colour}[${i}/40]\x1b[0m Compiling module_${i}${CRLF}`);
      await io.wait(1);
    }
    io.mark('summary');
    io.out.write(`\x1b[31merror: 1 target failed\x1b[0m${CRLF}`);
    io.out.write(`Finished in 3.21s${CRLF}`);
    io.mark('end');
  },
  expectations(m) {
    return [
      {
        from: m['start'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'writing',
        why: '40 lines of SGR-coloured text, scrolling the whole way. SGR ops are not drawing ops — colour changes do not repaint (a threshold-free classifier must not count them)',
      },
    ];
  },
};

/** A yes/no prompt that blocks, then continues. */
export const confirmPrompt: Programme = {
  id: 'cli.confirm-prompt',
  category: 'cli',
  summary: 'A blocking confirm prompt — output stops with a pending prompt.',
  cols: 60,
  rows: 6,
  async run(io) {
    io.mark('start');
    io.out.write(`About to delete 12 files.${CRLF}`);
    await io.wait(10);
    io.mark('prompt');
    io.out.write('Continue? [y/N] ');
    // No newline: the program is blocked. This is L1.4's pending prompt.
    io.onInput((data) => {
      if (data.includes('y')) {
        io.out.write(`y${CRLF}deleted 12 files${CRLF}`);
        io.mark('answered');
      }
    });
    await io.wait(60);
    io.mark('end');
  },
  expectations(m) {
    return [
      { from: m['start'] ?? 0, to: m['prompt'] ?? 0, kind: 'writing', why: 'the notice line is appended before the program blocks' },
      {
        from: m['prompt'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'writing',
        why: 'the prompt is written without a newline and the program then blocks; nothing is erased or redrawn, so it is still append-only text — the interesting property is that output *stops*, which is L1.4, not a classification question',
      },
    ];
  },
};

/** A table redrawn in place, as a dashboard would. */
export const dashboard: Programme = {
  id: 'cli.dashboard',
  category: 'cli',
  summary: 'A dashboard table redrawn in place every tick.',
  cols: 50,
  rows: 10,
  async run(io) {
    io.mark('start');
    io.out.write('\x1b[?1049h');
    const draw = (tick: number): void => {
      io.out.write('\x1b[H');
      io.out.write(`\x1b[2K  METRIC        VALUE${CRLF}`);
      io.out.write(`\x1b[2K  cpu          ${20 + tick * 7}%${CRLF}`);
      io.out.write(`\x1b[2K  mem          ${40 + tick * 5}%${CRLF}`);
      io.out.write(`\x1b[2K  net          ${tick * 120}kb${CRLF}`);
    };
    draw(0);
    await io.wait(15);
    io.mark('ticks');
    for (let t = 1; t <= 3; t++) {
      draw(t);
      await io.wait(15);
    }
    io.mark('end');
    io.out.write('\x1b[?1049l');
  },
  expectations(m) {
    return [
      {
        from: m['ticks'] ?? 0,
        to: m['end'] ?? 0,
        kind: 'drawing',
        why: 'the same four rows are erased and rewritten each tick with different values; a state, not text',
      },
    ];
  },
};

export const cliProgrammes: Programme[] = [
  progressBar,
  repl,
  pager,
  menuSelector,
  buildLog,
  confirmPrompt,
  dashboard,
];
