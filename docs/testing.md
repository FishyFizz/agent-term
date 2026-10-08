# Testing

What is measured, how, and what a test is allowed to claim.

## What a test may assert

Three rules, in order. They were learned the hard way on this codebase, by doing it the other
way first.

### 1. Comprehensible first

The classifier's job is to **present the terminal in a comprehensible way** — to say what a
human at the screen would say: content arrived, content was replaced in place, content moved,
the surface changed. That is the specification.

It is not "produce the verdict a label says". Nobody specified the labels; they were written by
hand, alongside the code, mostly after it. An expectation that says "this span is drawing" where
the screen shows a blank row gaining text is a claim about the *program's intent*, not about
anything visible — and optimising against it makes the classifier worse in a way that looks
like progress, because the number goes up.

### 2. The code reflects the model

The model comes first and the code is written to match it. When the code and the model
disagree, the code is wrong — including when the code passes its tests.

If a change to the code needs a new special case to keep a label satisfied, that is the model
telling you the code took a wrong turn.

### 3. Tests check the code, not the semantics

A test written after the classifier may assert that the *code is correct*. It may not assert
that a *verdict is right*, because the verdict is the thing under test.

What that leaves, and it is not nothing:

- **Exactness** — applying what was reported reproduces the screen. This runs across every
  delivery of every direct trace, and it does not mention verdicts at all.
- **Completeness and order** — every byte accounted for, segments in time order.
- **Observation, checked against the frames** — "replaced in place" really was a replacement;
  "content arrived" really was blank before. Derivable from the before/after frames, so it needs
  nobody's judgement.
- **Structural invariants** — a group does not straddle a resize or an alt-screen switch; a
  segment's range is well-formed; the collapsed count is honest.

Where a programme's expectation encodes a semantic judgement rather than an observation, **delete
it**. Two were deleted for asserting something about the program that the screen does not show.

The pinned scores are measurements, not a specification. They are printed because a drop means
the algorithm moved, and they are pinned so a regression fails loudly. A rise is not
automatically progress, and a fall is not automatically a bug.

## The corpus

The corpus is a set of terminal programmes and recorded traces of them, built *before* the
classifier so that the classifier has something to be wrong about. Nothing in it classifies
anything.

Each programme is a `Programme`: `run(io)` emits the output, and `expectations(marks)` declares
the byte ranges and the verdict each should get, each with a `why` naming the reason the case
exists. A programme whose `why` could be deleted without loss is not worth adding — the corpus
is judged on whether each case kills a plausible wrong design.

### Families

| Family | What it covers |
|---|---|
| `basic` | One behaviour each: append, append under scroll, in-place repaint, `\r`-overwrite, append on the alt screen, spinner, clear-and-redraw |
| `cli` | Shapes of real programs: progress bar, REPL, pager, selector, build log, confirm prompt, dashboard |
| `complex` | Combinations that break plausible designs: shell→TUI→shell, interleaved log and status, resize during a TUI, a resize that splits history into epochs, firehose, synchronized output, alt-write-then-draw, unclean TUI exit |

### Two feeds

Every programme is recorded twice, and the two are for different jobs:

| Feed | How | Use it for |
|---|---|---|
| `direct` | the programme's bytes are captured, then fed to the emulator | deterministic byte offsets; expectations named as real ranges |
| `pty` | the programme runs as a child in a real pty session | what a real session sees, including the platform's rewriting |

**Validate logic against `direct` traces; use `pty` traces to check that reality does not
diverge.** In pty mode a mark cannot be reported through the child's io, so mark names are
recovered from the emitted text and the expectations degrade to approximations.

Traces are committed, so a classifier can be measured against a fixed corpus without running
anything.

### Two rules govern the recorder

- **One parser, one truth.** Everything recorded comes out of the emulator — the repo's own
  screen model — so the op stream, byte offsets and screen state in a trace are exactly what a
  live session produces. No field is derived by re-scanning the bytes.
- **Ops are observed, not consumed.** Every handler returns `false`, so the emulator still
  applies the sequence and the recorder only watches.

### Recording

```bash
npm run record            # all programmes, direct feed
npm run record:all        # both feeds
npm run corpus            # score the classifier across replay granularities
```

Adding a programme: write it in `corpus/programmes/<family>.ts`, add it to the exported array,
record it alone and check the op stream is what you intended, then re-record both feeds and
commit the traces.

### Platform facts to know before trusting a trace

- **A real pty on Windows does not hand back the bytes the programme wrote.** ConPTY parses and
  re-emits some sequences, and drops others. A `\r`-overwrite case in particular can lose its
  erase op before the emulator ever sees it, which is why the screen model has to catch that
  case rather than an op handler. The corollary is a rule: **never assert on raw escape bytes in
  a pty-fed test** — assert on the emulator's op stream and screen, which is what the recorder
  does.
- **A pty session opens with the platform's own handshake** before any programme output. A
  classifier that treats the first frames as programme behaviour sees a spurious full-screen
  clear at the start of every session.
- **`encoding: null` does not guarantee a Buffer on every platform.** The pty layer coerces, so
  byte counts come out right either way; do not assume a Buffer in either direction.
- **Writes are asynchronous.** The grid reflects a write only after the callback fires; a
  same-tick read returns the pre-write grid.

Re-probe these rather than trusting them if a dependency version moves.

## `fixtures/life` — the lifelike subject

The corpus is a set of scripted output bursts, which is the right shape for scoring the
classifier and the wrong shape for testing a *driver*: nothing in it reads a line, waits, or
reacts.

`fixtures/life` is an interactive program that behaves like a real one. It prints a banner and a
prompt, and each line typed at it is answered with a randomly chosen action — a reply, a
multi-line reply, nothing at all, a menu, or a chat frame. **The input text is ignored**: the
subject tests whether the driver waits, not whether it can compose a command.

```bash
npm run life                          # random
npm run life -- --seed 42             # replay one exact run
npx tsx scripts/life.ts --pick menu   # drive it through the MCP surface and print the screen
```

### The readiness contract

**The prompt is printed only when the subject is idle.** While it works there is no prompt and
no progress output — just silence, which is the entire signal, and noticing it is what is being
tested. Gaps are usually short and occasionally long, with at most one long gap per action so a
turn stays bounded.

The `silent` action is the sharpest form of "is it ready yet?" — nothing at all arrives.

Input typed while the subject is busy is held and run after, in order, and the tty echoes it
immediately — so what you see is your own line appearing in the middle of someone else's reply,
with nothing happening until the reply finishes. That is exactly the mistake worth catching.

### Modes

Both modes take the alt screen and return the shell transcript untouched. The menu is built on
`@clack/prompts`; the chat frame is hand-rolled, because a chat is a persistent frame redrawn
in place and a prompt library renders a linear flow one question at a time — it cannot hold a
layout.

### Flags

| Flag | Meaning |
|---|---|
| `--seed <n>` | Replay one exact run: same actions, same gaps. The seed is printed in the banner. |
| `--pick <kind>` | Force every action to one kind: `reply`, `multiline`, `silent`, `menu`, `chat`. |
| `--speed <n>` | Divide every delay by `n`, so a run is fast enough for a test. |

The subject is random by design, so its tests assert the contract — one seed replays as one run,
gaps stay inside the promised range, no prompt is shown while it works, a line typed into that
silence is answered rather than dropped, and both modes give the shell back — and never assert
timings or screen bytes.
