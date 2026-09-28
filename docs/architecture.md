# Architecture

How a byte that a program writes reaches an agent as a reported change.

## The layering

The project is organized in concentric layers, and one rule governs them:

> **Inner layers do not depend on outer layers. Outer layers can be changed, or replaced
> entirely, without redesigning anything inside them.**

| Layer | Name | Contains |
|---|---|---|
| **L0** | Core model | Writing vs. drawing, the classification contract, the history timeline, session identity |
| **L1** | Capabilities | Interaction, bounded waiting, bounded delivery, correct observation |
| **L2** | Nice-to-have | Precision reads, mouse, escape hatches, optional representations |
| **L3** | Outer implementation | Stack, transport, viewer, retention policy, safety, packaging |

The test of a boundary is concrete: the writing/drawing model must survive swapping `node-pty`
for another pty library, swapping stdio for HTTP, dropping PNG rendering, or rewriting the
human viewer. **If a change to an outer layer would force an inner layer to change, the boundary
is drawn wrong.**

**The practical consequence is about numbers.** A timeout, a byte cap, a transport detail is
policy, and policy is L1/L3. It never appears as a constant inside L0; it arrives by injection
or as a policy object. This is why `src/groups.ts` takes a clock and a scheduler as arguments,
why `DEFAULT_GROUP_POLICY` lives in exactly one place, and why `SessionOptions.clock` is
injected rather than read from `Date.now()` — a test advances time instead of sleeping
through it.

## Module map

`src/` is the implementation. Each file states, in its header, the design reason it exists and
the failure it prevents; read that before editing one.

| Module | Layer | Responsibility |
|---|---|---|
| `pty.ts` | L0 | One hosted terminal: a real pty with a process tree inside. Moves bytes, resizes, reports exit. It deliberately does not interpret bytes. |
| `xterm.ts` | L0 | The single chokepoint for `@xterm/headless`, so the emulator dependency has exactly one home. |
| `screen.ts` | L0 | The cell grid. One emulator per session is the authority for what a human at that terminal would see. |
| `edit-record.ts` | L0 | The op stream: a second *view* of the same parser, supplying segment boundaries and replay. |
| `text-log.ts` | L0 | The append-only log of completed lines — the sink the grid cannot be, because a bounded scrollback cannot hold a 10k-line build. |
| `classify.ts` | L0 | The verdict: writing or drawing, read off the screen. |
| `delta.ts` | L0 | Grid deltas: a shift plus written runs, or nothing. |
| `history.ts` | L0 | The timeline: epochs, records, addresses, and the projections read from them. |
| `groups.ts` | L1 | Group boundaries — where one run of output ends and the next begins. |
| `session.ts` | L0/L1 | A hosted session: pty + screen model + classifier as one object, plus the three waits. |
| `registry.ts` | L1 | The set of live sessions. Server-generated, unguessable ids. |
| `host.ts` | L1 | The composition root: a session and its recording, started in one call. |
| `keys.ts` | L1 | Named keys and the batch a caller composes out of them. Imports nothing. |
| `match.ts` | L1 | Matching a pattern against the two sinks. |
| `mcp.ts` | L3 | The MCP tool surface. |
| `types.ts` | — | Shared option types and grid validation. |
| `env.ts` | L3 | Environment sanitising and the default shell. |

Everything above `screen.ts` reads cells from the emulator. **Nothing above `screen.ts`
re-parses bytes** — a second reading of the byte stream would be a second VT parser that can
disagree with the first one.

## The pipeline

```
node-pty ──bytes──▶ PtySession            raw Buffer chunks, monotonic byte counters
                        │
                        ▼
                 GroupDetector            closes a group on silence, a cap, or a flush
                        │
                        ▼
                 ScreenModel.feed         ── the single witness
                   ├─ EditRecord          op stream, in order, stamped with byte offsets
                   ├─ TextLog             completed lines, append-only
                   ├─ await terminal.write(...)
                   └─ snapshot before/after, takeScrolledRows(), judge pending lines
                        │
                        ▼
                   classify                one segment per delivery
                        │
                        ▼
                 TerminalSession          Delivery per raw delivery; SessionUpdate per act
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
   SessionHistory                   mcp.ts
```

### `PtySession` — the substrate

It owns the pty and nothing else. Two decisions matter structurally:

- **`data` is bytes, never a decoded string.** The session spawns with `encoding: null` so the
  byte watermarks stay exact; a decoded string miscounts bytes for non-ASCII output.
