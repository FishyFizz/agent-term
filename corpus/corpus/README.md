# Corpus — terminal test programs and recorded traces

A submodule of AgentTerm: 22 terminal programmes that exercise the terminal in
different ways, plus recorded traces of each, for validating the
writing/drawing classifier (L0.1).

Nothing here classifies anything. This is the material the classifier is measured
against — the corpus is the regression suite, and it was built before the
classifier so that the classifier has something to be wrong about.

## Families

| Family | Count | What it covers |
|---|---|---|
| `basic` | 7 | One behaviour each: append, append-under-scroll, in-place repaint, `\r`-overwrite, append on the alt screen, spinner, clear-and-redraw |
| `cli` | 7 | Shapes of real programs: progress bar, REPL, pager, selector, build log, confirm prompt, dashboard |
| `complex` | 8 | Combinations that break plausible designs: shell→TUI→shell, interleaved log+status, resize during a TUI, firehose, the §4 progress-bar disproof, synchronized output, alt-write-then-draw, unclean TUI exit |

## Layout

```
src/recorder.ts      feeds bytes through @xterm/headless, records op stream + frames
src/runner.ts        runs a programme directly or in a real pty
src/types.ts         Trace / Op / Frame / SegmentExpectation
src/child-driver.ts  runs one programme in a child process (pty feed)
programmes/          basic.ts, cli.ts, complex.ts, index.ts
traces/              recorded output, one file per (programme, feed)
test/corpus.test.ts  corpus invariants
OPS.md               commands, and the platform facts a classifier author needs
```

## The contract

A trace is the emulator's own record: the control-op stream (each op stamped with
a byte offset and the buffer that was active), screen frames, and the text log —
plus `expectations`, the byte ranges and the verdict each should receive.

Two rules from `CLASSIFIER.md` govern it:

- **One parser, one truth.** Everything recorded comes out of the emulator. No
  field is derived by re-scanning the bytes; that would be a second VT parser
  that can disagree with the first.
- **Ops are observed, not consumed.** Every handler returns `false`, so the
  emulator still applies the sequence and we only watch it.

Every expectation carries a `why`. That is the point: a case earns its place by
killing a plausible wrong design, and the `why` says which.

## Quick start

```bash
cd corpus
npx tsx scripts/record.ts --print     # record all, direct feed
npx tsx --test test/corpus.test.ts    # 36 invariant checks
```

See `OPS.md` for the two feeds, the ConPTY findings, and how to add a programme.

## Status

22 programmes, 44 recorded traces (22 × direct/pty), 36/36 corpus tests passing,
typecheck clean. Traces are committed so the classifier can be measured against a
fixed corpus.
