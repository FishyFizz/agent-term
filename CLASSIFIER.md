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
- Where classification is genuinely uncertain, the server says so rather than choosing silently.

One rule governs the whole design:

> **One parser, one truth.** Classification is derived from the emulator that produces the
> screen, never from a second reading of the byte stream. A byte-level heuristic would be a
> second, worse VT parser that can disagree with the first one — and L0.2 stakes the project on
> the emulator being the authority.

---

## 2. What gets classified: segments, not frames

The first design classified each update as `writing | drawing | mixed`. That is wrong, and the
reason is the subject of §4.

**The unit of classification is the segment** — a run of program activity bounded by control
operations — not the update, and not a region of the screen.

An update delivered to the agent contains **one or more ordered segments**, each independently
classified as `writing` or `drawing`. "Mixed" is not a verdict; it is the structural fact that an
update contains segments of more than one kind.

This is a better interface than a tri-state: the agent never has to interpret `mixed`, it reads a
list, and the list is what L0.3's timeline wants anyway.

---

## 3. The mechanism

### 3.1 Two taps on the same emulator

| Tap | API | Supplies |
|---|---|---|
| **Edit record** (op stream) | `parser.registerCsiHandler` / `registerEscHandler` / `registerDcsHandler` | *where the boundaries are* |
| **Screen model** | `buffer.active`, `getLine`, `translateToString`, `getCell`, `onLineFeed`, `onScroll`, `onBufferChange` | *what each segment did* |

The op stream supplies **segmentation**; the screen model supplies the **verdict** per segment.
Neither alone is sufficient:

- Screen diffs alone cannot recover boundaries once a scroll has moved everything (§4).
- Ops alone tell us a program moved the cursor, not whether it thereby destroyed content.

They are two views of one parser, so there is no disagreement to reconcile.

Verified available and firing in order, with cursor position at the time of the op: `CUP` (`H`),
`EL` (`K`), `ED` (`J`), `CUU` (`A`), `DCH` (`P`), `IL` (`L`), `DL` (`M`), `DECSC` (`ESC 7`).
Plain printable text does **not** pass through these handlers — so the op stream is naturally
segmented at control-op boundaries, with runs of text between them.

Each boundary is stamped with the byte offset / sequence number at which it occurred.

### 3.2 Pipeline

```
pty bytes
  │
  ├─► emulator.write()                     (async — see §7)
  │     ├─► op stream (control ops, ordered, with byte offsets)
  │     └─► screen model
  │
  ▼
segmentation        split the window at op boundaries
  ▼
per-segment judge   structural tests on the screen (§3.3)
  ▼
verdict             writing | drawing, + confidence + evidence
  ▼
delivery            collapse per kind (§6)
```

### 3.3 Per-segment tests

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
   with drawing. It is a tiebreaker applied only where the structural tests abstain, and it can
   always be overridden by positive evidence in the same segment.

Alt-screen enter/exit are additionally **segment boundaries** and **timeline events**. This is
what makes success criterion 3 (shell → TUI → shell, reconstructable in order) fall out
structurally rather than needing separate machinery.

### 3.5 Abstain

If no test fires cleanly, the segment is not silently assigned. It is emitted with
`confidence: "low"` and its evidence attached, and delivery sends **both** representations. This
is the answer to open question #4 in `GOAL.md`: never ask the agent, never guess, send both and
flag it. Expensive, and expected to be rare.

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
| **Text log** | append-only, ordered, addressed by cursor | `onLineFeed` / `onScroll`, reading the completed line out of the buffer before it can fall out | writing deltas, history pagination |
| **Screen grid** | state | `buffer.active` | drawing, classifier input |

