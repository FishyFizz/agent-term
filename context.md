# context.md — AgentTerm

> **Purpose of this file.** This is the standing starting context for every agent that works on
> this repository. It is meant to *replace* the initial "let me look at the docs and the code"
> phase: read this first, and you should be able to start working. It is deliberately verbose —
> it is not a quick summary, and compressing it defeats its purpose.
>
> **It is a living document.** After a job is done, update it: new modules, changed invariants,
> moved numbers, new pitfalls, closed open items. Update the "Current status" block and the
> "Verified numbers" table whenever real measurement contradicts what is written here. Never
> let this file drift from reality — an agent that trusts a stale context file is worse off than
> one with no context at all.
>
> **Source of truth.** Where this file and a doc disagree, the doc written *as a design record*
> (`CLASSIFIER.md`, `GOAL.md`, `HISTORY.md`) wins on intent; this file wins on current state.
> Where this file and the code disagree, the code wins — and this file is stale.

---

## 1. What this project is

**AgentTerm** is an MCP (Model Context Protocol) server that lets an AI agent operate a terminal
the way a human does. It hosts real virtual terminal sessions (a real pty with a real process
tree inside), watches them change, and reports those changes back in the form that makes sense
for the kind of program that is running.

The entire project exists for **one distinction**:

1. **Streaming text** — a compiler, `ls`, `grep`, a test runner, a curl of an API. Output is
   append-only prose. The agent wants *the new text since last time*, in order. Handing it a
   screen render of a build log wastes enormous context on repeated frames and loses what
   scrolled off.
2. **A redrawn surface** — `vim`, `htop`, `fzf`, `lazygit`, a TUI installer, a REPL doing inline
   redraw. Output is not a stream; it is a *state*. New bytes are fragments of a picture the
   agent cannot reconstruct. It wants *the screen*: what is on it now, and how it differs from a
   moment ago.

Existing MCP terminal servers collapse both into "here are some bytes" or "here is a truncated
scrollback tail". The agent then guesses which world it is in and usually guesses wrong.
AgentTerm makes the distinction **first-class and automatic**, and keeps everything it saw so the
agent can go backwards.

**Status: not usable yet as a product.** L0 (the core model) is complete and measured. A first
MCP surface exists as a spike. L1 is partly built. See §11.

**License:** MIT. **Language:** TypeScript, ESM (`"type": "module"`), strict mode. **Node:** >= 20
(developed and tested on v22.23.2; the corpus suite was also verified on 24.18.0).

---

## 2. Repository layout

```
GOAL.md            goals, layered L0 (core model) .. L3 (outer implementation)  [346 lines]
PRIOR-ART.md       survey of tui-mcp, tmux-mcp, SmartCLI, terminal-bench       [209 lines]
CLASSIFIER.md      how a change is classified writing/drawing; §11 = what a
                   test may assert (READ THIS BEFORE TOUCHING TESTS)           [483 lines]
HISTORY.md         the timeline: epochs, deltas, keyframes, measurements       [256 lines]
README.md          user-facing status + dev commands
context.md         THIS FILE

src/               ~5,000 lines of implementation (see §4)
test/              ~4,800 lines, 232 tests
scripts/           entry points: mcp-stdio, mcp-http, smoke, life, corpus-score
corpus/            23 terminal programmes + 46 recorded traces (regression suite)
fixtures/life/     "lifelike" interactive subject — a black-box driving exercise
.claude/skills/    two agent-facing skills (agent-term usage; life-drive exercise)
feedbacks/         recorded driving runs (gitignored, but committed files exist)
```

The repo is a **single TypeScript project**: `tsconfig.json` includes `src`, `test`, `scripts`,
`corpus`, `fixtures` together, so `npm run typecheck` covers everything at once. There is no
separate build step for tests — everything runs through `tsx`.

---

## 3. The layering (the most important structural idea)

Goals are organized in concentric layers. **The governing rule:**

> **Inner layers do not depend on outer layers. Outer layers can be changed, or replaced
> entirely, without redesigning anything inside them.**

Concretely: the writing/drawing model must survive swapping node-pty for a Go pty library,
swapping stdio for HTTP, dropping PNG rendering, or rewriting the human viewer. **If a change to
an outer layer would force an inner layer to change, the boundary is drawn wrong.**

| Layer | Name | Contains | Stability |
|---|---|---|---|
| **L0** | Core model | Writing vs drawing, classification contract, history timeline, session identity | **Frozen.** Built: L0.1–L0.5 |
| **L1** | Important capabilities | Interaction, bounded waiting, bounded delivery, correct observation | Shape locked; partly built |
| **L2** | Nice-to-have | Sub-region reads, cursor query, mouse, raw escape hatch, archetype hints, PNG/HTML | Additive; may ship late or never |
| **L3** | Outer implementation | Stack, transport, viewer, retention, safety, packaging | Freely swappable |

**Practical consequence for a working agent:** before adding anything, ask which layer it is in.
If a change would put a policy number (a timeout, a byte cap, a transport detail) into L0, the
change is wrong — the number goes in L1/L3 and arrives by injection or as a policy object. This
is why `src/groups.ts` takes a clock and a scheduler by injection, and why `DEFAULT_GROUP_POLICY`
lives in exactly one place.

### Non-goals (do not build these)

- **Not a command runner** — shell semantics and what to run remain the agent's job.
- **Not a GUI automator** — text terminals only. No window automation, no pixel screenshots.
- **Not an output interpreter** — the server decides *how* to present a change, never what it
  *means*. No summarising logs, no parsing program output on the agent's behalf.
- **Not an agent framework** — no planning, no tool-use policy, no prompt engineering.
  Explicitly excluded: **scripted recipes that drive a TUI on the agent's behalf.** That is
  framework work. This is why `send_sequence` does *not* wait between steps.
- **Not a sandbox** (see L3.5).

---

## 4. Module map — what each file is and why it exists

Read the header comment of any file before editing it; each one states the design reason the
module exists and the failure it prevents.

### src/ (~5,000 lines)

