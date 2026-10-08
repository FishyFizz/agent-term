---
name: agent-term
description: Usage guide for the agent-term MCP server — how to drive an interactive terminal program through its tools (open_session, send_input, send_sequence, wait_for_idle, wait_for_group, wait_for_output, read_screen, history_read, close_session). Use whenever you are operating a terminal session through agent-term, including black-box driving exercises where you are handed an interactive program to operate and are not told how it behaves.
---

# Driving a terminal through agent-term

The server hosts real terminal sessions and reports what happens on the screen. It
does not tell you what the program means, or whether it has finished; it reports
facts and leaves the judgement to you, because you are the one that knows what you
are driving.

## The loop

1. **`open_session`** — returns a `sessionId`, which every other tool needs. Takes
   `command`, `args`, `cwd`, `cols`, `rows`; with no `command` you get a platform
   shell. `args` is a separate array — do not put a whole command line in `command`.
   **The executable is spawned as given: there is no PATH or PATHEXT resolution.** If
   an interpreter or a script wrapper is not launching, name the file the platform
   actually executes (`foo.cmd` on Windows, not `foo`) or give an absolute path.
   **`cols` and `rows` are a token decision, not just a layout one.** Every screen you
   are shown is `rows` rows of `cols` characters, so they are paid for on *every* read
   and *every* group wait, for the whole session — a 140×40 grid costs about 12k tokens
   across nine screens, most of it blank. Pick the smallest grid the program's layout
   actually needs; a full-screen TUI's frame will wrap and repaint badly below its own
   minimum, so do not shrink past that to save bytes.
2. **`send_input`** — writes text as if typed. `submit: true` appends a line ending;
   without it no Enter is pressed.
3. **`send_sequence`** — writes several inputs in one call: `{text}`, `{paste}`, `{key}` or
   `{byte}`, in order. Use it for any keystroke that has no character — arrows, Tab, Escape,
   Ctrl-C — for "type this, then press Enter", and for `{paste}` when you are inserting
   content rather than typing keys.
4. **Wait — and take the change from the wait.** A read taken straight after a send
   returns the state from *before* the send was processed; this is the most common way a
   driver silently accomplishes nothing. **`wait_for_group` blocks until the program
   finishes one act of output and returns that act** — the screen, what changed on it
   (`segments`, `text`), and the session state — so `send` → `wait_for_group` is the whole
   loop in two calls. Reach for `wait_for_idle` only when "nothing arrived for a while" is
   the fact you want; it returns no screen, so seeing anything costs a second call.
5. **`read_screen`** — the last classified update and the state. For the same state that is
   what a group wait just handed you, so use it when you want the screen *without* waiting,
   or when output arrived after your wait ended.
6. **`close_session`** — ends the process tree. History stays readable afterwards.

## Keys

**Name the key; never hand-craft an escape sequence as text.** `send_sequence` takes steps:

```json
{ "sessionId": "…",
  "steps": [ { "text": "go" }, { "key": "down" }, { "key": "down" }, { "key": "enter" } ] }
```

Each step is exactly one of `text`, `paste`, `key` or `byte`. The whole batch is **one write, in
order** — so nothing can arrive between the parts of a key sequence.

- `{paste: "…"}` pastes text. When the program has enabled **bracketed paste**
  (`CSI ? 2004 h` — bash, zsh, fish and many REPLs turn it on) the text is wrapped in
  `ESC [ 200 ~` … `ESC [ 201 ~`, which is a literal insertion: **a multi-line paste goes into
  the shell's editing buffer without running**, where the same characters as `{text}` would
  execute at every newline. With the mode off the characters are written plain. The mode is
  read off the screen, so wait for the program to print something before pasting, and
  `modes.bracketedPaste` reports which it was. Use `{paste}` when you are inserting content —
  a command block, a file body, a paragraph — rather than typing keys.

