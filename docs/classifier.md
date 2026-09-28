# The classifier

How a change is called **writing** or **drawing** — and why that is the only question it
answers.

See [design.md](design.md) for the rules it obeys; this document is the mechanism.

## The input is a pair of frames

Classification takes the screen **before** the delivery, the screen **after** it, and the byte
range the delivery covers. Nothing else. Not the escape sequences, not what the program appears
to have intended.

A frame is `{lines, cursorY, viewportY, altScreen}`. Lines are **right-trimmed** when frames are
built, even though the stored snapshot pads its rows to the full width: comparing padded rows
against trimmed ones would make every trailing-blank difference look like a real change.

## Four observations, one walk

The diff makes a single pass over the rows, and each row is compared by the **one** row
comparison in the repo. `changed` is true when a row has no counterpart (newly revealed — the
common case is the bottom of a scroll) or differs from its counterpart.

Three facts are collected from that walk:

| Observation | What it means |
|---|---|
| `erased` | some cell was non-blank and is now blank |
| `overwrote` | non-blank became *different* non-blank |
| `reachedBack` | a changed row sits above the row the cursor was writing on |

`reachedBack` is the load-bearing one. Judging by "did anything change anywhere" would call a
repaint writing whenever a repainted row happens to differ. What distinguishes a redraw is that
the program went **back up into content it had already finished** — and for that, the append
row is taken in *before* coordinates, with scrolling already normalised out.

There is deliberately **no "the cursor moved backwards" test**. A trailing carriage return
after appended text leaves the cursor at column zero with the text intact, and every build log
does it.

## The rule

```
damaged      = erased || overwrote || reachedBack
bufferSwitch = before.altScreen !== after.altScreen

kind = (!bufferSwitch && damaged) ? 'drawing' : 'writing'
```

So **drawing means: not a buffer switch, and something was destroyed or reached back into.**
Everything else is writing. A drawing always carries positive evidence; nothing is drawing
because it *looks* like a drawing.

Scroll is factored out **before** the erase and overwrite comparison, so a scrolling build log
is not mistaken for a repaint. The shift the emulator reports is trusted and used when it is
positive — it counts rows as they move, which is correct where the viewport counter saturates
on a full scrollback ring — and otherwise the shift is recovered by finding the one whose
row-by-row match is best. It is computed once and passed to both the verdict and the row walk,
because computing it twice could let the two disagree.

## The alt screen is a prior, never a verdict

A program can write on the alternate screen exactly as on the normal screen; the two are
observationally identical. So the alt screen is not a verdict — it is a **prior** and a
capture-urgency flag.

The one place it enters the decision is the buffer-switch override. Entering the alt screen
replaces the whole grid with a blank one, which reads as "erased" — but nothing was erased,
another buffer was simply switched in. Without the override, every shell→TUI transition would
be reported as a redraw.

Because it is a prior, the evidence can always override it; a pure sequential append on the alt
screen is still writing.

## One segment per delivery

The classifier returns exactly one segment, spanning the whole delivery. It cannot claim a
finer range than the thing it was measured over.

That is why "this update is both writing and drawing" is not a thing the model represents. A
log line followed by a status repaint is two deliveries, and therefore two segments, in time
order.

A delivery that changed nothing visible still produces a segment; the change is reported as
what it was. There is no abstention.

## Coalescing

Above the delivery, consecutive segments of the **same kind** merge: their evidence flags are
OR-ed, their scroll is summed, and their byte range is extended. Segments of **different kinds
never merge**, because that boundary is the answer.

Coalescing cannot precede classification. The two kinds collapse differently — writing deltas
concatenate, drawing states collapse to the latest — so the verdict has to be known first.

## What is deliberately absent

- **No verdict from the op stream.** The op stream supplies boundaries and replay; an op's
  meaning depends on what the program meant by it, which is semantics.
- **No spatial decomposition.** A design that split the screen into bands — a scrolling region
  and a repainting one — was disproved by a trace: a progress bar on the last row and a log
  appended above it are one delivery covering both, and no band boundary exists in the bytes.
- **No thresholds, no confidence, no third value.**