Linefeeds fire during drawing too, so the text log always accumulates — but each line carries its
sequence number, and only lines inside writing-classified segments are promoted to the feed.
Lines from drawing segments remain in the log, marked. That is the L2 raw-stream escape hatch,
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
  segments: [{
    kind: 'writing' | 'drawing'
    confidence: 'high' | 'low'                  // low ⇒ evidence attached, both sent
    evidence: { ops: [...], erased, reachedBack, altScreen }
  }]
}
```

`altScreen` is per-segment context, not a classifier.

---

## 9. Open items

1. **Portability of the op stream.** `registerCsiHandler` is xterm-specific;
   `charmbracelet/x/vt` (the Go alternative in `PRIOR-ART.md`) may not expose an equivalent.
   Proposal: **L0 owns the contract** (segments + verdicts); **L3.1 owns how the edit record is
   produced**, with screen-diff-only as a degraded-but-functional fallback — losing the ability to
   segment a scrolled update, but not the ability to classify. The design is therefore not
   fully stack-neutral; declaring that is better than pretending.
2. **Redraw without control ops.** carriage-return overwrite, and erase variants outside
` + overwrite, and erase variants outside
   the hooked set — **closed**. Caught by the screen model (`overwrote`: text
   landing on cells that were already non-blank). Exercised by
   `basic.cr-overwrite` and `basic.spinner`.
3. **Delivery granularity is a first-class constraint.** *Found by measurement,
   and it remains the biggest open item.* A classifier call sees a *before* and
   an *after*, so what it can detect depends on where deliveries begin. Same
   corpus, same classifier:

   | Replay | Score |
   |---|---|
   | one delivery per drawing op | **21/23** |
   | 64-byte chunks | **15/23** |
   | 256-byte chunks | 7/23 |
   | the whole trace as one delivery | 7/23 |

   `npm run corpus` prints these; the pins live in `test/corpus.test.ts`.

   Three consequences the design has to own:

   - **An op's byte offset is only as precise as the delivery carrying it.** The
     byte counter advances per feed, so ops in one delivery share an offset and
     cannot be ordered against each other. The classifier emits one segment per
     op spanning the delivery rather than fabricating precision — §3.1's offsets
     are an upper bound on resolution, not a guarantee.
   - **Coalescing is a classification input, not merely a delivery policy.**
     Where a window opens decides whether an overwrite is visible at all. This
     is L1.1's territory, but L0 cannot pretend to be neutral about it.
   - **History inherits the same resolution.** A timeline entry is a delivery, so
     a seek resolves to the entry at or before the point asked for and does not
     invent precision between entries (`src/history.ts`). See `HISTORY.md`.

   Unresolved: whether a session should feed per-op, per-chunk, or adaptively.
4. **Coalescing window ownership.** Per-`onWriteParsed` classification is exact
   but expensive; per-tick is cheap and, because boundaries are stamped with byte
   offsets, still exact — *qualified by item 3*: offsets are delivery-coarse, so
   "exact" holds only at the delivery's resolution. Timing policy is L3 and must
   not leak into L0.
5. **Whether the text log is L0 or L1.** — **closed: L0.** It is built
   (`src/text-log.ts`), and the argument above is the reason: the screen grid
   holds the viewport, so a line that scrolls out is in no snapshot at all, and
   L0.3's "page back to any earlier part" is unsatisfiable without a separate
   record. Measured: 200 lines into a 5-row terminal with 50 lines of scrollback
   leaves 54 of them in the buffer, while reading the completed line at each
   linefeed yields all 200, distinct. See `HISTORY.md`.

---

## 10. Verification

The corpus is the regression suite, and it is needed **before** the code, not after. Recorded
real sessions, hand-labelled per segment:

| Case | Exercises |
|---|---|
| long noisy build | writing under scroll; history pagination |
| `vim` | drawing, alt screen, capture urgency |
| `htop` | continuous repaint, collapse-to-latest |
| `fzf` / `lazygit` | alt-screen TUI |
| `python` REPL | interleaved writing + prompt redraw |
| `npm` / `cargo` progress | the §4 trace — draw/erase/write/draw ordering |
| `git log` piped to a pager, then `q` | shell → TUI → shell (criterion 3) |
| **a program that writes on the alt screen** | the §3.4 counterexample — would have passed the rejected design for the wrong reason |
| resize while a TUI is running | reflow is an event, not a repaint |
| firehose output | bounded feed, no loss |