| File | LOC | Responsibility |
|---|---|---|
| `pty.ts` | 215 | The real pty. `PtySession`: `write`, `resize`, `kill`, `dispose`; events `data`/`exit`. Spawns with `encoding: null` for raw buffers. Owns `bytesRead`. |
| `xterm.ts` | 46 | Constructs `@xterm/headless` with `allowProposedApi: true` (required — `buffer` is proposed API and throws otherwise). |
| `screen.ts` | 447 | **The screen model.** `ScreenModel` wraps the emulator; owns the cell grid, the op stream (`EditRecord`), and the `TextLog`. `snapshot()` returns a deep copy carrying its own `cols`/`rows`. Owns the two coordinates (glyph index vs column) and is the only place they are reconciled. |
| `edit-record.ts` | 286 | The op stream: control ops (`csi`/`esc`/`event`) each stamped with byte offset, cursor position, params, alt-screen flag, and `at` (ms). Used for **replay, boundaries, and the raw escape hatch — never as input to the verdict.** |
| `text-log.ts` | 178 | The second sink. Append-only `TextLine[]`, each carrying `{byte, buffer, text, row}`. |
| `classify.ts` | 357 | **The classifier.** `classify({before, after, fromByte, toByte, scrolledBy})` → segments. `frameOf`, `rowDiff`, `coalesce`. Must read like CLASSIFIER.md §3.1: four observations, one walk, **no thresholds**. |
| `delta.ts` | 293 | `gridDelta(before, after, hint)` / `applyDelta`. Encodes a screen change as `{scrollBy, runs, rows}`. Searches the shift and **verifies** it rather than trusting the emulator. |
| `groups.ts` | 318 | **Group boundaries** — where one run of output ends. Inferred from silence, so it is a
   measured boundary, not a declared one; it is also a classification input (§9.3). `DEFAULT_GROUP_POLICY = {gapMs: 50, maxBytes: 64KB, maxChunks: 256}`. `GroupDetector`, `groupByGap`, `FakeClock`. |
| `history.ts` | 670 | **The timeline.** `SessionHistory` (epochs, records, `read`, `screenAt`, `deliveries`, `groups`, `textSince`, `tokenAt`) and `HistoryStore`. |
| `session.ts` | 995 | **The L0.4 session**: pty + screen + classifier as one object. `TerminalSession`: `feed`, `waitForIdle`, `waitForOutput`, `state`, `resize`, `onUpdate`/`onDelivery`/`onExit`/`onResize`, `dispose`. |
| `registry.ts` | 53 | `SessionRegistry` — live sessions by id. Deliberately **history-agnostic**: dropping a live session must not discard what it did. |
| `host.ts` | 89 | **The composition root.** `SessionHost.open()` creates a session *and starts recording it* in one call, because two calls would let a caller forget the second and get a working terminal with silently empty history. |
| `keys.ts` | 480 | Named keys + `composeSteps`. The key table, mode-dependent encoding (`CSI B` vs `SS3 B`), `escapeBytes`, `KeyInputError`. |
| `match.ts` | 84 | `wait_for_output` matching: `matchRow`, `matchLine`, `trimRow`. |
| `mcp.ts` | 371 | **The MCP surface** — 7 tools. See §7. |
| `types.ts` | 90 | `SessionId`, `GroupPolicy`, `SessionOptions`, `DEFAULT_COLS/ROWS` (80/24), `assertGridSize` (shared so a pty and an emulator can never disagree about a size). |
| `env.ts` | 25 | `sanitizeEnv`, `defaultShell`. |

### The data flow (the pipeline, end to end)

```
pty bytes
  │
  ├─► group detector (src/groups.ts)      close on a quiet period, a cap,
  │                                   or a forced flush at resize/exit/dispose
  ▼
delivery            one group of raw bytes
  ├─► emulator.write()                (ASYNC — awaited; a same-tick read sees a stale grid)
  │     ├─► op stream                 replay, boundaries, raw escape hatch
  │     └─► screen model  ──► text log (per-line signal, judged by the row diff)
  ▼
frames              before / after
  ▼
classify            structural tests on the screen, one walk, no thresholds
  ▼
verdict             writing | drawing, + evidence
  ▼
delivery            text delta and screen, each collapsed its own way
  ▼
history             one append-only record per delivery (delta or keyframe)
```

---

## 5. The classifier (L0.1) — the heart of the project

### The contract

- **The server classifies.** The agent never inspects escape sequences or guesses a mode.
- **Misclassification is a server bug**, not a puzzle for the agent.
- A change can be **both** writing and drawing — but as a **sequence** of segments, not inside
  one segment.

### Two rules that govern everything

> **The screen is the witness.** The verdict is read off the screen and nowhere else — not off
> the escape sequences, and not off what the program appears to have intended. A human at the
> terminal sees a screen; the agent is meant to see the same thing.

> **One parser, one truth.** Classification is derived from the emulator that produces the
> screen, never from a second reading of the byte stream. A byte-level heuristic would be a
> second, worse VT parser that could disagree with the first — and L0.2 stakes the project on
> the emulator being the authority.

**Consequence worth internalising: there is no abstention and there is no confidence value.**
The four observations below are a closed set, so every change lands in one of them. Nothing
declines to answer. What replaces doubt is **volume** (see below).

### The four observations (threshold-free, structural)

| Test | If true | Why |
|---|---|---|
| Did the segment erase cells outside the scrolled region? | drawing | Erasing is redrawing |
| Did it write onto cells that were non-blank? | drawing | Overwrite ≠ append |
| Did it reach back above the cursor's position at segment start? | drawing | Reaching back into printed content is repainting |
| Was it text + linefeed only, cursor advancing monotonically, no non-blank cell made blank, no cell above the cursor touched? | writing | This is what appending *is* |

**Scroll is normalized against the emulated scroll event first**, then the residual is judged.
Without this a scrolling build log changes every row and looks like a repaint; after
normalization it is "N new lines at the bottom, nothing else". That is the dominant case for
`ls`, `cat`, `grep`, compilers and shells.

**A threshold-free classifier needs no tuning per program** — and GOAL.md's success criteria
1–5 are all "without special-casing any program". **If a magic number ever looks necessary, the
test is wrong.**

### The unit is the delivery, not the frame

The first design classified each update as `writing | drawing | mixed`. That is wrong. **The
unit of classification is the delivery** — one group, one segment. A segment cannot claim a finer
range than the thing it was measured over, and the measurement is a frame diff across the whole
delivery. "Mixed" is a fact about a **sequence** of updates, not about one of them.

An even earlier rule produced one segment per control op inside a single update. That let an
op's verdict compete with the screen's over the same bytes; nothing could settle it, and the
resolution was a series of special cases (`CUP` corroborates drawing; except the home that
follows entering a full-screen program; except when they disagree, in which case confidence
drops). **Every one of those cases was a judgement call introduced to settle a conflict that
only existed because the op stream was being asked.** All gone now.

### Alt screen is NOT a verdict

This was the **first rejected design** (alt screen = hard "drawing"). The counterexample is
exact and verified:

```
write '\x1b[?1049h' then A1..A8 separated by \r\n
  → buffer.active.type === 'alternate'
  → alternate.length stays 5 (fixed at rows)
  → onLineFeed fires (6×); content scrolls within the alt screen
  → '\x1b[?1049l' restores the normal buffer with prior content intact
```

That is *pure sequential append* — observationally identical to `cat`. A program writing on the
alt screen and a program writing on the normal screen are indistinguishable by buffer type.
`buffer.active.type` carries **zero** information about writing vs drawing.

It carries two other real things:
1. **Capture urgency.** Alt-screen content is **destroyed on exit** (verified). L0.3's "page
   back to any earlier part" is unsatisfiable unless alt content is recorded while live.
   **Entering the alt screen makes capture mandatory, not optional.**
