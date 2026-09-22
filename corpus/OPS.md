# OPS.md — operating the corpus

How to record, what the two feeds mean, and the platform facts a classifier
author needs before trusting a trace.

## Commands

```bash
cd corpus
npx tsx scripts/record.ts                  # all programmes, direct feed
npx tsx scripts/record.ts --feed pty       # all programmes, through a real pty
npx tsx scripts/record.ts --feed both      # both feeds
npx tsx scripts/record.ts --only cli.      # one family
npx tsx scripts/record.ts --print          # per-trace summary + final screen
npx tsx --test test/corpus.test.ts         # corpus invariants
npx tsc -p tsconfig.json                   # typecheck
```

Traces land in `corpus/traces/<id>.<feed>.json`. They are committed, so a
classifier can be measured against a fixed corpus without running anything.

## Two feeds, and why

| Feed | How | Use it for |
|---|---|---|
| `direct` | the programme's bytes are captured, then fed to the emulator | deterministic byte offsets; expectations named as real ranges |
| `pty` | the programme runs as a child in a real node-pty session | what a real session sees — including ConPTY's rewriting |

`direct` is the one to validate logic against: the bytes are exactly what the
programme emitted, so a trace is reproducible and an expectation range means
something. `pty` is the one that says whether that logic survives reality.

## Verified platform facts

Probed on this machine (Windows 11, node 22.23.2, node-pty 1.1.0,
`@xterm/headless` 6.0.0). Re-probe rather than trusting these if a version moves.

### ConPTY rewrites escape sequences

This is the big one. On Windows the bytes that come out of the pty are **not**
the bytes the programme wrote. ConPTY parses and re-emits some sequences:

| Written | Survives? |
|---|---|
| `\x1b[?1049h` / `\x1b[?1049l` (alt screen) | yes |
| `\x1b[2J` (ED) | yes |
| `\x1b[5;3H` (CUP) | yes |
| `\x1b[?2026h` (synchronized output) | yes |
| `\x1b[K` (EL, default param) | yes |
| `\x1b[2K`, `\x1b[2A`, `\x1b[2L`, `\x1b[2M`, `\x1b[3P`, `\x1b7` | **no** — not passed through |
| `\x1b[31m` (SGR) | **no** |

Consequence for the classifier: **a `\r`-overwrite case may lose its erase op
before the emulator ever sees it.** `basic.cr-overwrite` is the probe for this —
it is a redraw with *no* erase op, and the screen model has to catch it (the
open item in CLASSIFIER.md §9.2). On a real pty the same is true of any program
whose repaint ConPTY happens to swallow.

Corollary: never assert on raw escape bytes in a pty-fed test. Assert on the
emulator's op stream and screen, which is what the recorder does.

### ConPTY does not inject erase ops on plain output

A pure append-only programme (five plain lines) came back as 5 CRLFs and **zero**
`\x1b[K`. So the scrolling build-log case is not polluted by platform artifacts,
and "writing" is safe to detect on Windows.

### ConPTY prepends its own handshake

Every pty session on Windows opens with `\x1b[?9001h\x1b[?1004h` and an
`\x1b[2J`, plus an OSC title change, before any programme output. A classifier
that treats the first frames as programme behaviour will see a spurious
full-screen clear at the start of every session.

### `encoding: null` still delivers strings on Windows

`PtySession` spawns with `encoding: null` to get raw buffers (L1.3's byte
watermarks depend on it). On Windows node-pty hands back a **string** regardless
— verified via `SessionRegistry`: `chunk.constructor.name === 'String'`,
`Buffer.isBuffer(chunk) === false`. `pty.ts` coerces with
`Buffer.from(chunk, 'utf8')`, so byte counts are right, but on POSIX the same
code path receives a Buffer. Do not assume a Buffer in either direction.

Note: the repo's own `test/bytes.test.ts` has one failing case on this machine
(`bytesRead counts bytes, not characters`); the `data events deliver Buffers`
case passes because the coercion is transparent. That is pre-existing on main
and is a pty-substrate issue, not a corpus one.

### Alt screen behaves as documented

Confirmed against `@xterm/headless` v6, matching CLASSIFIER.md §3.4 and
`references/xterm-headless-facts.md`:

- `\x1b[?1049h` switches `buffer.active.type` to `alternate`; the alternate
  buffer's `length` stays pinned at `rows` and has no scrollback.
- Sequential writes on the alt screen fire `LINEFEED` and scroll normally —
  observationally identical to `cat`. **The alt screen is not a drawing verdict.**
- `\x1b[?1049l` restores the normal buffer with its prior content and **discards
  everything written on alt**. Capture while live is mandatory.
- `BUFFERCHANGE` fires on both transitions, so a journey is segmentable.

### Writes are asynchronous

`terminal.write(data, cb)` — the buffer only reflects the change after the
callback fires. The recorder awaits every write; a same-tick read returns the
pre-write grid.

### Ops are only reported for the hooks registered

`registerCsiHandler` takes a single-byte `final`. A two-byte final (` q`, cursor
style) throws `final must be a single byte`. `ESC 7`/`ESC 8` go through
`registerEscHandler`, not CSI.

### Marks in pty mode

`io.mark()` only works in `direct` mode — in a child process there is nowhere to
send the offset. In pty mode `runPty` recovers mark names by finding them in the
emitted text, so expectations degrade to approximations. **Validate logic against
`direct` traces; use `pty` traces to check that reality does not diverge.**

## Adding a programme

1. Write it in `programmes/<family>.ts` as a `Programme`: `run(io)` emits the
   output, `expectations(marks)` declares byte ranges and the verdict each should
   get, with a `why` that names the reason the case exists.
2. Add it to the exported array in that file.
3. `npx tsx scripts/record.ts --only <id> --print` and check the op stream is
   what you intended.
4. Re-record both feeds and commit the traces.

A programme whose `why` could be deleted without loss is not worth adding — the
corpus is judged on whether each case kills a plausible wrong design.
