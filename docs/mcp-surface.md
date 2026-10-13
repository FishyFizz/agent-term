# The MCP surface

The tools an agent drives a terminal with. The surface is deliberately small: every tool
definition is context the agent pays for on every turn, so a large surface is a cost, not a
feature. The rule followed here is that **the shape of a result matters more than the number of
tools** — capabilities are added by making an existing call carry more, not by adding a call.

Capabilities that are not on the surface are absent on purpose rather than forgotten; see
[design.md](design.md) for the refusals they would violate.

The same cost applies to each tool's description, which every connected agent carries on
every turn. So the descriptions are terse — what the tool does, its parameters, the one
trap — and the semantics below live in the `agent-term` skill, which is loaded when it is
needed rather than charged for always. The contracts here are the authority for both.

## Errors

Failures come back as one of a closed set of codes, so a caller can branch on them instead of
parsing prose:

| Code | Meaning |
|---|---|
| `no_session` | no session with that id |
| `not_live` | the session exists but its process has exited |
| `bad_input` | the input could not be composed or the address is out of range |
| `bad_pattern` | the regular expression did not compile |

Unexpected exceptions are re-thrown, never converted into a caller error.

## Opening, resizing, closing

### `open_session`

Starts a hosted session. Takes `command`, `args`, `cwd`, `cols`, `rows`, all optional —
defaults are a platform shell, the server's working directory, and a sanitized copy of the
environment. Returns the session id, which is what every other tool addresses, along with the
grid size and the pid.

### `resize_session`

Sets a live session's terminal size. The pty is resized — the program inside is told via
SIGWINCH — and the emulator follows, so the grid, the wrapping and the recorded history agree on
the new shape. Returns the size that was applied.

A resize ends the group in flight and opens a new **epoch**, so everything recorded before it
stays readable at the size it was produced at — that is what the `epoch` a read reports is for.

The server owns the size, and the two sides move together only when this is called or the
session is opened. A program that resizes *itself* (`stty cols 60`) changes the pty's `winsize`
without telling the emulator, so the grid does not follow and a full-screen program started
afterwards draws for a width the grid does not have. Resizing through this tool is the way to
move both.

### `close_session`

Ends the session and kills its process tree. **History stays readable afterwards** — ending a
session is the moment the record matters most, not the moment to drop it.

## Sending input

### `send_input`

Writes text as if typed, with `submit` pressing Enter — a bare CR, the byte the key sends.
Returns the byte count and `written` — the bytes as actually handed to the terminal, escaped so
they can be compared with what was meant. Keys are not spelled here; see `send_sequence`.

### `send_sequence`

Composes several steps — text, a paste, a named key, or a raw byte — and writes them in **one**
write.

One write matters twice: it produces one input watermark, and it gives the program the best
chance of seeing an escape-prefixed sequence whole rather than a bare escape followed by the
rest. The steps are not separated by waits; a batch that waited between its steps would be a
scripted recipe, which is not this server's job.

A **paste** is text the program should take as an insertion, and it is a step of its own
because a mode decides what its bytes are. A program that has enabled bracketed paste
(`CSI ? 2004 h` — bash, zsh, fish and many REPLs do) receives the text wrapped in
`CSI 200 ~` … `CSI 201 ~` and inserts it literally, so a multi-line paste lands in a shell's
editing buffer without running a line of it; the same characters sent as text would execute at
every newline. The caller says *this is a paste*; the mode, read off the screen, says whether
that becomes a guarded insertion or plain characters — the same rule a named key follows. A
paste may not contain the terminator `CSI 201 ~`, which would end it early; the refusal is a
`bad_input`.

The result reports each step's own contribution and the canonical name of each key, whether a
paste was wrapped, plus the terminal modes any step consulted — the whole object `null` when no
step's bytes depended on a mode, and a mode a step did consult reported with its value,
`false` included.

## Reading

### `read_screen`

The last classified update: the screen, the change report, the collapsed count, the io
watermarks, and the session state. `seq` is the number of the state shown, and the same address
`history_read` accepts.

When nothing has arrived yet the update is `null` — explicitly *not* the same as an empty
screen.