2. **A prior.** Programs choose the alt screen *because* they intend to repaint, so it
   correlates with drawing. It raises capture urgency; it does not raise a verdict.

Alt-screen enter/exit are additionally **segment boundaries and timeline events** — which is
what makes success criterion 3 (shell → TUI → shell, reconstructable in order) fall out
structurally instead of needing separate machinery.

### Suspicion is volume, not doubt

The case that used to be abstention — "the program appears to have done something the screen
will not confirm" — is reported as **volume**: an update carries how many raw deliveries it
collapsed (`collapsed.chunks`), so *many deliveries behind little visible change* is legible to
the agent as exactly that. The intermediates are **not merely counted but kept**, and playable
back via `history.deliveries(from, to)`. A group is fed one raw delivery at a time for precisely
this reason: **merged bytes cannot be un-merged afterwards.**

That is a better signal than a confidence flag: it is a fact rather than a judgement, it does
not require the classifier to know what it does not know, and it points at the remedy (go read
the intermediates) instead of merely warning.

A third `unknown` verdict is reserved for emulator desync and **should be unreachable**.

### Two structural events are NOT drawings (special-case them or they classify as enormous repaints)

- **Resize** — reflows every row.
- **Alt-screen exit** — reflow on restore.

### The two kinds collapse differently (why coalescing cannot precede classification)

- **Writing deltas concatenate.** Intermediate states are informative; losing one loses text.
- **Drawing states collapse to the latest.** 40 intermediate spinner frames carry no information.

Getting this backwards is exactly how a 60fps TUI floods the agent, or how a build log loses
lines.

---

## 6. Rejected designs — read before "improving" the classifier

### Spatial band decomposition (rejected; the npm progress bar killed it)

The first design split an update into contiguous **bands** of changed rows, separated by
unchanged rows, and classified each band independently.

**This is impossible. A row is a coordinate, not an entity, and a single scroll invalidates the
correspondence.**

```
draw bar        CUP@y4  EL@y3        row4: "[#####-----]"
append "log5"   (no control ops)     scrolls; the old bar is now at row 3
redraw bar      CUP@y4  EL@y4        row4: "[##########]"

final screen:
  row3: "[#####-----]"    ← old bar, still on screen
  row4: "[##########]"    ← new bar
```

The two bars are at **different rows**, the new log line sits spatially between them, and
nothing in the diff links row 3's past self to row 4's present self. **There is no evidence —
and can be none — that they are "the same" status line.**

The general failure: *the npm update decomposes in time, not in space.* It is
`draw → erase → write → draw`, and no spatial clustering of a before/after diff can recover that
ordering. Bands also smuggled in identity-by-position, which any scroll breaks.

Segments recover it, because the boundary comes from the program's own operations rather than
from screen geometry. The identity question never arises.

---

## 7. The MCP surface (9 tools) — `src/mcp.ts`

Nine tools, because that is the smallest set an agent can drive a terminal with. **The rest
of interaction — the pending prompt, large pastes — goes on top of these rather than beside
them, and is deliberately not here yet.** (L3.6: target ~20 tools, not 100; every tool
definition is context the agent pays for on every turn.)

| Tool | What it does |
|---|---|
| `open_session` | Start a session. `{command?, args?, cwd?, cols?, rows?}` → `{sessionId, cols, rows, pid}`. Defaults to a platform shell. |
| `send_input` | Write text as if typed. `{sessionId, text, submit?}` — `submit` appends a newline. Reports `written` (escaped bytes). |
| `send_sequence` | Write several inputs in **one write**: steps of `{text}`, `{key}` or `{byte}`, in order. Reports `written` and per-step bytes. |
| `wait_for_idle` | `{sessionId, idleMs, timeoutMs}` → reason: `idle` \| `exited` \| `timeout`. |
| `wait_for_output` | `{sessionId, pattern, surface?, sinceByte?, timeoutMs}` → reason: `matched` \| `exited` \| `timeout`, plus `match` `{surface, text, atByte, row, buffer}`. **On a non-match, `screen` carries the rows** it ended on. |
| `wait_for_group` | `{sessionId, sinceSeq?, timeoutMs}` → reason: `group` \| `disposed` \| `exited` \| `timeout`. See below. |
| `read_screen` | `{sessionId}` → `screen`, `segments`, `text`, `collapsed`, `io`, `state`. `update: null` when nothing has arrived yet. |
| `history_read` | Address the timeline. `{sessionId, from?, to?, limit?, level?, screen?}` — see below. |
| `close_session` | End the session, kill the process tree. **History stays readable afterwards** — closing is not forgetting. |

### `wait_for_group` — the wait a TUI needs

The third wait, and the one a full-screen program needs. `wait_for_idle` is **negative** —
nothing arrived for a while — so it returns whether or not anything actually happened, and it
cannot tell a program that is thinking from one waiting for you. `wait_for_output` is
positive but needs a pattern to anchor on, and a repainting menu has no stable text. A group
is positive and content-agnostic: it ends when the program's own act ends.

**A group boundary is inferred from silence, not declared** — `groups.ts` calls silence "a
fallback, not the truth". So this is not *more* correct than idle; it is better aimed, ending
on the unit the classifier already computes.

- **Hangs on `onUpdate`, not on the group's close.** At close time nothing exists yet: the
  detector's callback is `feed(group.bytes, group).then(deliver)`, and `feed` is async and
  queued. A waiter woken there would have to read again to see what the group was — the round
  trip that makes a wait useless.
- **`sinceSeq` is in the unified numbering**, so it composes with `history_read`. Without a
  baseline, a fast program can close a group before the wait begins and the waiter would return
  the *previous* group — output from before the input was sent.
- **Every close reason is reported, and each is a measurement of the detector**, not a claim
  about the program: `gap` = no bytes arrived for `gapMs`; `bytes` = the merged bytes reached
  `maxBytes`; `chunks` = the merged deliveries reached `maxChunks`; `flush` = a resize, an
  exit or a dispose closed it. **None of them says the program is still working or that more
  output is coming** — that is L1.2's question and has no answer at a byte interface.
- **`timeout` is the bound that always holds.** `maxBytes`/`maxChunks` are optional in
  `GroupPolicy`, so a policy without them never closes a firehose group at all.
- **`disposed`** — `dispose()` used to clear its listener lists before waking anyone, so a
  waiter was silently unsubscribed and sat out its deadline, indistinguishable from a
  timeout. `onDispose` now fires before anything is cleared.
- **A session opened without grouping still ends the wait**: with no detector there is no
  boundary to group to, so each update is a group of one and `collapsed` is `null`.

**`collapsed.grid` being `null` does not mean nothing changed.** `gridDelta` returns `null`
across a resize or a buffer switch (`delta.ts:100-101`), and `resize()` flushes the group
first — so the resize group is `reason:'flush'` with `grid:null`, the largest change there is.
It is also `null` when the only change was the cursor, which is not part of a delta at all
(`HistoryRecord.cursor`). **Three distinct meanings, one value**: no delta exists, and whether
anything happened is decided by comparing screens or reading `seq`, never by reading `grid`.