- Keys: `up down left right home end insert delete pgup pgdn f1..f12 tab shift+tab enter
  backspace esc space ctrl+a..ctrl+z ctrl+\ ctrl+] ctrl+^ ctrl+_ alt+<char>`. Names are read
  loosely — `Arrow-Down` and `ARROWDOWN` both work.
- `{byte: 27}` or `{byte: "0x1b"}` sends a raw byte, `0x01`–`0x7f`. That is the escape hatch
  for a byte no key names.
- Bytes below `0x01` and above `0x7f` are refused, and the error says why: ConPTY carries
  input as UTF-8, so `0x00` is dropped and `0x80`–`0xff` arrive as U+FFFD. Both were measured.
  To send a character outside ASCII, use `{text}`.
- **Ctrl-C is a keystroke, not a kill**: `{key: "ctrl+c"}` writes `0x03`, so the line
  discipline raises SIGINT for a cooked program and a raw-mode program receives the byte —
  which is what a keyboard does.

A key is encoded for the mode the program has set, read off the screen: `down` is `CSI B`
normally and `SS3 B` when the program has enabled application cursor keys. That is why a
program that never advertises readiness can still get the wrong byte — the mode it set has
not been parsed yet. Wait for output from the program before sending it keys.

**A key that only counts twice in quick succession has to go in one batch.** Two
`{key: "ctrl+c"}` steps in one call arrive as one write, which is what a program waiting for
a double press is measuring. Sent as two calls they are a model round trip apart — seconds —
so the program sees two single presses and the gesture does nothing, which reads exactly like
a key that was ignored. Measured in a driving run: two `ctrl+c` calls 21s apart, a screen that
did not change, and six further calls spent establishing that nothing had happened.

**Nothing waits inside a batch.** It is a sequence of writes at one instant, not a script
with reactions. Send, then wait, then read — keep that loop in your own control.

`send_sequence` and `send_input` both report `written`: the bytes as they were actually
handed to the terminal, escaped (`\x1bOB`). Compare it with what you meant to send. If it
does not match, the bytes were lost between you and the server, and no amount of reading the
screen will tell you that as directly.

## Waiting

Three waits, answering different questions. All are bounded — you never supply a polling
interval, and you should never sleep instead. **`wait_for_group` is the default for a
full-screen program**: it is the only wait that returns the change with the verdict, so it
ends a loop rather than starting a second call.

**`wait_for_idle {idleMs, timeoutMs}`** — blocks until the pty has been quiet for
`idleMs` *and* everything it produced has been parsed. Returns `reason`:

- `idle` — the quiet period you asked for was observed. **Idle is not finished.** A
  program is idle both when it is waiting for you and when it is thinking.
- `exited` — the process is gone and its output has been read through. Nothing more
  can arrive.
- `timeout` — it gave up; `state` says what it saw.

**This wait returns no screen, and on `exited` that costs you a call.** Watching a program
end is usually `wait_for_idle` → `read_screen`, because the thing you want to see is the last
frame it drew. `wait_for_group`'s `exited` branch returns the screen with the verdict, so when
what you are waiting for is the program *finishing*, reach for that one instead — one call
where the pairing takes two.

Always branch on `reason`. Treating a timeout as idle is how a driver reports success
at nothing. Choose `idleMs` from what the program does, not from what you hope: a
program with slow startup looks idle while it is merely quiet.

**`wait_for_output {pattern, surface?, sinceByte?, timeoutMs}`** — blocks until a
regular expression appears. Returns `reason` (`matched`, `exited`, `timeout`) and,
when it matched, `match` = `{surface, text, atByte, row, buffer}`. **When it does not
match, `screen` carries the rows as they were when the wait ended** — so a timeout
already answers "what is it showing?", with `seq` naming the state those rows are at,
and you do not read again to find out; it is `null` on `matched`, where the match is
the answer. Prefer this over wait-then-eyeball whenever the program has a readiness
signal you can name.

- Matched against **screen rows the session wrote** and **completed lines it
  emitted** — `surface: 'screen' | 'text' | 'both'`, default both.