**`view` rides along on every read**, when a view of the session has been opened: `null`
otherwise. It is the human half of the interaction, reported as facts and nothing more — see
[Human intervention](#human-intervention).

### `history_read`

One surface over the timeline rather than a pair of tools. Paging through what happened and
replaying the frames a group swallowed are the same operation at different settings:

- `from` and `to` take **any address** — a token, a sequence number, a timestamp, a byte
  offset — and the two ends need not be the same kind.
- `level` picks the projection: records, groups, or text.
- `screen: true` materializes the state at each point, which is what turns a read into a
  playback.

A **span** (with `to` set) is a replay and crosses a resize; a **page** (with `from` alone)
never does, and reports the grid size it was produced at. Because a span *is* a replay it
carries each record's screen whatever `screen` says, and each record names the epoch it was
produced at — one span may hold two sizes. This is what makes the intermediate states a group
collapsed reachable: read the group's span and they come back.

Omission is reported, never silent: a read that was cut says how much was left out, why, and
which sequence number to resume from. Both reads are bounded the same way — `limit` by count,
`maxChars` by characters, cut at a whole unit so the answer is never half a screen. The unit is
the record at the level asked for: a **delivery** at `records` and `text`, and a **group** at
`groups`. A group can carry the text of hundreds of deliveries, so `maxChars` bounds by group
there and a small budget may come back far over it — with `overBudget` set, so the caller is
told rather than left to assume the budget held.

Which end survives follows from which bound bit, and which way the read goes.

**A page with no `from` returns the newest.** A driver coming back after a gap can act on the
recent end and not on the part it has slept through, so that is the end it gets, and `omitted`
says how much older history it did not ask for. Give an address and the read goes forward from
there instead — paging is that walk, and a page with an address has a `next` to walk on with.

- **`limit` bounds the window at the end the read is anchored to**: it drops the tail of a
  forward read, and the older records of a back one. `omitted.fromSeq` is the delivery the
  omitted run is resumed from — the last one returned when the read went forward, the last one
  left behind when it went back.
- **`maxChars` protects a budget**, so it keeps the *newest* records of whatever window the read
  built, whichever way it was anchored. A span is the other way round: it is opened at an
  address the caller chose and read forward from there, so its budget keeps the *oldest*.

A single unit larger than the whole budget comes back in full rather than truncated, and
`overBudget` says so.

An older run is read with a **span**, not a page: there is no address that walks backwards, so
the way to see what a back read left out is `{from: <the epoch's start>, to: {seq:
omitted.fromSeq}}`.

## Waiting

Three waits, one skeleton. Each names only its own stopping reason and leaves what that means
to the caller — who is the one that knows what it is driving. None of them claims the program
has finished.

### The baseline the two bounded waits default to

`wait_for_output` and `wait_for_group` both ask "since when?", and both answer it the same way:
**the later of the state the caller last wrote at and the state it was last shown.**

The second half is not derivable from the first, and without it a caller that waits twice with
nothing in between is handed the same act again — which is indistinguishable from a new one
without keeping the sequence number by hand, and was measured on a driving run: two consecutive
group waits returning group 5 at state 9, and two consecutive pattern waits matching the same
row at the same byte. It is also the half the surface has to supply, because only `read_screen`
knows it handed a state over. **So a screen read moves the baseline: reading is looking.** A
history read does not — it is addressed by the caller and may be a look backwards, so where its
attention is is not something the surface can know.

Each watermark advances to the furthest point a result reported *in its own space* — a whole
frame moves it to that frame's read-through, a match to the row it matched, since the screen was
not handed over with it. An explicit `sinceByte` / `sinceSeq` always wins, which is how a caller
reaches back deliberately: a marker that repeats is asked for again by naming the byte the first
one arrived at. Every result reports the baseline it used, so "what did new mean here" is
answerable — and the number to *continue* from is `seq`, not that one.

### `wait_for_idle`

Blocks until output has been quiet for a requested interval and everything produced has been
read through, or until a timeout. Ends on `idle`, `exited` or `timeout`.

### `wait_for_output`

Resolves when a regular expression appears, or on `exited` / `timeout`. Unlike idle, a match is
a positive observation and needs no quiet period, so there is no interval to guess.

A pattern is offered **both sinks**, and a hit says which one it came from. The screen is a
state — including the row the cursor is still writing, which is where a prompt lives. The text
log is a stream — lines that completed, including ones that have scrolled out of the grid. A
prompt is never a completed line, so a matcher that pretended the two were interchangeable
would be wrong on one of them. A pattern is matched against a single row or a single line,
never a joined blob, and rows are trimmed so an anchored pattern means the same thing on either
surface.

The watermark defaults to the baseline above, so a prompt already on screen cannot match the
instant a wait starts, and a row already matched is not matched a second time; `sinceByte`
overrides it. The match carries where it was found and the byte at which the content arrived —
a fact about when the content arrived, not about when the match was noticed.

A match is an observation, not evidence the program has finished: the terminal echoes what is
typed, and an echo is new output too.

### `wait_for_group`

Blocks for the next group — a run of output closed by silence or by a cap. This is the wait a
full-screen TUI needs, because `wait_for_idle` is negative (it returns whether or not anything
happened) and a repainting menu has no stable text for a pattern to anchor on.

**The group wait returns the change with it** — the same report a read gives for that state —
so `send` then `wait_for_group` is a whole loop in two calls. Ends on `group`, `exited`,
`disposed` or `timeout`.

The baseline is a floor rather than a starting gun: an act that closed *after* it is returned
even if it closed before the wait was issued, so the round trip between a send and a wait
cannot lose the act the send caused. `sinceSeq` defaults to the baseline above — so an act the
wait just returned is not offered again either, and a wait with nothing new times out carrying
the screen it ended on.

The reason a group closed is reported, because the four do not mean the same thing: only `gap`
says the program went quiet. A cap cut a group open while it was still writing.

**`afterInput`** is whether the group's bytes sit after the last write — placement, not
causation. `false` is the case worth acting on: the wait ended on output that was already in
flight, so more input would be typing into something that has not read the last thing yet.

It is measured against the **last** write, which makes it reliable for your own `send_input`
(one call, one write) and weaker for a human's typing in a view: that arrives a keystroke at a
time, so the Enter that submits the line is stamped after the group carrying the echo has
already begun, and that group — the response — reports `false`. The wait still wakes and still
carries the human's text; only the flag is narrower than it reads. See the known limit in
[design.md](design.md) for the candidates.

A wait that does **not** resolve still names what it ended on — the screen it hands back comes
with the sequence number that state is filed under, so a timeout is a state you can go on to
address rather than one you have to re-read to name.

## Human intervention

Two tools, for the case where the agent is not the one who should be typing.

### `open_view`

Exposes a live session in a window a human can watch and type into. Returns `url`, which opens
in a browser, and `command`, which runs a terminal client in the human's own terminal — the
human gets a real terminal window without this server having to guess which emulator is
installed. Either client attaches; several may attach to one view.

The human sees the same screen the agent is shown and their keystrokes go **into the same
pty**, so what they do reaches the agent as ordinary output — through `read_screen`, through the
waits, through history. Nothing about the session changes: there is still one parser, one
screen, one timeline.

The grid follows the human's window by default (`followResize`), so a full-screen program draws
for the window it is actually in. That is a `resize_session`: it opens a new epoch and
everything recorded before it stays readable at the old size. Turn it off and the human's window
letterboxes instead.

Calling it twice returns the same view. Refused with `not_live` once the process has exited — a
view is for intervening, and there is nothing left to intervene in.

### `close_view`

Detaches every client and stops serving the view. The session is untouched. A view also ends on
its own when the session is closed or its process exits.

### What the agent is told

`read_screen` reports `view`:

```json
{ "attached": 1, "lastInputAt": 1760000000123, "lastInputBytes": 4 }
```

`attached` is a real count of connected clients, so `0` means nobody is on it. `lastInputAt`
and `lastInputBytes` are `null` before any human input — "no human has typed" and "we cannot
say" are different facts. `view` itself is `null` when no view has been opened, rather than an
object reporting zero: "there is no view" and "there is one with nobody on it" are not the same
thing, and a caller reading `attached === 0` must not be told the first when the second is true.

**What the human typed is not reported.** Not to the agent, and not back to the client. It is
visible to the agent to the extent the program echoes it and no further: a password typed at a
prompt with echo off stays between the human and the program, which is the only place either of
them would expect it to be. What the agent gets is enough for the thing it actually needs — to
stop assuming it is the only writer.

### The procedure this is for

The agent gets stuck — a TUI it cannot read, a prompt it cannot guess, a decision that is not
its to make. It calls `open_view`, tells the human what it needs, and **ends its turn**. On the
next turn it reads `view` off `read_screen` and sees whether a human intervened and when. There
is no wait for a human, and there is no `atPrompt`: whether anybody is there is not observable,
and a wait would be a judgement dressed as an observation. The fact that input arrived, and
when, is.

## How results are shaped

These are contract, not formatting:

- **Screens are trimmed** of the padding the grid writes them to — the trailing space of every
  row, and the blank rows below the last one carrying anything. Only ends are cut, so a glyph
  keeps its column and a delivered row keeps its index; a position past the end is blank, which
  means `changedRows` may name a row the screen does not carry, and that is a row that is blank
  now. A screen with nothing on it is `[]`. Nothing is lost: what was erased is in the
  change report, what was written is in the text.
- **Row lists are collapsed into runs.** `changedRows` is the one field that grows with the
  terminal rather than with what happened — a repaint touching every row of a tall grid names
  every row, at about four characters each, to say one thing. A contiguous stretch arrives as
  `"from-to"` and a lone row as the number it already was, so the common case pays nothing for
  the rare one. The model keeps `number[]`: this is the shape of a delivery, not of the fact,
  and a caller expands the entries before indexing the screen.
- **No change is `null`, not empty.** A result with nothing to report says so, which is the
  difference between "no group arrived" and "a group arrived that changed nothing".
- **Unknowns are `null`, never a fabricated default**, and so are values no decision depended
  on.
- **Everything is up front.** Evidence fields are hoisted to the top level of a segment; a
  caller that has to reach through a nested object to find the fact it needs is one that will
  not.