### Why `group` and not `job`

A job is a unit of *intent*, and intent is not observable here — the boundary is inferred from
silence, which `groups.ts` calls "a fallback, not the truth". Naming it a job stated as fact
what only the caller can judge.

The name is **not** neutral about packing either, and that is deliberate. A group is also a
**classification input**: `feed` classifies the whole span, and CLASSIFIER.md §9.3 measured
that where the boundary lands changes the verdict (20/23 per drawing op vs 17/23 in 64-byte
chunks). A caller who reads "group" as "just batching" will misread what the classifier was
asked. What the term stops claiming is intent, not significance.

### `history_read` — one tool over the timeline, not a pair

Paging through what happened and replaying the frames a group swallowed were going to be two
tools. They are **the same operation**: both address the timeline and ask what is there,
differing only in how wide a span and whether the screen at each point is materialized. One
tool, because two would be one timeline behind two doors.

- **`from` / `to` take any address** — a token (including `next` from a previous read), `{seq}`,
  `{at}` (ms) or `{byte}`. The two ends need not be the same kind. This is the fix for the
  asymmetry that made them look like two problems: `read` accepted only tokens, `deliveries`
  only seq numbers, while `screenAt`/`textSince`/`tokenAt` already accepted all four.
- **`level`** picks the projection: `records` (default — the deliveries as recorded), `groups`
  (the units the agent was shown, with verdicts), or `text` (plain lines).
- **`screen: true`** materializes the screen at each record. This is what separates a page from
  a playback, and it is one boolean rather than a second tool.
- **`to` reads a span and may cross a resize**; `from` alone pages and never does, stopping at
  the epoch boundary. Every result reports `epoch` — the grid size its records were produced at.
- Returns `next` (resume), `truncated` (the limit stopped the read), `stoppedAtEpochEnd`.

This is what makes **`collapsed.intermediates`** actionable: `read_screen` reports that states
existed and were not shown; read the group's span (`from: {seq: rawFrom}, to: {seq: rawTo}`) with
`screen: true` and they come back. Before this, that field was a warning with no handle.

An address means **"at or before"**, the resolution limit `locate` documents — seeking to a time
or byte gives the last recorded state at or before it. Span *bounds* clamp into the recorded
range instead (a span opened before the first record starts at the beginning), because there the
nearest record inside is the answer and returning nothing would silently narrow the request.

### Typed errors (L1.5)

`no_session`, `not_live` (process exited), `bad_input` (unknown key name, a step with two fields
or none, empty batch, byte outside the range ConPTY carries, a malformed history token, a span
asked for at the `groups` level), `bad_pattern` (regex did not compile). Failures carry
`isError: true` and `structuredContent.error.code` — a caller branches on the code; the message
is for a human.

### `present()` — the shape of one update

```
{ seq, group, screen: string[], segments: [{kind, fromByte, toByte, erased, overwrote,
    reachedBack, scrolledBy, altScreen}], text: string[], collapsed, io }
```

**`seq` is the number of the state being shown** — one number for the whole timeline,
incremented once per raw delivery, and the same one `history_read` addresses with. A group
that swallowed states 3..9 reports `seq: 9`, and 3..9 come back with
`history_read({from:{seq:3}, to:{seq:9}, screen:true})`. A group is a projection over a run
of these and occupies no number of its own, so the sequence never skips.

**`group` is different, and the difference is the point.** A group's number is what
`history.groups()` reports and what every record in its span shares; `seq` is the single
state the update ended at. Joining the two is the mistake to avoid: a group spanning 1..4
has `seq: 4`, so matching its records against `seq` matches only the last one.

### Transports — how to run it

```bash
npm run mcp         # stdio   (scripts/mcp-stdio.ts)
npm run mcp:http    # Streamable HTTP on 127.0.0.1:8787/mcp  (scripts/mcp-http.ts)
npm run mcp:dev     # the same, under `tsx watch` — a restart IS the reload
```

**Why HTTP exists:** a stdio server is spawned by the client and never reconnected, so its
process holds the modules it imported for the life of the session. An HTTP server is *remote* to
Claude Code, and remote servers are reconnected automatically. So under `tsx watch`, editing any
file restarts the process, the client reconnects, and no code of ours has to know. **The cost:
editing `classify.ts` kills the terminals you had open.** Stateless by design — session state
lives in the process-wide `SessionHost`, so a restart needs no negotiation. Bound to loopback
with DNS-rebinding protection; **changing that default is a change to the safety posture
(GOAL.md L3.5), not a networking tweak.** Override with `AGENT_TERM_PORT` / `AGENT_TERM_HOST`.

`.mcp.json` already points the project at its own server (`http://127.0.0.1:8787/mcp`).

---

## 8. Sessions: waiting, state, and the honesty rules

### `waitForIdle` — bounded, and it reports which reason stopped it

Resolves on **observation** — a byte arriving, a feed finishing, an exit — never on a step the
caller invented. Returns `{reason, state, waitedMs}` where reason ∈ `idle` \| `exited` \| `timeout`.

**There is deliberately NO `settled`.** Whether a live program will produce more output is not
provable at a byte interface: it may emit at any future moment for reasons entirely internal to
it — a timer, a network reply, a background job — and the only event that closes the set is
termination. A state claiming otherwise would be **a judgement dressed as an observation**. What
is reported is the measurement; what it means is the caller's call, and the caller is the one
that knows what it is driving.

**Idle is measured from the last BYTE, not the last delivery.** A firehose never pauses, so no
delivery completes for seconds at a time; idle measured from a delivery would call a firehose
idle while it floods output. Measured: that mistake reads "idle for 2560ms" about a program
flooding output.

**`exit` is the pty's own fact, not the queued notification.** `TerminalSession` deliberately
queues its exit notification behind the feed so a caller is never told "it exited" while an
update is in flight. A state built on the queued notification could never report *exit, more to
read* — the state would be unreachable and the window it exists to describe invisible.

### `SessionState`

```
{ running: boolean, idleMs: number | null, drained: boolean | null,
  bytesPending: number | null, exit: PtyExitInfo | null }
```

- **exit, more to read** vs **exit, drained** — the window between them is the dangerous one: a
  read taken there is missing its tail with nothing left to correct it.
- **`null` means not knowable; it NEVER means zero.** Conflating the two is the root cause of a
  whole class of interaction bugs (L1.3). `idleMs` is `null` before the first byte.
  `bytesPending` is `null` when not grouping.
- `bytesPending` was a hardcoded `0` for a while, which made "nothing is pending"
  **unfalsifiable**. It is now `bytesRead` minus what the parser has finished with — and
  deliberately *not* `screen.ops.bytesFed`, which is counted *before* the write because op
  handlers run during it and their offsets must already include the bytes that produced them.

### `waitForOutput` — a positive observation, so no interval to guess

Resolves when a regex appears, or on `exited` / `timeout`. **Unlike idle, a match needs no quiet
period**, so there is no interval to guess — which is what collapses wait-then-read-then-eyeball
into one call.

