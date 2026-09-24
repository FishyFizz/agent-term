# CLASSIFIER.md — AgentTerm

> How the server decides, per change, whether a program is **writing** (append-only text) or
> **drawing** (redrawing a surface) — and why it decides that way.

Companion to `GOAL.md` (what and why) and `PRIOR-ART.md` (what exists). This document is the
design of **L0.1** and the part of **L0.2** the classifier depends on. It records the design as
agreed, including the two rejected designs and the traces that killed them.

Everything marked **verified** was checked against `@xterm/headless` v6.0.0 in this repo, not
inferred. Where a claim is unverified it says so.

---

## 1. The contract

The contract is fixed by L0.1:

- The server classifies. The agent never inspects escape sequences or guesses a mode.
- Misclassification is a server bug.
- A change can be both writing **and** drawing.

Two rules govern the whole design.

> **The screen is the witness.** The verdict is read off the screen and nowhere else — not off
> the escape sequences, and not off what the program appears to have intended. A human at the
> terminal sees a screen, and the agent is meant to see the same thing. The op stream is how
> output is *replayed* and how a caller reads raw bytes when the screen model is under suspicion
> (L2); it is not an input to the verdict, because an op's meaning depends on what the program
> meant by it, and that is semantics — which `GOAL.md` puts out of scope.
>
> **One parser, one truth.** Classification is derived from the emulator that produces the
> screen, never from a second reading of the byte stream. A byte-level heuristic would be a
> second, worse VT parser that can disagree with the first one — and L0.2 stakes the project on
> the emulator being the authority.

A consequence worth stating plainly, because it surprised us: **there is no abstention, and
there is no confidence.** Nothing here declines to answer or reports doubt. A verdict is either
supported by the screen or the screen says it did not happen; the four observations in §3.1 are
a closed set, so every change lands in one of them. What replaces doubt is *volume* — see §3.5.

---

## 2. What gets classified: segments, not frames

The first design classified each update as `writing | drawing | mixed`. That is wrong, and the
reason is the subject of §4.

**The unit of classification is the delivery** — one job, one segment. A segment cannot claim a
finer range than the thing it was measured over, and the measurement is a frame diff across the
whole delivery.

"Mixed" is therefore not something an update *contains*; it is a fact about a **sequence** of
updates. A log line and the status repaint after it are two segments in time order, which is
what L0.3's timeline wants anyway and what the agent reads as a list.

This replaced an earlier rule that produced one segment per control op inside a single update.
That rule let an op's verdict compete with the screen's over the same bytes — the two disagreed,
nothing could settle it, and the resolution was a series of special cases (a `CUP` corroborates
drawing on its own; except the home that follows entering a full-screen program). Every one of
those cases was a judgement call introduced to settle a conflict that only existed because the
op stream was being asked.

---

## 3. The mechanism

### 3.1 One tap: the emulator's screen

The verdict is read from **one** place: the emulator's screen, captured before and after a
delivery. `frameOf` takes that capture; `screen.ts` owns the cells and is the only reader.

The op stream is **not** a witness. It is what output is replayed from, what boundaries are
found from (a resize, an alt-screen switch, a synchronized-output frame), and what a caller
reads when the screen model is under suspicion (L2). It is not asked what a change *means*,
because that depends on the program's intent, which is semantics — out of scope per `GOAL.md`.

That division is what removes the need for judgement. Two witnesses that can disagree need a
rule to settle them, and every such rule is a special case: a `CUP` corroborates drawing on its
own; except the home that follows entering a full-screen program; except when the two disagree,
in which case confidence drops. §2 records where that road led.

Captured per delivery, and enough for every test in §3.3:

| From the screen | Supplies |
|---|---|
| `lines` (right-trimmed) | what each row holds, before and after |
| `cursorY` | where an append would land |
| `viewportY` | how far content moved |
| `buffer` | which surface is in front |

### 3.2 Pipeline

```
pty bytes
  │
  ├─► job detector (src/jobs.ts)      close on a quiet period, a cap, or a
  │                                   forced flush at a resize / exit / dispose
  ▼
delivery            one job of raw bytes
  ├─► emulator.write()                (async — see §7)
  │     ├─► op stream                 replay, boundaries, and the raw escape hatch
  │     └─► screen model
  ▼
frames              before / after (§3.1)
  ▼
judge               structural tests on the screen (§3.3), one walk
  ▼
verdict             writing | drawing, + evidence
  ▼
delivery            text delta and screen, each collapsed its own way (§6)
                    + how many raw deliveries this one stands for (§3.5)
```

