/**
 * Tests that the corpus is a usable regression suite.
 *
 * These check the corpus's own invariants, not the classifier's verdicts — the
 * classifier is a separate deliverable and has its own suite. What must hold
 * here is that every trace is well-formed, that the interesting ops were
 * actually captured, and that each programme produces the structural behaviour
 * it claims to.
 *
 * If one of these fails, the corpus is lying about what it contains and any
 * classifier result measured against it is meaningless.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allProgrammes, findProgramme } from '../programmes/index.js';
import { runDirect } from '../src/runner.js';
import { OP } from '../../src/edit-record.js';
import type { Trace, Op } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const tracesDir = join(here, '..', 'traces');

function loadTrace(id: string, feed: 'direct' | 'pty'): Trace {
  const path = join(tracesDir, `${id}.${feed}.json`);
  assert.ok(existsSync(path), `trace file missing: ${path} — run scripts/record.ts`);
  return JSON.parse(readFileSync(path, 'utf8')) as Trace;
}

const names = (ops: Op[]): string[] => ops.map((o) => o.name);
const has = (ops: Op[], name: string): boolean => names(ops).includes(name);

test('every programme has a recorded trace for both feeds', () => {
  const files = existsSync(tracesDir) ? readdirSync(tracesDir) : [];
  for (const p of allProgrammes) {
    for (const feed of ['direct', 'pty'] as const) {
      assert.ok(files.includes(`${p.id}.${feed}.json`), `missing ${p.id}.${feed}.json`);
    }
  }
});

test('every programme is registered exactly once', () => {
  const ids = allProgrammes.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate programme ids');
  // Ids are namespaced by family, so a trace file maps back to its category.
  for (const p of allProgrammes) {
    assert.ok(
      p.id.startsWith(`${p.category}.`),
      `${p.id} should be namespaced under ${p.category}`,
    );
  }
});

test('traces carry the three families asked for', () => {
  const categories = new Set(allProgrammes.map((p) => p.category));
  for (const c of ['basic', 'cli', 'complex']) {
    assert.ok(categories.has(c as never), `corpus is missing the ${c} family`);
  }
  // And each family has enough cases to be worth measuring against.
  for (const c of ['basic', 'cli', 'complex']) {
    const n = allProgrammes.filter((p) => p.category === c).length;
    assert.ok(n >= 5, `${c} has only ${n} programmes`);
  }
});

test('a pure writing trace emits no erase or cursor-positioning ops', () => {
  const trace = loadTrace('basic.plain-write', 'direct');
  const drawingOps = names(trace.ops).filter((n) => ['CUP', 'EL', 'ED', 'DCH', 'IL', 'DL'].includes(n));
  assert.deepEqual(drawingOps, [], 'plain append must not emit drawing ops');
  assert.ok(trace.ops.filter((o) => o.name === 'LINEFEED').length === 5);
});

test('a repaint trace does emit erase and cursor ops', () => {
  const trace = loadTrace('basic.in-place-repaint', 'direct');
  assert.ok(has(trace.ops, 'CUP'), 'expected CUP');
  assert.ok(has(trace.ops, 'EL'), 'expected EL');
  // And the rewrite actually landed on the screen.
  const last = trace.frames[trace.frames.length - 1]!;
  assert.ok(last.lines.some((l) => l.includes('BETA-REWRITTEN')));
});

test('the alt-screen writing counterexample really is on the alternate buffer', () => {
  const trace = loadTrace('basic.alt-screen-write', 'direct');
  const inAlt = trace.ops.filter((o) => o.altScreen);
  assert.ok(inAlt.length > 0, 'some ops must have fired while the alt buffer was active');
  // Enter and leave are DECSET/DECRST like any other mode; what makes them a
  // boundary is the mode number, which `OP.isAltScreenSwitch` is the one
  // authority on. Asserting on it here keeps a trace and the classifier in
  // agreement about which ops are boundaries.
  assert.ok(
    trace.ops.some((o) => OP.isAltScreenSwitch(o)),
    'expected an alt-screen switch',
  );

  // The counterexample only bites if those alt-buffer ops are plain appends.
  const linefeedsInAlt = inAlt.filter((o) => o.name === 'LINEFEED').length;
  assert.ok(linefeedsInAlt >= 4, `expected sequential linefeeds on alt, got ${linefeedsInAlt}`);

  // Alt content is destroyed on exit — so a live frame must have been captured.
  assert.ok(
    trace.ops.filter((o) => OP.isAltScreenSwitch(o)).length >= 2,
    'expected both an enter and an exit',
  );
});

test('the progress-bar scroll trace reproduces the CLASSIFIER.md §4 disproof', () => {
  const trace = loadTrace('complex.progress-bar-scroll', 'direct');
  // The documented sequence: draw, append (scroll), erase+redraw.
  const ops = names(trace.ops);
  const cupAt = ops.indexOf('CUP');
  const elAt = ops.indexOf('EL');
  const scrollAt = ops.indexOf('SCROLL');
  assert.ok(scrollAt >= 0, 'the append must have scrolled the bar up a row');
  assert.ok(cupAt > scrollAt, 'the redraw must come after the scroll');
  assert.ok(elAt >= cupAt, 'the redraw erases the row it is about to rewrite');
});

test('an interleaved trace contains both append and repaint evidence', () => {
  const trace = loadTrace('complex.interleaved', 'direct');
  assert.ok(has(trace.ops, 'EL'), 'the status row is erased');
  assert.ok(has(trace.ops, 'CUP'), 'the status row is repositioned to');
  const linefeeds = trace.ops.filter((o) => o.name === 'LINEFEED').length;
  assert.ok(linefeeds >= 6, `expected appended log lines, got ${linefeeds}`);
});

test('the shell→TUI→shell journey changes buffer twice', () => {
  const trace = loadTrace('complex.shell-tui-shell', 'direct');
  const changes = trace.ops.filter((o) => o.name === 'BUFFERCHANGE').length;
  assert.ok(changes >= 2, `expected enter and exit, got ${changes}`);
  assert.equal(
    trace.ops.filter((o) => OP.isAltScreenSwitch(o)).length >= 2,
    true,
    'expected an alt-screen enter and exit',
  );
  // Shell text must survive the TUI: the final screen is back on normal and
  // shows the post-TUI shell output.
  const last = trace.frames[trace.frames.length - 1]!;
  assert.equal(last.buffer, 'normal');
  assert.ok(last.lines.some((l) => l.includes('done')), 'output after the TUI is visible');
});

test('a firehose overloads the grid but keeps every line in the text log', async () => {
  const trace = loadTrace('complex.firehose', 'direct');
  assert.ok(trace.bytes > 10000, 'expected a large burst');

  const programme = findProgramme('complex.firehose')!;
  const { trace: fresh } = await runDirect(programme);

  // The grid is bounded...
  const visible = fresh.frames[fresh.frames.length - 1]!.lines.length;
  assert.ok(visible <= programme.rows!, 'the grid stays bounded at rows');

  // ...and the text log is not where the rest of it goes. This is the half the
  // test's name has always promised and its body never checked, because nothing
  // ever drained the log -- every committed trace had `textLog: []`, so a
  // regression here would have been invisible in the field defined for it.
  assert.ok(
    fresh.textLog.length > programme.rows! * 100,
    `kept far more lines than the grid could (${fresh.textLog.length} lines, ${programme.rows} rows)`,
  );
  assert.equal(fresh.textLog[0], 'firehose line 1', 'from the first line emitted');
  assert.equal(fresh.textLog.at(-1), 'firehose line 2000', 'to the last');
  assert.equal(
    new Set(fresh.textLog).size,
    fresh.textLog.length,
    'each one distinct: a log, not a set of distinct lines',
  );

  // And the committed trace carries them, so this is pinned to the file rather
  // than merely true when someone happens to run it.
  assert.deepEqual(trace.textLog, fresh.textLog, 'the recorded trace holds the same lines');
});

test('a programme that genuinely resizes, in both feeds', () => {
  // `complex.resize-during-tui` is named for a resize that never happened -- its
  // programme says "the harness resizes the emulator here" and no harness ever
  // did, so its trace is a redraw at a constant size. This is the programme that
  // does resize, which is what the timeline's epoch rule needs to be tested
  // against at all.
  for (const feed of ['direct', 'pty'] as const) {
    const trace = loadTrace('complex.resize-epochs', feed);
    assert.deepEqual(
      trace.resizes.map((r) => `${r.cols}x${r.rows}`),
      ['30x6', '48x10'],
      `${feed}: both resizes, at the sizes the programme asked for`,
    );

    // A replay has to be able to place them, which means inside the stream and
    // in order.
    let previous = -1;
    for (const r of trace.resizes) {
      assert.ok(r.offset > previous, `${feed}: resize offsets increase`);
      assert.ok(r.offset <= trace.bytes, `${feed}: and fall inside the recorded bytes`);
      previous = r.offset;
    }

    // The marker must not be content: a printed one lands on the grid, and
    // ConPTY repaints the grid when it resizes, so the marker comes back and is
    // acted on again -- measured as eleven resizes where two were asked for.
    assert.ok(
      !trace.raw.includes('resize:30x6') || trace.raw.includes('\x1b]0;resize:30x6\x07'),
      `${feed}: the request is a title sequence, not printed text`,
    );
    assert.ok(
      !/\n.*resize:30x6/.test(trace.raw.replace(/\x1b\]0;resize:\d+x\d+\x07/g, '')),
      `${feed}: no resize marker is visible in the output`,
    );

    const last = trace.frames[trace.frames.length - 1]!;
    assert.equal(last.lines.length, 10, `${feed}: the final frame is the resized grid`);
  }
});

test('synchronized output frames are bracketed by the sync markers', () => {
  const trace = loadTrace('complex.synchronized-output', 'direct');
  // The recorder hooks `?h` / `?l` only for alt-screen modes, so assert on the
  // raw bytes: the markers must be present and each begin paired with an end.
  const begins = (trace.raw.match(/\x1b\[\?2026h/g) ?? []).length;
  const ends = (trace.raw.match(/\x1b\[\?2026l/g) ?? []).length;
  assert.ok(begins >= 2, `expected sync begin markers, got ${begins}`);
  assert.equal(begins, ends, 'every synchronized update must be closed');
});

test('an unclean TUI exit preserves the last live alt-screen frame', () => {
  const trace = loadTrace('complex.unclean-tui-exit', 'direct');
  // It enters the alt screen but never leaves: no DECRST of an alt-screen
  // mode. The old vocabulary could say "no ALT_EXIT" with one op name; with
  // enter and exit both spelled DECSET/DECRST, the direction is in the name.
  const switches = trace.ops.filter((o) => OP.isAltScreenSwitch(o));
  assert.equal(switches.length, 1, 'entered the alt screen exactly once, never left');
  assert.equal(switches[0]!.name, 'DECSET', 'the only switch is the enter');
  const last = trace.frames[trace.frames.length - 1]!;
  assert.equal(last.buffer, 'alternate');
  assert.ok(last.lines.some((l) => l.includes('tui row')),
    'the last live frame is the only record of this content');
});

test('every programme runs and records without throwing', async (t) => {
  for (const programme of allProgrammes) {
    await t.test(programme.id, async () => {
      const { trace } = await runDirect(programme);
      assert.ok(trace.bytes > 0, 'produced output');
      assert.ok(trace.frames.length > 0, 'captured at least one frame');
      assert.ok(trace.expectations.length > 0, 'declares what it should classify as');
      for (const e of trace.expectations) {
        assert.ok(e.to > e.from, `${programme.id}: expectation range must be non-empty`);
        assert.ok(e.why.length > 20, `${programme.id}: expectation needs a reason`);
      }
    });
  }
});

test('recording is deterministic apart from timestamps', async () => {
  // Re-recording must reproduce the committed trace byte for byte, or a
  // "regression" can be nothing but clock drift. Two independent runs of
  // `--feed both` were identical everywhere except `recordedAt` and `op.at`,
  // so those two are stripped and everything else is compared exactly.
  const trace = loadTrace('basic.plain-write', 'direct');
  const programme = findProgramme('basic.plain-write')!;
  const { trace: fresh } = await runDirect(programme);

  const stripTime = (t: Trace) => ({
    ...t,
    recordedAt: '<time>',
    ops: t.ops.map(({ at: _at, ...rest }) => rest),
    frames: t.frames.map((f) => ({ ...f })),
  });

  assert.deepEqual(stripTime(fresh), stripTime(trace), 're-recording reproduces the trace');
});

test('ops are byte-offset stamped and monotonic', async () => {
  const { trace } = await runDirect(allProgrammes[0]!);
  let prev = -1;
  for (const op of trace.ops) {
    assert.ok(op.byteOffset >= 0, 'offset is a byte offset');
    assert.ok(op.byteOffset >= prev, 'offsets never go backwards');
    assert.ok(op.byteOffset <= trace.bytes, 'offset is within the stream');
    prev = op.byteOffset;
  }
  // Array order is the order the emulator saw them, which is the only total
  // order that exists: ops in one delivery share an offset, so an offset
  // cannot order them.
  assert.ok(trace.ops.length > 0, 'the stream is not empty');
});