- Matched against **screen rows the session *wrote*** and **completed lines it emitted**
  (`surface: 'screen' | 'text' | 'both'`, default both). Two sinks because they hold different
  things: a prompt sits on the row the cursor is still writing, so it is *never* a completed
  line; a line that scrolled out of the viewport exists *only* in the text log.
- **"Appeared" is formalised, not approximated.** Comparing text would call a scrolled prompt
  new; comparing sets would miss a prompt arriving after a screenful moves the old one. The
  delivery's **runs** decide instead: a scroll is `scrollBy`, and the runs are content genuinely
  written, so a per-row byte watermark tells a row that appeared from one that merely moved.
- The baseline is a byte watermark defaulting to `pty.lastInputByte` (the last input), so a
  prompt already on screen cannot match the instant a wait begins — the wait therefore asks "did
  the program *react* to what I typed?" rather than "is this string somewhere on screen?".
- Trailing blanks are stripped before matching: a prompt printed as `"$ "` is a row whose content
  is `"$"`. **Anchor with `^...$` to mean a whole line.**
- **The terminal echoes what is typed.** The echo is new output and carries your own words. A
  match is an observation, not evidence the program has finished.

### Keys (`src/keys.ts`) — name the key, never hand-craft escape bytes

`{key: "down"}` sends what an arrow sends. **The caller never puts a raw escape sequence on the
wire**, which is exactly what a transport between an agent and this server silently drops: one
recorded driving run sent `\x1b[B`, the ESC did not survive, and the program received the inert
text `[B` (`feedbacks/1.txt` — three inputs lost).

- Known keys: `up down left right home end insert delete pgup pgdn f1..f12 tab shift+tab enter
  backspace esc space ctrl+a..ctrl+z ctrl+\ ctrl+] ctrl+^ ctrl+_ alt+<char>`. Names are read
  loosely — `Arrow-Down` and `ARROWDOWN` both work.
- A key is encoded from **the mode the program has set, read off the screen**, so `down` is
  `CSI B` in a shell and `SS3 B` under application cursor keys. Where the emulator sends SS3
  regardless of DECCKM (F1–F4) the entry has no `app` form — offering a mode-dependent variant
  that no terminal actually sends would be a fabrication.
- `{byte: 27}` / `{byte: "0x1b"}` is the escape hatch for a byte no key names, `0x01`–`0x7f`.
  Below `0x01` or above `0x7f` is refused, and the error says why: ConPTY carries input as UTF-8,
  so `0x00` is dropped and `0x80`–`0xff` arrive as U+FFFD. Both were measured. Use `{text}`
  for a non-ASCII character.
- **Ctrl-C is a keystroke, not a kill**: `{key: "ctrl+c"}` writes `0x03`, so the line discipline
  raises SIGINT for a cooked program and a raw-mode program receives the byte — what a keyboard
  does.
- Several steps compose into **one write, in order** — nothing can arrive between the parts of a
  key sequence.
- **Nothing waits inside a batch.** It is a sequence of writes at one instant, not a script with
  reactions. A batch that waited between steps would be the scripted-recipes non-goal wearing a
  different hat.
- Both send tools report `written`: the bytes actually handed to the terminal, escaped
  (`\x1bOB`). That is what makes a degraded keystroke visible without reading the screen.

### Interaction caveats (measured, not guessed)

- **A program that never enables raw input receives nothing until a line ending arrives.** A
  child that has not called `setRawMode` is line-buffered, so keystrokes written into it sit in
  the line discipline unseen. If a program ignores a key its own docs say it should accept, that
  is a fact about the program — say so rather than retrying.
- **A key whose bytes depend on a mode the program set but has not yet printed** can still get
  the wrong byte. Wait for output from the program before sending keys; the result's `modes`
  field tells you which mode the encoding used.
- **The executable is spawned as given: there is no PATH or PATHEXT resolution.** If a script
  wrapper is not launching, name the file the platform actually executes (`foo.cmd` on Windows)
  or give an absolute path.

---

## 9. History (L0.3) — the timeline

### The shape

One append-only timeline per session, split into **epochs** at each resize. Each epoch holds an
ordered list of **records**, and a record is one **delivery**:

| Field | What it is |
|---|---|
| `seq`, `group`, `at`, `fromByte`, `toByte` | where the delivery sits, and which group it was in |
| `text` | the completed lines this delivery produced |
| `scrolledRows` | how far the emulator reports content moved |
| `cursor`, `buffer` | where the terminal was left |
| `grid` **or** `keyframe` | how to get this screen from the previous one |

**What is deliberately absent is a verdict.** The stream records what happened; the
writing/drawing distinction is read off the screen, so it is computed where it is needed rather
than stored beside the frames it was taken from — **storing it would be a second opinion that
could drift.**

### A group is a projection, never stored

`SessionHistory.groups()` groups deliveries by `group`, classifies from the screen before the first
to the screen after the last, and reports how many deliveries it stands for. **Nothing is stored
per group**, so a projection cannot disagree with the stream it came from, and it can be recomputed
at a different granularity without re-recording anything. Verified: the projection reproduces
both the screen *and* the verdicts the live session reached.

What was stored instead used to be the group records themselves, at whatever granularity the
session happened to deliver at — which made the delivery policy part of the record.

### A resize is a boundary

> A resize **freezes** the history produced before it. A query against that history reports the
> grid size in effect where it was produced. After a resize, history is new. **Nothing is ever
> reflowed.**

Inside one epoch the width is fixed, so a row-run delta means one thing and a captured line's
wrapping is unambiguous. Across a resize neither is true. Freezing is free: every stored screen
is already a deep copy carrying its own `cols`/`rows`, so epochs are an *index* over an
already-frozen log.

- **A page never spans an epoch boundary.** Every page reports `epoch.cols`/`epoch.rows` and
  stops at the boundary with `stoppedAtEpochEnd`.
- **Epochs are derived from the records, not trusted to an event.** `resize()` mutates buffers
  in place and applies synchronously, while its notification is queued behind deliveries already
  in flight — so a delivery queued before a resize and run after it reports the **new** size,
  *ahead* of the boundary. Hence: an epoch splits whenever a record arrives whose size differs,
  and the notification covers only what a record cannot (a resize that produced no output).

### Deltas and keyframes

A full screen per draw is the wrong shape: 120×40 at 60fps is ~17 MB/minute for changes that are
usually a few cells. So a screen change is stored as `{scrollBy, runs, rows}` — **shift-then-write**,
not a shift alone, because within one delivery a program writes at the cursor *first* and the
scroll happens *after*.

- A **keyframe** is stored when a delta would not have been smaller (a wholesale repaint), and
  always at the start of an epoch, so every epoch is self-contained.
- **Appearance travels beside the text**, as a per-row payload (colours are runs over *columns*;
  glyphs are indexed one at a time and are what decide where the wide columns are). `screen.ts`
  owns both coordinates.