- **There is exactly one write path.** `write()` stamps the input watermark, increments the
  written counter, and emits `input` *before* handing bytes to the pty, so no caller can write
  without the stamp. The read and write counters are strictly monotonic and never reset.

`exitCode` and `signal` are the pty's own nullable facts. Once the process is dead, `write`,
`resize` and `kill` are no-ops rather than queued work. `dispose()` kills the process even
after exit — ConPTY owns a worker thread that nothing else reaps.

### `ScreenModel` — the witness

`feed(bytes)` takes the before/after snapshot pair itself. That is the point: a second caller
taking its own pair would be a second witness to the same input, and could drift from this one.

Two verified properties shape it. `terminal.write()` is **asynchronous** — the grid is stale
until the callback fires — so every write is awaited. And the alternate buffer has **no
scrollback**: its content is destroyed when the program leaves it, so capturing it while live
is mandatory, not optional.

The snapshot is deliberately **plain and JSON-serializable**: it crosses the MCP boundary and
is stored in history, so it can carry no live emulator references. It holds two coordinate
systems, and reconciling them is the file's central concern:

- `lines` is **glyph** space, indexed by character — for reading and searching text.
- columns, `wide`, `cursorX` and `styles` are **column** space — a position on a screen.

They diverge by exactly the width of wide glyphs (CJK, emoji): one string index, two terminal
columns. The reconciliation is total and lives in one place, so the two mappings cannot
disagree with each other. With no wide glyphs the two coincide, and a row is exactly `cols`
characters.

`styles` carries **only non-default runs**; a column no run covers is default. Style keys are
canonical strings built in a fixed field order, so two keys for the same appearance are the
same string, and a stored screen needs no palette table kept alive.

### `EditRecord` — the op stream

The op stream supplies *where the segment boundaries are*; the screen supplies *what each
segment did*. Neither alone is enough — once a scroll has moved everything, a screen diff
cannot recover the boundaries.

