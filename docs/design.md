# Design rules

The rules the system is built to obey. They are not style preferences; each one is load-bearing
for something above it, and several were learned by doing it the other way first.

## The screen is the witness

The verdict is read off the **screen** and nowhere else. Not off the escape sequences, and not
off what the program appears to have intended: a human at the terminal sees a screen, and the
agent is meant to see the same thing.

An op's meaning depends on what the program meant by it, and that is semantics — which is out
of scope. The op stream is how output is *replayed*, how boundaries are found, and how a caller
reads raw bytes when the screen model is under suspicion. It is not an input to the verdict.

## One parser, one truth

Everything recorded comes out of the emulator that produces the screen. No field is derived by
re-scanning the bytes.

A byte-level heuristic would be a **second, worse VT parser that can disagree with the first
one**, and the project stakes the screen model on being the authority. The same rule applies
within the model: there is exactly one row comparison in the repo, and both the aggregate diff
and the text log read it. Two comparisons would be two witnesses, and they could disagree.

## No abstention, and no thresholds

There is no third verdict, no `unknown`, and no confidence value. Every delivery lands in one
of the two kinds. What replaces doubt is **volume**: a delivery reports how many raw deliveries
it stands for, so many deliveries behind little visible change is legible to the agent as
exactly that, and the intermediates stay readable.

The tests are **structural and threshold-free** — did content arrive, was it replaced in place,
did it move, did the surface change. Never "more than N% changed". A tuned classifier needs
tuning per program, and every success criterion is of the form "without special-casing any
program".

## The unit of classification is the delivery

A segment cannot claim a finer range than the thing it was measured over, and the measurement
is a frame diff across the whole delivery. "Both writing and drawing" is therefore a fact about
a *sequence* of deliveries, never something one delivery contains.

This replaced a design that produced one segment per control op inside a single update. That
design let an op's verdict compete with the screen's over the same bytes; the two disagreed,
nothing could settle it, and the resolution was a growing list of special cases. All of them
are gone.

## Nothing is stored that can be derived

- **Verdicts are not stored.** A verdict stored beside the frames it was taken from is a second
  opinion that can drift from them. It is computed where it is needed.
- **Groups are not stored.** They are a projection over the records, computed on read, so they
  cannot disagree with the stream they came from, and they can be recomputed at a different
  granularity without re-recording anything.
- **The shift in a delta is not read from the emulator.** It is searched and verified: the
  delta is only accepted if applying it reproduces the screen exactly. A free parameter with a
  verifier is not a heuristic.

## Unknown is `null`, never `0`

Every observation carries enough state to tell "there is nothing" from "we cannot say". A
watermark that is `0` before anything happened is a lie that compounds: it makes "nothing is
pending" unfalsifiable, and it is the root cause of a class of interaction bugs — a keystroke
sent before the program processed the previous one, with no diagnosis afterwards.

So: `null` for unknown, a real count for zero. The rule is applied structurally, not by
convention — a result that has no change to report says so rather than reporting an empty one,
a mode that no decision depended on is `null` rather than `false`, and a field that would be
present only sometimes is `null` rather than absent, because an absent field is silently read
as "nothing".

## Waits measure; they do not judge

A wait ends on `idle`, `exited` or `timeout` (or `matched`, or `group`), and it reports which.
It does not report *settled*: whether a live program will produce more output is not provable
at a byte interface — it may emit at any future moment for reasons entirely internal to it —
and the only event that closes the set is termination.

For the same reason there is **no `atPrompt`**. "Is the program blocked waiting for input?"
was investigated rather than assumed, and it is not observable: a shell sitting at a prompt and
the same shell busy on a builtin are identical from outside, and echo probing both fails to
distinguish them and mutates the thing being observed.

What is offered instead are the two facts that *are* observable: how many input bytes have had
no output follow them, and whether a group's bytes sit after the last write. Both are stated as
what they are. The second is *placement, not causation* — output following input may still be
unrelated to it.