- **The trap that fails silently:** a repaint that changes **only colour** leaves every glyph
  identical, so a text-only encoder finds nothing changed, returns an empty delta at zero cost —
  and the zero-cost answer short-circuits the shift search, so the recolour is gone while the
  keyframe beside it still looks perfectly correct. **Cost therefore counts the appearance
  payload, and the verifier compares appearance exactly as it compares glyphs.**
- **The shift is searched and verified, not read from the emulator.** `IBuffer.baseY` is exact
  until the scrollback ring saturates, then **freezes outright** (measured: stuck at 10 in a
  10-line scrollback) while content keeps moving; `IMarker.line` tracks *eviction*, not scroll.
  `gridDelta` tries the caller's viewport delta first, falls back to searching every shift in
  `[0, rows)`, and **accepts a shift only if applying the result reproduces the after-screen
  exactly.** A free parameter with a verifier is not a heuristic — a wrong shift cannot be
  returned. The shift returned need not be the one the terminal performed (a 5-line scroll across
  a small grid is cheaper as `scrollBy=1` plus four runs); that is safe because **every delta is
  computed against the real screen, never against a reconstruction.**
- Measured: a checkpoint plus deltas is **2% of a grid per delivery** at 120×40 on a scrolling log.

### The text log is the other sink, and it is L0 not L1

The grid holds the *viewport*, so a build log that overflows scrollback leaves no record of most
of itself, and "page back to any earlier part of that build" is unsatisfiable from the grid
alone.

A line is **triggered** by a per-line signal (a linefeed, or the cursor leaving a row) and
**judged** by the row diff of the feed carrying it: content arriving where there was none is
text; an erase or an overwrite is a repaint and is dropped. It is append-only and never
de-duplicated — a build log repeating "Compiling foo" is the common case, and a set-like log
loses exactly the repetition that says how far the build got.

### Seeking

By **opaque token** (`h1.<epoch>.<record>`), never an integer index, so retention can change
what a position means underneath without breaking a caller holding one. A token is itself a
valid address, so `page.next` is passed straight back in. A delivery swallowed by a group is
addressable the same way — `deliveries(from, to)` takes the `seq` range the group reports.
**A seek resolves to the record at or before the point asked for** — delivery granularity is the
resolution limit and nothing invents precision beyond it.

**Reads do not replay.** Reconstruction materializes the nearest keyframe at or before the
address, then applies the deltas after it. It never re-feeds a drawn grid: `translateToString`
cannot distinguish an auto-wrapped row from a `CUP`-positioned one, so re-feeding a TUI's grid
can re-wrap a row that was never wrapped — and simulating line discipline ourselves would be a
second emulator, which "one parser, one truth" forbids.

---

## 10. The corpus — the regression suite (`corpus/`)

23 programmes, each recorded twice (`direct` and through a real ConPTY), 46 committed traces.
**The corpus is the regression suite and it was built before the classifier, so that the
classifier has something to be wrong about.** Nothing in `corpus/` classifies anything.

| Family | Count | Covers |
|---|---|---|
| `basic` | 7 | One behaviour each: append, append-under-scroll, in-place repaint, `\r`-overwrite, append on the alt screen, spinner, clear-and-redraw |
| `cli` | 7 | Shapes of real programs: progress bar, REPL, pager, selector, build log, confirm prompt, dashboard |
| `complex` | 9 | Combinations that break plausible designs: shell→TUI→shell, interleaved log+status, resize during a TUI, resize epochs, firehose, the §4 progress-bar disproof, synchronized output, alt-write-then-draw, unclean TUI exit |

Programmes are **hand-written** (`corpus/programmes/`) rather than recorded from `vim` — a trace
has to be deterministic and need nothing installed — but each reproduces the observable
behaviour of a real program.

**Two feeds.** `direct` = the programme's bytes captured then fed to the emulator: deterministic
byte offsets, so an expectation range means something. `pty` = the programme runs as a child in a
real node-pty session: what a real session sees, including ConPTY's rewriting. **Validate logic
against `direct`; use `pty` to check that reality does not diverge.**

Recording goes through the repo's own `ScreenModel`, so the op stream, byte offsets and screen
state in a trace are exactly what a live session produces — **a replayed trace is not meeting a
different parser than the server uses.** Every recorded op handler returns `false`, so the
emulator still applies the sequence and we only watch it: **ops are observed, not consumed.**

**Every expectation carries a `why`.** That is the point: a case earns its place by killing a
plausible wrong design, and the `why` says which. A programme whose `why` could be deleted
without loss is not worth adding.

### Commands

```bash
npm install
npm run typecheck     # src, test, scripts, corpus, fixtures — one project
npm run test          # 232 tests (includes corpus/test/corpus.test.ts)
npm run smoke         # end-to-end against a real shell
npm run corpus        # score the classifier across replay granularities

# corpus only (from corpus/)
npx tsx scripts/record.ts --feed both     # re-record both feeds
npx tsx scripts/record.ts --only cli.     # one family
npx tsx scripts/record.ts --print         # per-trace summary + final screen
```

### §11 — READ THIS BEFORE ADDING OR "FIXING" AN EXPECTATION

Three rules, learned the hard way by doing it the other way first.

**1. Comprehensible first.** The classifier's job is to **present the terminal in a
comprehensible way** — to say what a human at the screen would say. That is the specification.
It is *not* "produce the verdict a label says". **Nobody specified the labels.** They were
written by hand, alongside the code, mostly after it. An expectation saying "this span is
`drawing`" where the screen shows a blank row gaining text is a claim about the *program's
intent*, not about anything visible. Optimising against such a label makes the classifier worse
in a way that looks like progress, **because the number goes up.** It did go up, repeatedly, and
every increase was fitted: a second verdict field added so a mixed burst could pass, a `CUP`
suppressed because it measured better, a group boundary adopted because it netted +1. None were
asked for. All are gone now.

**2. The code reflects the model.** When code and model disagree, the code is wrong — including
when the code passes its tests. `src/classify.ts` should read like §3.1. If a change needs a new
special case to keep a label satisfied, that is the model telling you the code took a wrong turn.

**3. Tests check the code, not the semantics.** A test may assert the code is correct; it may
not assert that a *verdict is right*, because the verdict is the thing under test. What that
leaves:
- **Exactness** — applying what was reported reproduces the screen. Exhaustive across every
  delivery of every direct trace (`test/history-corpus.test.ts`). **The strongest test in the
  repo, and it does not mention verdicts at all.**
- **Completeness and order** — every byte accounted for, segments in time order.
- **Observation checked against the frames** — "replaced in place" really was a replacement.
- **Structural invariants** — a group does not straddle a resize or an alt-screen switch; a
  segment's range is well-formed; the collapsed count is honest.

