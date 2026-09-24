# HISTORY.md — AgentTerm

> L0.3: one append-only timeline per session holding everything the terminal did, seekable
> by token, by sequence, by time or by byte offset, and queryable after the process exits.

Companion to `GOAL.md` (what and why), `CLASSIFIER.md` (writing vs drawing) and `PRIOR-ART.md`
(what exists). This is the design as built, and the measurements it rests on.

Everything marked **verified** was measured against `@xterm/headless` v6.0.0 in this repo, not
inferred. The numbers come from the tests named beside them.

---

## 1. The shape

A session's history is a sequence of **epochs**, one per grid size, split wherever the size
changed. Each epoch holds an ordered, append-only list of **records**; each record is one
delivery, and carries:

| Field | What it is |
|---|---|
| `seq`, `at`, `fromByte`, `toByte` | where the delivery sits in the session |
| `segments` | the classified verdicts, in order (`CLASSIFIER.md` §2) |
| `text` | the completed lines this delivery produced |
| `cursor`, `buffer` | where the terminal was left |
| `grid` **or** `keyframe` | how to get this screen from the previous one |

Seeking is by **opaque token** (`h1.<epoch>.<record>`), never an integer index, so retention can
change what a position means underneath without breaking a caller that holds one (`GOAL.md`
L3.2). A token is itself a valid address, so `page.next` is passed straight back in.

## 2. A resize is a boundary

> A resize **freezes** the history produced before it. A query against that history reports the
> grid size that was in effect where it was produced. After a resize, history is new.

This is not bookkeeping. Inside one epoch the width is fixed, so a row-run delta means one
thing and a captured line's wrapping is unambiguous. Across a resize neither is true. Freezing
is also free: every stored screen is already a deep copy carrying its own `cols`/`rows`
(`screen.ts`), so epochs are an *index* over an already-frozen log rather than a transformation
of it. **Nothing is ever reflowed.**

Two consequences are load-bearing:

- **A page never spans an epoch boundary.** Every page reports `epoch.cols`/`epoch.rows` for the
  records it returns, and stops at the boundary with `stoppedAtEpochEnd`. A caller can page
  straight across, but never receives two grid sizes in one answer.
- **The resize destroys live state**, so the boundary has to be captured *at* the boundary.
  `resize()` mutates the buffers in place, and reflow can be disabled entirely under
  `windowsMode`/legacy conpty (typings `:223`, `:248`) — the emulator's own resize behaviour is
  platform-dependent, which is one more reason history must not depend on it.

### Epochs are derived from the records, not trusted to an event

`TerminalSession.resize()` reports a boundary, but that notification is queued behind deliveries
already in flight, while the resize applies to the screen synchronously. A delivery queued
before a resize and run after it therefore reports the **new** size, *ahead* of the boundary
that would have opened the new epoch.

So an epoch splits whenever a record arrives whose size differs from the current epoch's, and
the notification covers only what a record cannot: a resize that produced no output at all,
which must still be visible and must still freeze what came before. Both paths are tested
(`test/history.test.ts`).

## 3. What is stored: a delta or a keyframe, never both

A full screen per draw is the wrong shape. A 120×40 TUI repainting at 60fps is roughly 17
MB/minute of retained state, for changes that are usually a few cells — and `GOAL.md` calls
continuous repaint the pathological case (criterion 5).

So a screen change is stored as `{ scrollBy, runs, rows }`: the grid shifted up, then the runs
that were written, plus a per-row payload for the rows whose appearance or glyph widths changed
(§3 below). Shift-then-write, not a shift alone — within one delivery a program writes at the
cursor *first* and the scroll happens *after*, so new content lands at pre-scroll positions and
a shift-only model can never describe it. (An early attempt at whole-overlap matching found no
candidate at all; that failure is why the shape is what it is.)

A keyframe is stored when a delta would not have been smaller — a wholesale repaint — and always
at the start of an epoch, so every epoch is self-contained and a read never reaches outside it.

### Appearance travels beside the text

A delta carries what changed in **text** and in **appearance**. The text runs are glyph splices;
a row's colours and its wide-glyph columns ride as a per-row payload. They are deliberately not
merged: a row's colours are runs over *columns* while its glyphs are indexed one at a time, and
its glyphs are what decide where its wide columns are. `screen.ts` owns the two coordinates and
is the only place they are reconciled.

The trap worth naming, because it fails silently. A repaint that changes **only colour** leaves
every glyph identical, so a text-only encoder finds nothing changed, returns an empty delta at
zero cost — and the zero-cost answer short-circuits the shift search, so the recolour is gone
and the keyframe beside it still looks perfectly correct. Cost therefore counts the appearance
payload, and the verifier compares appearance exactly as it compares the glyphs.

### The shift is searched and verified, not read from the emulator
The obvious source for `scrollBy` is the emulator. It is not there:

- **`IBuffer.baseY` is exact until the scrollback ring saturates, then freezes outright** while
  content keeps moving. Measured: stuck at 10 in a 10-line scrollback.
- **`IMarker.line` tracks a line through *eviction*, not scroll.** It sits still while content
  scrolls past and decrements only as the ring drops lines, so it answers a different question.