- Trailing blanks are stripped first, so a prompt printed as `foo> ` is a row whose
  content is `foo>`. Anchor with `^...$` to mean a whole line.
- Only output produced after `sinceByte` counts, which defaults to the byte the
  session was last typed into. A prompt that was already on screen therefore does
  *not* match the instant the wait starts — the default is what makes this answer
  "did the program react?" rather than "is this text somewhere on screen?".
- **The terminal echoes what is typed.** The echo is new output, and it carries your
  own words. An anchored pattern is usually what distinguishes a prompt from the echo
  of the command sent at it.
- A match is an observation, not a verdict: it says the text appeared, not that the
  program is done.

**`wait_for_group {sinceSeq?, timeoutMs}`** — blocks until the program finishes **one act of
output**. This is the wait a full-screen TUI needs. Returns `reason` (`group`, `disposed`,
`exited`, `timeout`) and, on a group, the act whole: `seq`, `group`, `collapsed`, `screen`,
and the same `segments`/`changedRows`/`text`/`io` a read reports for that state — **so a group
wait is not a prelude to a read.** On `exited`/`timeout`/`disposed` no act arrived: those three
are `null`, and `screen` is what the terminal looks like at that moment.

- A repainting menu has no stable text to anchor a pattern on, and idle answers "it went
  quiet" without saying whether a repaint happened at all. A group ends where the run
  of output did — which is measured, not interpreted (see §From facts to a use case).
- **`text` and `segments` are the part a screen cannot show you.** `text` is the lines the
  act completed; `segments` is what its bytes did to the grid — appended text or a redrawn
  surface, and whether they erased or overwrote. **`text: []` beside a non-empty `segments`
  is an act that repainted without writing a line**: a cursor moving, a highlight following
  it, a menu drawn over itself. A cursor move can leave every row identical, so comparing
  the two screens calls it "nothing happened"; the fields do not. That is the difference
  between a key that did something invisible and a key that was ignored.
- **`changedRows` is the row-level half of `segments`, and the one to read when the change
  is a glyph rather than a line.** It names the rows of `screen` that differ from before the
  act — a highlight moving is one or two rows, where the byte span covers a whole region and
  two screens compared by eye report nothing at all. **Empty `changedRows` beside a non-empty
  `segments` means the act touched no row**: a cursor moving, or a write into cells that
  already held those glyphs. Only indices are given, because the rows themselves are in
  `screen` and the ones they replaced are one `history_read` away — read
  `screen[y]` for each `y` in `changedRows` and you have the new state of every row that
  moved, without comparing anything.
- **`collapsed.reason` says how it ended, and the four do not mean the same thing**: `gap`
  no bytes arrived for `gapMs`; `bytes`/`chunks` are the caps being reached, cutting a group open
  **while it is still writing**, so more output is coming; `flush` is a resize or exit.
- **`collapsed.chunks > 1` means states existed that you were not shown.** Read them with
  `history_read({from:{seq:collapsed.rawFrom}, to:{seq}})`.
- `sinceSeq` defaults to the state you last typed at, so a group that closed *before* your
  input cannot satisfy the wait. Pass the `seq` you last saw to continue from there — a
  firehose produces a stream of groups, so loop on it.
- **The baseline is a floor, not a starting gun.** A group that closed *after* it is still
  the answer when you ask for it — it does not have to close *while* you wait. Between your
  send and your wait there is a round trip, and a program that repaints in 70ms has finished
  its act long before your wait arrives; that act is returned anyway. So it is safe to send,
  do something else, and wait afterwards — the act you caused is not lost to the gap.

For example, a menu that repaints on every keypress: send `down`, then
`wait_for_group {timeoutMs: 5000}`. That resolves on the repaint, not on a guess about time,
and hands you the repaint — `text: []` with a `drawing` segment — so there is nothing left to
read.