**The pinned scores are measurements, not a specification.** They are printed because a drop
means the algorithm moved, and pinned so a regression fails loudly. **A rise is not automatically
progress and a fall is not automatically a bug** — when the verdict stopped reading the op
stream, `drawOps` went 21 → 20 and that was the change *working*. Where an expectation encodes a
semantic judgement rather than an observation, **delete it**. Two have been, and three more were
deleted to reach 23/23 (`progress-bar-scroll`, `interleaved`, `progress-bar`) — each asserting a
single verdict over a span the screen shows two kinds on.

---

## 11. Current status (verified — update this block after every job)

**Verified by real runs in this session:**

- `npm run typecheck` — **clean, exit 0**.
- `npm test` — **232 tests**, pinned to `--test-concurrency=2` (a real pty per test
  file; running them all at once corrupts the heap under node-pty).
- Corpus subset alone (`corpus/test/corpus.test.ts`) — **39 tests, 39 pass**.
- `npm run corpus` — see the table below.
- Git: branch `main`, HEAD `e7828f9` *"docs: close the cursor question, and consolidate the
  backlog"*. Working tree **clean**; no stashes.
- The last four commits added `send_sequence` + named keys, `history_read` (one tool over the
  timeline), the unified sequence number, `wait_for_group`, and a screen on failed waits.
- Environment: Node v22.23.2, Windows 11.

### Verified classifier scores (`npm run corpus`, `direct` traces)

| Replay granularity | Score | Failing |
|---|---|---|
| **group-aligned (gap 50ms)** — *the mode the server actually delivers in; the number to watch* | **23/23** | — |
| op-aligned (one delivery per drawing op) | 20/23 | `cli.menu-selector`, `complex.interleaved`, `complex.resize-during-tui` |
| fixed 64-byte chunks | 17/23 | `basic.clear-redraw`, `basic.cr-overwrite`, `basic.in-place-repaint`, `complex.alt-write-then-draw`, `complex.interleaved`, `complex.resize-during-tui` |
| fixed 256-byte chunks | 12/23 | `basic.clear-redraw`, `basic.cr-overwrite`, `basic.in-place-repaint`, `basic.spinner`, `cli.dashboard`, `cli.menu-selector`, `cli.pager`, `complex.alt-write-then-draw`, `complex.resize-during-tui`, `complex.shell-tui-shell`, `complex.synchronized-output` |
| whole trace as one delivery | 11/23 | the above plus `complex.resize-epochs` |

Pins live in `test/corpus.test.ts` `EXPECTED = { drawOps: 20, pty64: 17, groups: 23 }`. The scored
numbers use **`direct` traces only**, because expectations are byte ranges from the programme's
own marks and ConPTY rewrites the bytes.

**All 46 traces** (both feeds) carry the checks that need no labels: every trace replays to the
frames it recorded, and every one reconstructs exactly through the timeline, keyframe plus
deltas. Those run on the pty half too — the feed where things actually go wrong.

### What is built

- **L0 complete**: L0.1–L0.5. Real pty → faithful screen model → edit record → text log →
  classification → session → registry. `host.ts` composes session + recording in one call.
- **L1 partly built**: named keys + composed batches (`send_sequence`, `src/keys.ts`);
  `waitForIdle`; `waitForOutput`; real `bytesPending`; `SessionState`.
- **A first MCP surface** (9 tools). A spike: **the pending prompt and large pastes are not on
  it yet.** History paging and intermediate playback *are* — as one `history_read`.

### What is NOT built

- L1.4 large pastes and a composed write-wait-respond call; L1.5 honest errors beyond the four
  coded ones. **The pending prompt is not one of these — it is not implementable.** Measured:
  process state, child presence, echo probing and the node-pty API all fail to distinguish a
  shell at a prompt from one busy on a builtin. What shipped instead is objective:
  `state.inputUnconsumed` (a byte count) and `wait_for_group().afterInput` (placement).
- (L1.1 is built: split in `GOAL.md` into 1.1a continuity, 1.1b the feed is bounded, 1.1c
  retrieval is bounded. One number over three obligations at different stages of done was why
  this list could never say whether it was finished.)
- L3.4 retention and durability.
- All of L2.

### Open questions (all L3 — implementation choices that cannot constrain L0–L2)

1. Update delivery — push, pull, or both (L3.2).
2. Retention and durability — how much, how long, across restarts or not (L3.4).
3. Human input handoff — read-only only, or explicit keyboard handoff, and how signalled (L3.3).
4. ~~Ambiguity handling~~ — **answered in CLASSIFIER.md §3.5**: never ask, never guess, never
   report doubt either. Suspicion is volume.
5. Safety floor — what ships by default (L3.5).
6. Optional representations (PNG/HTML) — whether they ship at all, given native-dependency cost.

**Remaining open item that is NOT L3 (the biggest one):** delivery granularity. Where a window
opens decides whether an overwrite is visible at all, so **coalescing is a classification input,
not merely a delivery policy** — which is why `groups.ts` lives in `src/` and why grouping is on by
default. Unresolved: whether a session should feed per-op, per-chunk, or adaptively (adaptively
has a concrete form: what `groups.ts` does). The gap threshold is a **policy with a principled
range, not a tuned number**: anything from 20ms to 70ms separates the corpus's two pauses (6ms
within an act, 80–120ms between acts) and scores identically across that range; 50ms sits in the
middle. What sets the range is human legibility — faster and no one could read the intermediate
state anyway.

---

## 12. Platform facts — verified on this machine, do not re-derive

Probed on Windows 11, node-pty 1.1.0, `@xterm/headless` 6.0.0, node 22.23.2 (corpus suite also
passes on 24.18.0). **Re-probe rather than trusting these if a version moves.**

### ConPTY rewrites escape sequences — the big one

On Windows the bytes coming out of the pty are **not** the bytes the programme wrote.

| Written | Survives? |
|---|---|
| `\x1b[?1049h` / `\x1b[?1049l` (alt screen) | yes |
| `\x1b[2J` (ED), `\x1b[5;3H` (CUP), `\x1b[?2026h` (sync output), `\x1b[K` (EL) | yes |
| `\x1b[2K`, `\x1b[2A`, `\x1b[2L`, `\x1b[2M`, `\x1b[3P`, `\x1b7` | **no** |
| `\x1b[31m` (SGR) | **no** |

**Consequence:** a `\r`-overwrite case may lose its erase op before the emulator ever sees it.
`basic.cr-overwrite` is the probe — a redraw with *no* erase op, which the screen model must
catch. **Never assert on raw escape bytes in a pty-fed test**; assert on the emulator's op stream
and screen.

### Other verified facts

- **ConPTY injects no erase ops on plain output** (five plain lines → 5 CRLFs, zero `\x1b[K`),
  so "writing" is safe to detect on Windows.
- **ConPTY prepends its own handshake**: `\x1b[?9001h\x1b[?1004h`, an `\x1b[2J`, and an OSC title
  change, before any programme output. A classifier treating the first frames as programme
  behaviour sees a spurious full-screen clear at the start of every session.