### 3.3 The tests, per delivery

Deliberately **threshold-free**. Every test is a structural question, not a count:

| Test | If true | Why |
|---|---|---|
| Did the segment erase cells outside the scrolled region? | drawing | Erasing is redrawing |
| Did it write onto cells that were non-blank? | drawing | Overwrite ≠ append |
| Did it reach back above the cursor's position at segment start? | drawing | Reaching back into printed content is repainting |
| Did it emit `\r` + overwrite? | drawing | Same as above, single row |
| Was it text + linefeed only, cursor advancing monotonically, no cell that was non-blank became blank, no cell above the cursor touched? | writing | This is what appending *is* |

Scroll is **normalized against the emulated scroll event** (`onScroll` / viewport shift), then the
residual is judged. Without this a scrolling build log changes every row and looks like a
repaint; after normalization it is "N new lines at the bottom, nothing else". That is the
dominant case for `ls`, `cat`, `grep`, compilers, and shells.

A threshold-free classifier does not need tuning per program, and success criteria 1–5 in
`GOAL.md` are all "without special-casing any program". If a magic number ever looks necessary,
the test is wrong.

### 3.4 Alt screen: a prior and an urgency flag, never a verdict

This was the first rejected design. Alt screen was originally a hard "drawing" verdict. It is
not, and the counterexample is exact:

```
write '\x1b[?1049h' then A1..A8 separated by \r\n        [verified]
  → buffer.active.type === 'alternate'
  → alternate.length stays 5 (fixed at rows)
  → onLineFeed fires (6×)
  → content scrolls within the alt screen
  → '\x1b[?1049l' restores the normal buffer with prior content intact
```

That is *pure sequential append* — observationally identical to `cat`. A program writing on the
alt screen and a program writing on the normal screen are indistinguishable by buffer type.
`buffer.active.type` carries **zero** information about writing vs drawing.

It carries two other things, both real:

1. **Capture urgency.** Alt-screen content is **destroyed on exit** — verified: the normal
   buffer came back with its prior content, and everything written on alt was gone. L0.3 ("page
   back to any earlier part") is therefore unsatisfiable unless alt-screen content is recorded
   while it is live. **Entering the alt screen makes capture mandatory, not optional.** This is a
   testable regression, not a policy preference.
2. **A prior.** Programs choose the alt screen *because* they intend to repaint, so it correlates
   with drawing. It raises capture urgency; it does not raise a verdict. Entering the alt screen
   is reported as `writing`, because on the screen a different surface came in front — nothing
   was erased, overwritten, or reached back into.

Alt-screen enter/exit are additionally **segment boundaries** and **timeline events**. This is
what makes success criterion 3 (shell → TUI → shell, reconstructable in order) fall out
structurally rather than needing separate machinery.

### 3.5 Suspicion is volume, not doubt

There is no abstention. Nothing is emitted with low confidence, and nothing declines to answer:
the four observations in §3.1 are a closed set, so every change lands in one of them.

The case that used to be abstention — "the program appears to have done something the screen
will not confirm" — is not reported as uncertainty. It is reported as **volume**: an update
carries how many raw deliveries it collapsed (`collapsed`, `GOAL.md` L1.1), so *many deliveries
behind little visible change* is visible to the agent as exactly that, and the intermediates
remain readable. That is a better signal than a confidence flag: it is a fact rather than a
judgement, it does not require the classifier to know what it does not know, and it points at
the remedy — go and read the intermediates — instead of merely warning.

This is the answer to open question #4 in `GOAL.md`, in the form the design can actually honour:
never ask the agent, never guess, and report the collapsed count rather than claiming doubt.

A third `unknown` value is reserved for emulator desync and should be unreachable.

---

## 4. Rejected: spatial band decomposition

The first design split an update into contiguous **bands** of changed rows, separated by
unchanged rows, and classified each band independently. The npm progress bar was the motivating
case: log lines appended at the top, a status row repainted at the bottom.

This is impossible. A row is a **coordinate**, not an entity, and a single scroll invalidates
the correspondence.

Reproduction — draw, append, redraw, as npm does:

```
draw bar        CUP@y4  EL@y3        row4: "[#####-----]"
append "log5"   (no control ops)     scrolls; the old bar is now at row 3
redraw bar      CUP@y4  EL@y4        row4: "[##########]"

final screen:
  row3: "[#####-----]"    ← old bar, still on screen
  row4: "[##########]"    ← new bar
```

The two bars are at **different rows**, the new log line sits spatially between them, and nothing
in the diff links row 3's past self to row 4's present self. There is no evidence — and can be
none — that they are "the same" status line.

The general failure: *the npm update decomposes in time, not in space.* It is
`draw → erase → write → draw`, and no spatial clustering of a before/after diff can recover that
ordering. Bands also smuggled in identity-by-position, which any scroll breaks.

Segments recover it, because the boundary comes from the program's own operations rather than
from screen geometry. Applied to the same trace:

| # | op evidence | verdict | payload |
|---|---|---|---|
| 1 | text + linefeed, no control ops | writing | text delta |
| 2 | `CUP` + `EL` + text onto a cleared row | drawing | screen state |

The identity question never arises. We do not need to know that old-bar and new-bar are the same
thing; at T1 the program erased and redrew, at T2 it appended, and which happened comes from the
op, not from clustering.

**Corollary:** "can we detect both writing and drawing in one update?" — yes, as a **sequence**,
not as a spatial split. That is the conceptual correction the second design turned on.

---

## 5. Two sinks

The screen model is not a lossless record of writing. A program emitting 10k lines overflows any
bounded scrollback, but success criterion 1 requires the agent to page back to any earlier part.

So the emulator feeds two sinks:

| Sink | Nature | Fed from | Serves |
|---|---|---|---|
| **Text log** | append-only, ordered, addressed by cursor | `onLineFeed`, reading the completed line out of the buffer before it can fall out | writing deltas, history pagination |
| **Screen grid** | state | `buffer.active` | drawing, classifier input |

Linefeeds fire during drawing too, so the text log always accumulates — but each line carries the
byte stamp of the delivery that completed it and the buffer it was written on, so a caller can
attribute every line. Promoting only the lines inside writing-classified segments into the feed is
delivery's job (L1.1); the log keeps all of them, marked. That is the L2 raw-stream escape hatch,
for free.

---

## 6. Classification gates delivery

The two kinds **collapse differently**, and this is why coalescing cannot happen before
classification:

- **Writing deltas concatenate.** Intermediate states are informative; losing one loses text.
- **Drawing states collapse to the latest.** A repaint is a state; 40 intermediate spinner frames
  carry no information.

Getting this backwards is exactly how a 60fps TUI floods the agent (L1.1) or how a build log
loses lines.

Two structural events are **not drawings** and must be special-cased, or they classify as
enormous repaints:

- **Resize** — reflows every row.
- **Alt-screen exit** — reflow on restore.

---

## 7. Constraints the implementation must respect

Verified, and each one breaks the design silently if ignored:

1. **`terminal.write()` is asynchronous.** The typings: *"the change will not be reflected in the
   buffer immediately... the callback must be provided and awaited in order for `buffer` to
   reflect the change."* Any read of `buffer` in the same tick as a write sees a stale grid.
2. **The alt buffer has no scrollback** — `length` stays fixed at `rows` while the normal buffer
   grows with its scrollback setting. Hence §3.4's capture urgency.
3. **`buffer` is proposed API** and throws unless constructed with `allowProposedApi: true`
   (already handled in `src/xterm.ts`).
4. **Synchronized output (`CSI ? 2026 h`)** exists in `modes`. A segment spanning a synchronized
   update should be treated as atomic.

---

## 8. Contract sketch

```
Update {
  seq, at
  io: { bytesRead, bytesPending | null, ... }   // L1.3 — null, never 0
  text: TextLine[]                              // completed lines this delivery produced
  screen: ScreenSnapshot                        // what the screen is now
  grid: GridDelta | null                        // how it differs from the previous one
  collapsed: { chunks, intermediates, ops, bytes, reason, spanMs } | null
  segments: [{
    kind: 'writing' | 'drawing'
    fromByte, toByte
    evidence: { erased, overwrote, reachedBack, scrolledBy, altScreen }
  }]
}
```

`altScreen` is per-segment context, not a classifier.

There is no `confidence`. §3.5 says why: suspicion is reported as volume — `collapsed.chunks`
against how much of the screen actually changed — and the intermediates stay readable.

`segments` has one entry per delivery. "Both kinds" is a fact about a sequence of updates (§2),
not about one of them.

---

## 9. Open items

1. **Portability of the op stream.** — **closed, by removing the dependency.**
   `registerCsiHandler` is xterm-specific, and `charmbracelet/x/vt` (the Go
   alternative in `PRIOR-ART.md`) may not expose an equivalent. That used to
   matter because the op stream was a witness, and losing it would have meant a
   degraded screen-diff-only fallback. It is not a witness any more (§3.1): the
   verdict is screen-only, so a stack that cannot produce an op stream loses
   replay-with-ops and the raw escape hatch, and loses no classification. The
   design is stack-neutral where it counts.
2. **Redraw without control ops.** carriage-return overwrite, and erase variants outside
   the hooked set — **closed**. Caught by the screen model (`overwrote`: text
   landing on cells that were already non-blank). Exercised by
   `basic.cr-overwrite` and `basic.spinner`.
3. **Delivery granularity is a first-class constraint.** *Found by measurement,
   and it remains the biggest open item.* A classifier call sees a *before* and
   an *after*, so what it can detect depends on where deliveries begin.

   **Partly closed.** Deliveries now begin where the programme drew them:
   `src/jobs.ts` groups output by the gaps between arrivals, and the corpus
   records those arrival times so the grouping can be replayed. That removed the
   arbitrary boundary — a pty buffer filling — from the picture.

   | Replay | Score |
   |---|---|
   | one job, from arrival gaps | **21/23** |
   | one delivery per drawing op (synthetic) | 20/23 |
   | 64-byte chunks (synthetic) | 17/23 |
   | 256-byte chunks (synthetic) | 7/23 |
   | the whole trace as one delivery | 7/23 |

   `npm run corpus` prints these; the pins live in `test/corpus.test.ts`, where
   they are labelled measurements rather than a specification (§11).

   What remains open:

   - **Coalescing is a classification input, not merely a delivery policy.**
     Where a window opens decides whether an overwrite is visible at all. This
     is L1.1's territory, but L0 cannot pretend to be neutral about it — which
     is why `jobs.ts` lives in `src/` and not above it.
   - **History inherits the same resolution.** A timeline entry is a delivery, so
     a seek resolves to the entry at or before the point asked for and does not
     invent precision between entries (`src/history.ts`). See `HISTORY.md`.
   - **The gap threshold is a policy with a principled range, not a tuned
     number.** Anywhere from 20ms to 70ms separates the corpus's two pauses
     (6ms within an act, 80–120ms between acts) and the measured score is
     identical across that range. What sets the range is human legibility:
     faster than that and no one could read the intermediate state anyway.

   Unresolved: whether a session should feed per-op, per-chunk, or adaptively —
   though "adaptively" now has a concrete form, which is what `jobs.ts` does.
4. **Coalescing window ownership.** — **built, with the ownership split.**
   `src/jobs.ts` closes a job on a quiet period, on a cap, or on a forced flush
   at a resize, an exit or a dispose. L0 owns *that boundaries exist*, because
   where one falls decides what the classifier can see (item 3); L1/L3 owns the
   numbers, which arrive as a `JobPolicy` and are never baked in. The quiet
   period is measured from the last byte, not from when the job opened, so a
   slow but continuous program is not chopped at arbitrary intervals.
   Timing policy does not leak into L0: `jobs.ts` takes a clock and a scheduler
   by injection, and its tests advance time rather than sleeping.
5. **Whether the text log is L0 or L1.** — **closed: L0.** It is built
   (`src/text-log.ts`), and the argument above is the reason: the screen grid
   holds the viewport, so a line that scrolls out is in no snapshot at all, and
   L0.3's "page back to any earlier part" is unsatisfiable without a separate
   record. Measured: 200 lines into a 5-row terminal with 10 lines of scrollback
   leaves 15 of them in the buffer, while reading the completed line at each
   linefeed yields all 200, distinct. See `HISTORY.md`.

---

## 10. Verification

The corpus is the regression suite, and it is needed **before** the code, not after: 23
programmes, 46 recorded traces, each expectation hand-labelled with a byte range and the reason
it exists. The programmes themselves are written by hand (`corpus/programmes/`) rather than
recorded from `vim` and friends — a trace has to be deterministic and need nothing installed —
but each one reproduces the observable behaviour of a real program, and the shapes below are
those programs':

| Shape | Programme | Exercises |
|---|---|---|
| long noisy build | `cli.build-log`, `basic.scroll-write` | writing under scroll; history pagination |
| full-screen TUI | `complex.shell-tui-shell`, `cli.pager` | drawing, alt screen, capture urgency |
| continuous repaint | `cli.dashboard`, `basic.spinner` | collapse-to-latest |
| alt-screen selector | `cli.menu-selector` | a highlight moving over a fixed list |
| REPL | `cli.repl` | interleaved writing + prompt redraw |
| progress bar | `cli.progress-bar`, `complex.progress-bar-scroll` | the §4 trace — draw/erase/write/draw ordering |
| pager, then quit | `cli.pager` | shell → TUI → shell (criterion 3) |
| **a program that writes on the alt screen** | `basic.alt-screen-write` | the §3.4 counterexample — would have passed the rejected design for the wrong reason |
| resize while a TUI is running | `complex.resize-during-tui`, `complex.resize-epochs` | reflow is an event, not a repaint |
| firehose output | `complex.firehose` | bounded feed, no loss |

The scores and the replay granularities they are measured at are pinned in `test/corpus.test.ts`
and printed by `scripts/corpus-score.ts`; the timeline's own verification is `HISTORY.md` §6.

Read §11 before treating any of those scores as a target. They are measurements of a label set
that was written by hand alongside the code, and two expectations have already been deleted for
asserting something about the program that the screen does not show. The programme's `why` is the
part worth defending; the verdict beside it is a claim a reader is free to dispute.

---

## 11. How this is built, and what a test may assert

Three rules, in order. They were learned the hard way on this codebase, by doing it the other
way first.

### 1. Comprehensible first

The classifier's job is to **present the terminal in a comprehensible way** — to say what a
human at the screen would say: content arrived, content was replaced in place, content moved,
the surface changed. That is the specification.

It is not "produce the verdict a label says". Nobody specified the labels. They were written by
hand, alongside the code, mostly after it — and an expectation that says "this span is
`drawing`" where the screen shows a blank row gaining text is a claim about the *program's
intent*, not about anything visible. Optimising against such a label makes the classifier worse
in a way that looks like progress, because the number goes up.

It did go up, repeatedly, and every increase was fitted: a second verdict field added so a mixed
burst could pass, a `CUP` suppressed because it measured better, a job boundary adopted because
it netted +1. None of those were asked for. All of them are gone now.

### 2. The code reflects the model

The model comes first and the code is written to match it. When the code and the model disagree,
the code is wrong — including when the code passes its tests. `src/classify.ts` should read like
§3.1: four observations, one walk, no thresholds.

If a change to the code needs a new special case to keep a label satisfied, that is the model
telling you the code took a wrong turn.

### 3. Tests check the code, not the semantics

A test written after the classifier may assert that the *code is correct*. It may not assert
that a *verdict is right*, because the verdict is the thing under test.

What that leaves, and it is not nothing:

- **Exactness** — applying what was reported reproduces the screen. This is already exhaustive
  across every delivery of every direct trace (`test/history-corpus.test.ts`) and is the
  strongest test in the repo; it does not mention verdicts at all.
- **Completeness and order** — every byte accounted for, segments in time order.
- **Observation, checked against the frames** — "replaced in place" really was a replacement;
  "content arrived" really was blank before. Derivable from the before/after frames, so a test
  can check it without anyone's judgement.
- **Structural invariants** — a job does not straddle a resize or an alt-screen switch; a
  segment's range is well-formed; the collapsed count is honest.

And what it does not leave: **the pinned scores are measurements, not a specification.** They
are printed because a drop means the algorithm moved, and they are pinned so a regression fails
loudly. A rise is not automatically progress, and a fall is not automatically a bug — when the
verdict stopped reading the op stream, `drawOps` went 21 → 20 and that was the change working,
not breaking.

Where a programme's expectation encodes a semantic judgement rather than an observation, delete
it. Two have been: `complex.progress-bar-scroll`'s final redraw, and `complex.interleaved`'s
`drawing` — both asserted something about the program that the screen does not show.