Or a REPL that prints `>>> ` when it is ready: after sending a line, wait for
`{pattern: "^>>>$", timeoutMs: 20000}`. That resolves on the *next* prompt, not the one
you were already looking at.

## Reading

`read_screen` returns `screen` (the rows as of the last classified update — not a fresh
snapshot, so `state.bytesPending > 0` means bytes have arrived that it does not show yet),
`state`, and, once output has arrived, that update's change report. **A `wait_for_group`
returned this same report for the state it ended at**, so reading straight after one is the
same answer again unless output arrived since.

**Rows come back trimmed of trailing blanks.** The grid is `cols` wide and the pty pads
every row to it, so an untrimmed 140-column screen is 140 characters a row whether or not
the program wrote them; you are given the row's content instead. Every row is still in the
array **at its own index**, and a row the program blanked is `''` rather than a shift, so
row numbers and columns mean what they always did — a glyph keeps its column, because only
the end is cut. Nothing is lost by it: a row that was erased or overwritten is in
`segments`, and a line that was written is in `text`.

- `segments` — what changed, as spans of byte range, each flagged `erased`,
  `overwrote`, `reachedBack`, `scrolledBy`, `altScreen`. The server has already
  decided whether a change is appended text or a redrawn surface; you do not have to.
- `changedRows` — which rows of `screen` differ from before this update, as row
  indices. The row-level half of `segments`: read `screen[y]` for each `y` and you have
  the new content of every row that moved, with no comparison of two screens and no
  guessing which of forty rows to look at. Scroll-aware, so a log moving up reports the
  rows that truly changed rather than every row that shifted.
- `text` — the lines this update completed, in order. This is the record of what was
  *written*, including lines that have already scrolled off the screen. **Empty `text`
  beside a non-empty `segments` means the update repainted and wrote no line.**
- `collapsed` — present when output was grouped. `intermediates: true` means the
  screen you are looking at is the net effect of several deliveries, and **states
  existed that you were not shown**. Those states are not lost: take
  `collapsed.rawFrom`/`rawTo` and read them with
  `history_read({from:{seq:rawFrom}, to:{seq:rawTo}})`.
- `io` — `bytesRead`, a monotonic watermark you can compare against a later read, and
  `bytesPending`.

### `seq` — one number for the whole timeline

Every result carries `seq`, and it is **the number of the state you are being shown**,
not a count of updates. It is incremented once per raw delivery, and it is the same
number `history_read` addresses, so the number in your hand is one you can read
history with:

- A group covering states 3..9 reports `seq: 9`. States 3..9 all exist and are
  readable; 9 is just where the update landed.
- `seq` never skips. A group is a projection over a run of states and takes no number of
  its own.
- **On a wait that did not resolve, `seq` is the state the `screen` beside it is at** — not
  the baseline. So a screen handed to you by a timeout or an exit is one you can name: read
  it back, compare it against a later read, or `history_read` from it. Reaching for a read
  purely to get a screen you can address is a round trip you do not need.
- **All three waits carry it, including `wait_for_idle`**, which has no screen to show. The
  moment a wait stopped is still a moment you can `history_read` on from.

**`seq` and `group` are not the same number**, and mixing them silently narrows what you
see: a group spanning 1..4 has `seq: 4`, so looking its records up by `seq` finds only
the last one. `group` is what every record in the span shares.

`state` rides on every read: `running`, `idleMs` (`null` before the first byte),
`drained`, `bytesPending`, `exit`. It is how you tell "output has finished" from "the
server has not caught up" — `drained: false` after an exit is a read that is missing
its tail. `null` means not knowable; it never means zero.

An update of `null` means nothing has arrived yet. That is not an empty screen — look
at `screen`.

## From facts to a use case

The server reports what it measured. Turning that into "the program is ready" / "this
selection took effect" / "it finished" is **your** job, and this is the section that says
how. The pattern is always the same: **a fact is something the server observed; a use case
is a claim about the program.** Cross that line only with evidence you assembled yourself.