- **`encoding: null` still delivers strings on Windows.** node-pty hands back a **string**
  regardless (`Buffer.isBuffer(chunk) === false`); `pty.ts` coerces with `Buffer.from(chunk,
  'utf8')` so byte counts are right. On POSIX the same path receives a Buffer. **Do not assume a
  Buffer in either direction.**
- **`terminal.write()` is asynchronous** — the buffer reflects the change only after the callback
  fires. A same-tick read sees the pre-write grid. The recorder awaits every write.
- **The alt buffer has no scrollback** — `length` stays pinned at `rows`.
- **`buffer` is proposed API** and throws unless `allowProposedApi: true` (handled in
  `src/xterm.ts`).
- **`registerCsiHandler` takes a single-byte `final`.** A two-byte final (` q`, cursor style)
  throws. `ESC 7` / `ESC 8` go through `registerEscHandler`, not CSI.
- **`io.mark()` works only in `direct` mode**; in pty mode `runPty` recovers mark names by
  finding them in emitted text, so expectations degrade to approximations.
- **Node's test runner on Windows prints `AttachConsole failed`** from
  `node-pty/src/conpty_console_list_agent.ts` during `npm test`. **This is noise, not a
  failure** — the run still reports `pass 213 / fail 0`.

---

## 13. Conventions an agent must follow here

### Commit messages

The history reads as a series of *reasons*, not changelog entries. Format:
`<type>: <what changed, phrased as the reason it changed>`, where type ∈
`feat | fix | refactor | test | docs | chore | perf`. Real examples from this repo:

```
feat: a wait for a pattern, so a prompt is not read off the screen by eye
fix: bytesPending was a hardcoded zero, which nothing could falsify
refactor: the stream is the record, and a group is a projection over it
perf: intermediates are a checkpoint plus deltas, not a grid each
fix: the last corpus expectation a single verdict could not express
docs: the docs described a classifier that no longer exists
test: run the pty half of the corpus, which nothing read
```

The body states the problem, why the obvious alternative was wrong, and what was measured.

### Code style

- **Comments state why, never what.** Nearly every module opens with a long header comment
  explaining the failure it prevents. Match that register.
- **Strict TypeScript**, `noUncheckedIndexedAccess: true`. No `any` creeping in.
- **Unknown is `null`, never `0`.** This is load-bearing, not stylistic (GOAL.md L1.3).
- **Policy numbers arrive by injection or from one named constant**, never baked into a
  mechanism. Clocks and schedulers are injected so tests advance time rather than sleeping.
- **No thresholds in the classifier.** If you need one, the test is wrong.

### Comments and language

Source, docs and commits are in English. The user works on DeltaForce (a UE4 project) by day but
this repo is English throughout.

---

## 14. Pitfalls — the ones that cost real time

1. **Reading the screen straight after a send returns the state from *before* the send.**
   Always wait (`wait_for_idle` or `wait_for_output`), then read. This is the most common way a
   driver silently accomplishes nothing.
2. **Never hand-craft an escape sequence as text.** A raw `ESC` typed as text is exactly what a
   transport drops. Use `{key}`; use `{byte}` only if no key names it; use `{text}` for
   non-ASCII. Always compare the reported `written` against what you meant.
3. **Treating a timeout as idle** is how a driver reports success at nothing. Always branch on
   `reason`.
4. **A prompt already on screen will match `wait_for_output` instantly** — unless you rely on
   the default baseline (last input byte) or anchor the pattern.
5. **Do not optimise the corpus score.** Fit to a hand-written label and the number goes up
   while the classifier gets worse (§10, rule 1).
6. **A colour-only repaint is invisible to a text-only encoder.** Cost must count the appearance
   payload, or the recolour vanishes while the keyframe beside it looks correct.
7. **`baseY` freezes when scrollback saturates.** Do not read the shift from the emulator; search
   and verify.
8. **Do not reflow history across a resize.** Freeze; report each epoch at its own size.
9. **Do not store a verdict in history.** Compute it where it is needed; a stored verdict is a
   second opinion that can drift.
10. **Do not re-feed a drawn grid to reconstruct.** `translateToString` cannot tell an
    auto-wrapped row from a `CUP`-positioned one.
11. **Do not let a batch wait between steps.** That is the scripted-recipes non-goal.
12. **Editing any file under `tsx watch` kills the open terminals** (the HTTP transport's
    deliberate cost). Restart is the reload mechanism.
13. **`send_input` to a program that has not called `setRawMode`** goes into the line discipline
    unseen until a line ending arrives. That is a fact about the program, not a bug to retry.
14. **`npx` — and any shim script — will not spawn.** The executable is spawned as given,
    with no `PATH`/`PATHEXT` resolution, and the `npx` on `PATH` is a 197-byte shell script
    on this machine. It fails with `Cannot create process, error code: 2`. Give the absolute
    path to `npx.cmd` (wherever node is installed).

---

## 15. `fixtures/life` — the lifelike subject (black-box driving exercise)

An interactive program that behaves like a real one, used to exercise agent-term against
something that actually reacts. Launch with `npx tsx fixtures/life/index.ts` from the repo root.

- **The input text is ignored.** The subject tests whether the driver *waits*, not whether it can
  compose a command.
- **The prompt is printed only when the subject is idle.** While it works there is no prompt and
  no progress output — just silence, occasionally for 20 seconds. That is the entire signal.
  Gaps: 85% are 300ms–5s, 15% are 5s–20s, at most one long gap per action.
- Actions: `reply` 34%, `multiline` 24%, `silent` 10%, `menu` 16%, `chat` 16%. Menu and chat are
  alt-screen modes (`@clack/prompts` for the menu; the chat is hand-rolled because a prompt
  library renders a linear flow and cannot hold a persistent frame).
- Flags: `--seed <n>` replays one exact run, `--pick <kind>` forces every action, `--speed <n>`
  divides delays (use `--speed 20` for a fast test).
- **`.claude/skills/life-drive` governs the exercise**: do not read the repository first —
  whatever you would learn by looking is precisely what the run measures. Send at least ten
  inputs, then close the session and report.

---

## 16. Where to look for what

| Question | File |
|---|---|
| Why does this project exist at all? | `GOAL.md` |
| Why is the classifier designed this way? | `CLASSIFIER.md` |
| What may a test assert? | `CLASSIFIER.md` §11 |
| How is history stored and reconstructed? | `HISTORY.md` |
| What has already been tried elsewhere? | `PRIOR-ART.md` |
| What is the current state? | `README.md` + this file §11 |
| How do I drive it as an agent? | `.claude/skills/agent-term/SKILL.md` |
| How do I run the corpus? | `corpus/OPS.md` |
| What traps does a real pty have? | `corpus/OPS.md` + this file §12 |

**Reading order for a newcomer:** `GOAL.md` → `CLASSIFIER.md` → this file → `src/types.ts` →
`src/classify.ts` → `src/session.ts` → `src/history.ts`. Then run `npm run corpus` and watch the
numbers, and read `corpus/programmes/cli.ts` to see what the classifier is being measured
against.