It is **a second view of the same parser that produces the screen, not a second parser**:
handlers are registered on the same emulator, every one of them returns `false` ("we observe,
we do not handle"), and printable text never passes through them, so runs of text between ops
are implicit. The vocabulary is closed, and it distinguishes two kinds:

- **sequences** (`csi`, `esc`) — what the program actually sent.
- **events** (`event`) — structural responses the emulator performed: linefeed, scroll,
  resize, buffer switch, title change. No program wrote these.

Every op is stamped with the byte offset *before* it, the cursor, the active buffer, and a
timestamp, so a boundary can be located in the byte stream and in history even when a whole
coalescing window arrives at once.

**The classifier does not read this file.** The op stream is for replay, for boundary-finding,
and for suspicion — the escape hatch behind L2.

### `TextLog` — the second sink

The emulator feeds two sinks, and they are not interchangeable. The grid is a *state*; a
program emitting 10k lines overflows any bounded scrollback, so the grid cannot be the record
of what was written.

Capture is two stages, and keeping them apart is the whole design:

1. **Trigger** — when is a line complete? A per-line signal, *not* the diff, because a line can
   be born and scroll away inside one feed.
2. **Judgement** — is it text, or a repaint? The diff decides.

There are two triggers, deliberately: a linefeed, and a row the cursor left by absolute
positioning (which is how ConPTY often ends a line). They cannot double-count. Triggered lines
wait in `pending` until the judgement is available, so nothing is appended that the diff might
contradict. The log is append-only and **never de-duplicated**: two identical lines are two
lines, because a repeated `Compiling foo` is exactly how far a build got. A row the cursor is
still sitting on is not a completed line.

### `classify` — the verdict

Derived from the before/after frames and nothing else. It produces **exactly one segment per
delivery**, spanning the whole delivery: a segment cannot claim a finer range than the thing
it was measured over. See [classifier.md](classifier.md).

## The record

### Deliveries, and the update above them

The unit of truth is the **`Delivery`**: one raw delivery, parsed through the emulator, emitted
unconditionally with its sequence number, its group, its time, its byte range, the lines it
completed, the scroll it caused, its grid delta, and its full screen.

**A delivery carries no verdict.** The `writing`/`drawing` distinction is read off the screen,
so it is computed where it is needed rather than stored beside the frames it came from.
Storing it would be a second opinion that could drift.

Above it sits the `SessionUpdate` the agent is shown. Its `seq` is **the number of the state
the update ends at** — for a group, the last raw delivery it covers — so a group that swallowed
deliveries 1..7 reports 7 and everything between is still addressable. A group occupies no
number of its own, so **the sequence never skips**.

A group that arrived from many deliveries is **fed in parts as well as classified whole**: the
intermediate frames are the only place the swallowed states exist, and they cannot be recovered
from merged bytes afterwards.

### Deltas and keyframes

A record stores **either** a grid delta **or** a keyframe, never both, and the choice is made
by construction: a keyframe is stored at the first record of an epoch, and whenever the
incoming delta was `null`. A declined delta is already a whole screen in runs, so the keyframe
is no larger.

`gridDelta` returns `null` unless applying it reproduces the after-screen **exactly** — glyphs,
styles and wide columns. A wrong shift is therefore unrepresentable. A shape change or a buffer
switch is not a delta either, which is what makes a resize an epoch boundary. Cost counts
appearance, so a pure restyle cannot cost zero. The order is fixed: shift, then written runs,
then row payloads.

**The cursor is not part of a delta.** A delta describes cells; the caller overlays the record's
own cursor and buffer.

### Epochs

History is a sequence of **epochs**, one per grid size. A resize freezes everything before it,
and a read reports the size in effect where the record was produced — nothing ever reflows.
Inside an epoch the width is fixed, so a row-run delta and a wrapping are unambiguous; across a
resize neither is true. Freezing costs nothing, because a stored screen already carries its own
`cols` and `rows`.

Epochs are **derived from the records**, split whenever a record's reported size differs from
the current epoch's, rather than trusted to the resize notification — the notification is
queued behind deliveries while the resize itself is applied synchronously, so a delivery
queued before a resize and run after it would report the new size ahead of the boundary. The
notification is still needed for the resize that produced no output at all. Epoch zero is
always opened, so a session that never speaks still has a timeline *with a size*.

### Groups are a projection

The group the agent is shown is computed **on read**, never stored. A group is a maximal run of
consecutive records in one epoch sharing a group number; it is classified from the screen
*before* the first delivery to the screen *after* the last, with the scroll summed across the
span — which is what makes a repaint legible where no single delivery could show it.

Nothing per-group is persisted, so a projection cannot disagree with the stream it came from,
and it can be recomputed at a different granularity without re-recording anything. Only the
records are canonical; "what happened" and "what the agent was shown" are two projections
chosen per read.

### Addresses

A record is addressed by a token of the form `h1.<epoch>.<index>`, or by a sequence number, a
timestamp, or a byte offset. Tokens are **opaque by contract**: callers pass them back and do
not parse them, so a retention policy can change what a token means underneath without
breaking anyone. A read that crosses an epoch boundary stops at it and says so.

## Sessions

### Lifecycle

`SessionHost.open(options)` does three things in one call, because two would be one call too
many: create the session (server-generated id), start recording it, and subscribe. A history
that is merely *available* to attach is a history a caller can forget to attach; it would then
be empty rather than wrong, which surfaces much later and looks like a bug in the timeline.

`TerminalSession` wires the pty's `data` straight into the feed path in its constructor, so a
caller cannot build a session that silently never runs a classifier. Feeds are serialized: a
throwing listener cannot strand later deliveries.

Disposal ends the session — killing the process tree — but never its history. `_lastUpdate` is
nulled first, so a disposed session cannot be mistaken for one with a group waiting, and
listeners are woken at the end.

### Two stores, keyed by the same id

`SessionRegistry` owns the set of **live** sessions and nothing else. Ids are server-generated
UUIDs, never caller-supplied: a session handle is meant to be an unforgeable key, not a name
another caller can guess or collide with. It holds `TerminalSession`s rather than bare ptys,
because everything above the substrate needs the classified session.

`HistoryStore` is a separate map keyed by the same `SessionId`. That separation is what makes
"history survives the process exiting" true: dropping a live session removes it from the
registry and leaves its timeline fully readable.

### State, and what it refuses to say

Observable session state is a small closed set: whether it is running, how long it has been
idle, whether what it produced has been read through, how many bytes are pending, how many
input bytes are unconsumed, and its exit fact. The three readings the agent gets are "running,
idle for N ms", "exit, more to read", and "exit, drained".

There is deliberately **no `settled`**, and **no `atPrompt`**. Both are refused for the same
reason, stated in [design.md](design.md): a claim that a live program will not produce more
output, or that it is blocked waiting for input, is not provable at a byte interface. A field
answering either would be a judgement dressed as an observation.

Three waits are built on one skeleton, and each names only its own stopping reason, leaving
what that means to the caller — who is the one that knows what it is driving. Every wait
resolves on observation with a single deadline bound, never on a fixed step; termination ends
a wait early, because waiting longer cannot change what is observable.