### The three questions you actually have

| You want to know | What the server gives you | What you must add |
|---|---|---|
| Did my input do anything? | `written`, `afterInput`, the wait's `text`, `segments` and `changedRows` | `written` proves what was sent, never that the program read it. `afterInput: true` beside a non-empty `segments` is output that followed your write — `text` shows the line it wrote, a `text: []` there shows one it only redrew, and `changedRows` says which rows the redraw landed on. |
| Is the program waiting for me? | **nothing** — it is not observable | See below. Do not look for `atPrompt`; it does not exist, by measurement. |
| Is it done? | `reason: idle/exited/timeout`, `state.drained` | Nothing proves "done" while it runs (L1.2). `exited` + `drained` is the only closed set. Otherwise: name a signal the program prints, or accept a confidence interval. |
| Did this repaint mean anything? | `text`, `segments` and `changedRows` from the wait, `collapsed.chunks`, `seq` | `text: []` with a non-empty `segments` is a repaint that wrote no line; `changedRows` names the rows it landed on, which a glyph flip shows and a screen-to-screen comparison hides; `collapsed.chunks > 1` means states were swallowed — read the span with `history_read`. |

### "Is it waiting for me?" — not observable, and what to do instead

There is deliberately **no `atPrompt`**. This was measured, not assumed:

- **Process state** — a shell at a prompt and the same shell busy on a builtin are identical
  (same pid, same name, same thread count).
- **Child processes** — distinguishes `ping`, but a busy *builtin* has no child, so it reads as
  "at prompt".
- **Echo probing** — echoes in both states, and it *writes to the thing observed*.
- **node-pty** — exposes no unread-byte query; ConPTY has no foreground-process-group concept.

A field answering that question would be a judgement dressed as an observation. **What you get
instead is two facts:**

- **`state.inputUnconsumed`** — bytes you sent that no output has followed. `null` before any
  input, `0` once something came back. **A byte count, not a verdict.**
- **`afterInput`** on a group wait — whether the group's bytes sit after your last write.
  Placement, not causation: output after input may still be unrelated to it.

**What to actually do:**

1. **Anchor on text the program prints.** `wait_for_output` on the prompt string, the result
   marker, whatever the program *says*. This is an observation; a guess about readiness is not.
2. **Use `afterInput: false` as your warning.** It means the wait ended on output already in
   flight — sending more now types into something that has not read the last thing yet.
3. **Accept that slow and empty look the same.** `ls` that "looked like nothing happened" is
   not distinguishable from `ls` of an empty directory until bytes arrive. Report that you
   could not tell; do not invent a conclusion.

### Working rules

1. **State the observation, then the inference, separately.** "The wait returned
   `gap` after 40ms and the screen shows `beta` selected" is two sentences for a reason.
   Collapsing them into "it selected beta" hides the one thing you could be wrong about.
2. **A null is not a zero.** `collapsed: null` means nothing was merged. `text: []` does not
   mean nothing happened — it means nothing was *written*; `segments` is where a repaint
   shows up. `state.bytesPending` is `null` when the number is not knowable, and `0` only
   when it is genuinely zero.
3. **`reason` describes the wait, not the program.** `gap` = no bytes for `gapMs`;
   `bytes`/`chunks` = a cap was reached; `flush` = resize/exit/dispose forced it. None of
   them says the program is still working, is idle, or will produce more.
4. **Anchor on text when the program gives you any.** A pattern is an observation; a guess
   about time is a guess. Use `wait_for_group` when there is no stable text, and say so.
5. **When you cannot tell, say you cannot tell.** "The menu returned to its root with
   `((unset))` still showing; I could not confirm the selection took effect" is a correct
   report. Inventing a conclusion is the one failure mode this whole design exists to
   prevent.

### Example: a full-screen menu

```
send_sequence {key: down}          → written: the bytes
wait_for_group {timeoutMs: 5000}   → reason: group   collapsed.reason: gap   seq: 12
                                     text: []        segments: [{…}]
                                     screen: the rows, with the highlight on row 2
```