`gridDelta` therefore tries the caller's viewport delta first (exact whenever the ring has not
saturated), falls back to searching every shift in `[0, rows)`, and **accepts a shift only if
applying the result reproduces the after-screen exactly.** A free parameter with a verifier is
not a heuristic: a wrong shift cannot be returned. At saturation — where `baseY` is useless —
the search still recovers an exact encoding, verified for scrolls of 1, 3 and 5 lines.

The shift it returns need not be the one the terminal performed. A 5-line scroll across a small
grid is cheaper as `scrollBy=1` plus four runs, and is exactly equivalent. That is safe because
every delta is computed against the *real* screen, never against a reconstruction, so an
equivalent choice cannot compound.

## 4. The text log is the other sink

`CLASSIFIER.md` §5 says the emulator feeds two sinks, and the second one is not optional: the
grid holds the *viewport*, so a build log that overflows scrollback leaves no record of most of
itself, and L0.3's "page back to any earlier part of that build" is unsatisfiable from the grid
alone.

`src/text-log.ts` captures in two stages, and keeping them apart is the design. A line is
**triggered** by a per-line signal — a linefeed, or the cursor leaving a row — and **judged**
by the row diff of the feed that carries it: content arriving where there was none is text, an
erase or an overwrite is a repaint and is dropped. Verified:

| Claim | Result |
|---|---|
| The buffer is lossy; the per-line signal is not | 200 lines into a 5-row terminal with 10 lines of scrollback: **15 kept**, **200 recovered**, distinct |
| The trigger cannot be the diff | 200 lines into a 5-row terminal: a before/after comparison of that feed sees **five** rows. The other 195 were never in any frame, so they are only recoverable from a per-line signal |
| A linefeed is not the only completion signal | Windows ConPTY ended an output line with `\x1b[7;1H` and emitted **0** linefeeds for it; the line reached the screen and not the log until the cursor-left trigger was added |
| A repaint of rows that already held content is not text | an alt-screen frame rewriting its own rows: **0** lines. The first paint onto blank rows *is* text — it is indistinguishable from appending, and the agent sees the full draw either way |
| A program that *writes* on the alt screen does | 2 lines captured, and that content is destroyed on exit — so the sink records both buffers and stamps which one. L0.1's corollary is that the alt screen is not a verdict |

It is append-only and never de-duplicated: two identical lines are two lines. A build log
repeating "Compiling foo" is the common case, and a set-like log loses exactly the repetition
that says how far the build got.

## 5. Reads do not replay

Reconstruction materializes the nearest keyframe at or before the address, then applies the
deltas after it. It never re-feeds a drawn grid: `translateToString` flattens rows and cannot
distinguish an auto-wrapped row from a `CUP`-positioned one, so re-feeding a TUI's grid can
re-wrap a row that was never wrapped — and simulating line discipline ourselves would be a
second emulator, which "one parser, one truth" forbids. Replay's role is narrower: it is
verified exact for *writing* runs (the grid and cursor come back exactly), which is what proves
no raw pty bytes need to be kept, and what would let retention later prune snapshots inside a
writing run.

A seek resolves to the record **at or before** the point asked for. Delivery granularity is the
resolution limit (`CLASSIFIER.md` §9.3) and nothing here invents precision beyond it.

## 6. Verification

- **Exhaustive, against the corpus** (`test/history-corpus.test.ts`): every recorded delivery of
  every direct trace is replayed into a timeline, then read back, and the reconstructed screen —
  its glyphs, its appearance and its wide-glyph columns — must equal the screen that session had
  at **every single record**, across 23 programmes.
  A single mis-encoded delta would corrupt every later read while leaving the keyframe beside it
  looking correct, so this is exhaustive rather than sampled.
- **The epoch rule, end to end** (`corpus/test/corpus.test.ts`): `complex.resize-epochs` produces
  three epochs at 60×8, 30×6 and 48×10 in both feeds, each answering at its own size.
- **Saturation is tested on purpose** (`test/delta.test.ts`): the hint a saturated scrollback
  hands over — 0, while the content keeps moving — is forced on shifts of 1, 3 and 5 rows, so
  the search has to recover the encoding rather than the hint. That is the case where a
  heuristic encoder would corrupt silently.
- **Against a live shell** (`test/session.test.ts`): every screen the timeline reconstructs
  equals the screen the session actually reported, and a mid-session resize freezes the old
  epoch at 100 columns while the new one answers at 60.
- **After the process exits** (`test/session.test.ts`): closing a session through `SessionHost`
  leaves its text queryable, which is the whole of L0.3's "survives the process exiting".

## 7. Out of scope here

- **Retention and pruning** — `L3.4`. The seam is in place: deltas make pruning snapshots inside
  writing runs safe, and the keyframe cadence is the knob.
- **Durability across server restarts** — `L3.4` / `GOAL.md` open question 2. L0.3's "survives
  the process exiting" is the hosted program's process, which is what §6 verifies.
- **Delta on the feed** — the same overkill applies to *delivering* a full screen per update, but
  that is L1.1's call, not L0.3's.