The consumer's rule follows: do not wait for "the program is ready". Wait for **text the
program prints**, or wait for a group and read it.

Two consequences of taking this seriously:

- **`exit` is the pty's own fact**, not a notification queued behind the feed. A state built on
  the queued notification could never report "exit, more to read" — the state would be
  unreachable and the window it exists to describe invisible.
- **Idle is measured from the last *byte*, never from the last delivery.** A program that never
  pauses never opens a gap, so no delivery completes for seconds at a time; idle measured from
  a delivery would call a firehose idle while it floods output.

## A report says what happened, not what was meant

Input is **named, not spelled**. The caller sends `{key: "down"}`; the bytes are the server's
problem. This is not ergonomics: a transport between an agent and the server can silently drop
a control character, and a raw escape typed as text is exactly what it drops.

A key is encoded from the mode the program has set — read off the screen — rather than from a
fixed table, because the same arrow is a different byte sequence in a shell and in a program
that has turned on application cursor keys. A mode that did not affect the bytes is reported as
`null`, not as a value, because reporting it would answer a question nobody asked.

A paste follows the same rule. The caller says *this is a paste*, and whether the bytes are the
characters alone or those characters wrapped in the bracketed-paste guards is read from the
mode the program set: a program that asked for bracketed paste inserts a multi-line paste
literally, while one that did not receives the same characters as keystrokes and runs them at
their newlines. The distinction the caller asked for survives as a fact about the write rather
than a guess about the program.

And every write reports **the bytes actually written**, so the round trip can be checked without
reading the screen. The caller sees what was sent, not what was intended.

The same rule governs what comes back: a match is an observation, not evidence of readiness —
the terminal echoes what is typed, and an echo is new output too.

## The screen crosses the wire trimmed

A grid is `cols` wide and `rows` tall, and it is padded in both directions: a row is padded out
to `cols` whether or not the program wrote them, and a screen whose content stops partway down
carries blank rows to the bottom. Both are returned trimmed — the trailing space of each row,
and the blank rows below the last one carrying anything — and only *ends* are cut, so a glyph
keeps its column and a delivered row keeps its index rather than shifting up.

What that costs is one rule, and it is the same rule in both directions: a position past the
end is blank. So `changedRows` may name a row the screen does not carry, and that is a row that
is blank *now* — the fact the row would have carried had it been delivered, and no less than
that. Whether this act blanked it or a scroll revealed it blank is `segments`' answer, not the
screen's. A screen with nothing on it is `[]`, not a full grid of empty strings.

Nothing is lost: what was erased is in `segments`, what was written is in `text`.

Blank cells hold no fact that the change report does not already carry. Paying for them on
every read is paying context for padding.

## Errors are typed and closed

A failure is a code the caller can branch on, not a stack trace: there is no such session, the
session is not live, the input was bad, the pattern was bad. Unexpected exceptions are
**re-thrown**, never converted into a caller error — a bug must not be able to masquerade as
the caller's mistake.

An error that cannot be delivered honestly is removed rather than left as a promise. "The
session is waiting for input" was listed once and is not deliverable, because whether a program
is waiting cannot be observed; the input watermark states what was sent and whether anything
came back.

## Policy lives outside the model

A timeout, a byte cap, a gap threshold is policy, and policy is not part of the core model. It
arrives as an argument or as a policy object, so a deployment can change it — and so a test can
replace the clock rather than sleep through it.

The caps exist for the case where nothing else bounds the feed: a program that never goes
quiet. Without them, the thing meant to provide bounded delivery would be the thing violating
it. And a cap close is reported distinctly from a quiet close, because they do not mean the
same thing — only one of them says the program went quiet.

## Stop when the boundary is the point

A group closes on silence, on a cap, or on a forced flush. It never splits a delivery: an
arrival larger than the cap becomes its own group, because splitting would invent a boundary
the program never drew. And when two consecutive segments differ in kind, they are never
merged — that boundary *is* the answer. "This happened, then that" is the comprehensible
report.