Two calls, nothing left to read — the wait carried the act. Facts: bytes written; a group
closed after a gap at state 12; those bytes changed the grid and **completed no line**
(`text: []`, with a segment covering them). **Inference (yours):** the arrow key moved the
selection. The server never claimed that, and could not — it saw bytes out and a repaint
back.

## Errors

Failures carry `isError: true` and `structuredContent.error.code`: `no_session`,
`not_live` (the process has exited), `bad_input` (a batch that could not be composed — an
unknown key name, a step with two fields or none, an empty batch, a byte outside the range
ConPTY carries), `bad_pattern` (your regex did not compile). Branch on the code; the message
is for a human and says what to fix.

## What the server will not decide for you

- Whether the program is finished, ready, or blocked on input. That is `idle` /
  `exited` / `drained` plus what is on the screen, and it is your call.
- What the output means. It does not summarise, parse, or interpret.
- Whether your input was consumed. The next evidence is output, or a prompt.
- What a program is waiting for: blocked on a prompt and still working look identical
  to a byte interface. Wait on the pattern it prints when it is ready, or on enough
  idle to be confident.
- **Whether your keystroke was received as a keystroke.** `send_sequence` reports the bytes
  it wrote, so you can check them against what you meant. What you cannot check is the
  program's reading of them.
- **A program that never enables raw input receives nothing until a line ending
  arrives.** Measured, not guessed: a child that has not called `setRawMode` is
  line-buffered, so keystrokes written into it sit in the line discipline unseen. If a
  program ignores a key and its own documentation says it should accept it, that is a fact
  about the program, not about the key-sending — say so rather than retrying.
- **Bytes that depend on a mode the program set but has not yet printed.** `down` is
  encoded from `applicationCursorKeysMode` as it stands at the moment of the send, and a
  paste is wrapped from `bracketedPasteMode` the same way; a program that turns a mode on
  and is typed at in the same breath can still get the mode-off form. Wait for output from
  the program first — the result's `modes` field says which mode the encoding used, and
  `modes.bracketedPaste: false` on a paste means the program had not enabled it.

## Habits that make a run legible

- Send one thing, wait for it, and take the change from the wait. Keep that order.
- **Name keys; do not craft escape bytes as text.** A raw `ESC` typed as text is exactly
  what a transport drops, and a lone `ESC` is ambiguous to a reader besides. If
  `send_sequence` does not know the key you need, `{byte}` is the fallback — and if that
  is outside `0x01`–`0x7f`, use `{text}` and send the character.
- Report the facts you observed — what you sent, what the wait returned, what the
  screen showed — rather than a conclusion the observations do not support.
- When a wait times out, say what it ended on instead of retrying blindly. A timeout is
  information, and `wait_for_output` and `wait_for_group` already carry the screen they
  timed out at — only `wait_for_idle` leaves you needing a read.
- Prefer an explicit anchored pattern over a long `idleMs`: a guess about time is a
  guess, a pattern is an observation.
- Keep the `bytesRead` watermark from a read when you expect to compare it with a
  later one.

## Pitfalls

- **`npx` will not spawn.** On Windows the `npx` on `PATH` is often a shim shell
  script, not an executable, and the session is spawned as given — there is no `PATH`
  or `PATHEXT` resolution. It fails with `Cannot create process, error code: 2`. Give
  the absolute path to `npx.cmd` (under wherever node is installed, e.g.
  `C:/Program Files/nodejs/npx.cmd`), or resolve it once with `which`/`where` before
  opening the session. The same applies to any wrapper script, not just `npx`.
- **A timeout is not a blank screen.** `wait_for_output` returns the rows it ended on
  when it does not match, so read them before concluding nothing happened.
- **Do not join on `seq` when you mean the group.** See §Reading: a group spanning 1..4
  has `seq: 4`, and matching its records against `seq` matches only the last one.
