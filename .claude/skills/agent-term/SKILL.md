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
2. **`send_input`** — writes text as if typed. `submit: true` appends a line ending;
   without it no Enter is pressed.
3. **`send_sequence`** — writes several inputs in one call: `{text}`, `{key}` or `{byte}`,
   in order. Use it for any keystroke that has no character — arrows, Tab, Escape, Ctrl-C —
   and for "type this, then press Enter".
4. **Wait. Do not read immediately.** A read taken straight after a send returns the
   state from *before* the send was processed. This is the most common way a driver
   silently accomplishes nothing.
5. **`read_screen`** — what is on the screen now, what changed, and the session state.
6. **`close_session`** — ends the process tree. History stays readable afterwards.

## Keys

**Name the key; never hand-craft an escape sequence as text.** `send_sequence` takes steps:

```json
{ "sessionId": "…",
  "steps": [ { "text": "go" }, { "key": "down" }, { "key": "down" }, { "key": "enter" } ] }
```

Each step is exactly one of `text`, `key` or `byte`. The whole batch is **one write, in
order** — so nothing can arrive between the parts of a key sequence.

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

**Nothing waits inside a batch.** It is a sequence of writes at one instant, not a script
with reactions. Send, then wait, then read — keep that loop in your own control.

`send_sequence` and `send_input` both report `written`: the bytes as they were actually
handed to the terminal, escaped (`\x1bOB`). Compare it with what you meant to send. If it
does not match, the bytes were lost between you and the server, and no amount of reading the
screen will tell you that as directly.

## Waiting

Two waits. They answer different questions, and both are bounded — you never supply
a polling interval, and you should never sleep instead.

**`wait_for_idle {idleMs, timeoutMs}`** — blocks until the pty has been quiet for
`idleMs` *and* everything it produced has been parsed. Returns `reason`:

- `idle` — the quiet period you asked for was observed. **Idle is not finished.** A
  program is idle both when it is waiting for you and when it is thinking.
- `exited` — the process is gone and its output has been read through. Nothing more
  can arrive.
- `timeout` — it gave up; `state` says what it saw.

Always branch on `reason`. Treating a timeout as idle is how a driver reports success
at nothing. Choose `idleMs` from what the program does, not from what you hope: a
program with slow startup looks idle while it is merely quiet.

**`wait_for_output {pattern, surface?, sinceByte?, timeoutMs}`** — blocks until a
regular expression appears. Returns `reason` (`matched`, `exited`, `timeout`) and,
when it matched, `match` = `{surface, text, atByte, row, buffer}`. **When it does not
match, `screen` carries the rows as they were when the wait ended** — so a timeout
already answers "what is it showing?" and you do not read again to find out; it is
`null` on `matched`, where the match is the answer. Prefer this over
wait-then-eyeball whenever the program has a readiness signal you can name.

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
`exited`, `timeout`) and, on a group, `seq`, `group`, `collapsed` and `screen` together.

- A repainting menu has no stable text to anchor a pattern on, and idle answers "it went
  quiet" without saying whether a repaint happened at all. A group ends where the run
  of output did — which is measured, not interpreted (see §From facts to a use case).
- **`collapsed.reason` says how it ended, and the four do not mean the same thing**: `gap`
  no bytes arrived for `gapMs`; `bytes`/`chunks` are the caps being reached, cutting a group open
  **while it is still writing**, so more output is coming; `flush` is a resize or exit.
- **`collapsed.chunks > 1` means states existed that you were not shown.** Read them with
  `history_read({from:{seq:collapsed.rawFrom}, to:{seq}, screen:true})`.
- `sinceSeq` defaults to the state you last typed at, so a group that closed *before* your
  input cannot satisfy the wait. Pass the `seq` you last saw to continue from there — a
  firehose produces a stream of groups, so loop on it.
- **`collapsed.grid` is `null` on a resize or an alt-screen switch**, which are the largest
  changes there are, not the smallest. Do not read `grid: null` as "nothing happened".

For example, a menu that repaints on every keypress: send `down`, then
`wait_for_group {timeoutMs: 5000}`. That resolves on the repaint, not on a guess about time.

Or a REPL that prints `>>> ` when it is ready: after sending a line, wait for
`{pattern: "^>>>$", timeoutMs: 20000}`. That resolves on the *next* prompt, not the one
you were already looking at.

## Reading

`read_screen` returns `screen` (the rows as they are now), `state`, and — once output
has arrived — the last classified update:

- `segments` — what changed, as spans of byte range, each flagged `erased`,
  `overwrote`, `reachedBack`, `scrolledBy`, `altScreen`. The server has already
  decided whether a change is appended text or a redrawn surface; you do not have to.
- `text` — the lines this update completed, in order. This is the record of what was
  *written*, including lines that have already scrolled off the screen.
- `collapsed` — present when output was grouped. `intermediates: true` means the
  screen you are looking at is the net effect of several deliveries, and **states
  existed that you were not shown**. Those states are not lost: take
  `collapsed.rawFrom`/`rawTo` and read them with
  `history_read({from:{seq:rawFrom}, to:{seq:rawTo}, screen:true})`.

### `seq` — one number for the whole timeline

Every result carries `seq`, and it is **the number of the state you are being shown**,
not a count of updates. It is incremented once per raw delivery, and it is the same
number `history_read` addresses, so the number in your hand is one you can read
history with:

- A group covering states 3..9 reports `seq: 9`. States 3..9 all exist and are
  readable; 9 is just where the update landed.
- `seq` never skips. A group is a projection over a run of states and takes no number of
  its own.

**`seq` and `group` are not the same number**, and mixing them silently narrows what you
see: a group spanning 1..4 has `seq: 4`, so looking its records up by `seq` finds only
the last one. `group` is what every record in the span shares.
- `io` — `bytesRead`, a monotonic watermark you can compare against a later read, and
  `bytesPending`.

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
| Did my input do anything? | `written` (the bytes), then `wait_for_group` / a pattern | Compare the screen before and after. `written` proves what was sent, never that the program read it. |
| Is it done? | `reason: idle/exited/timeout`, `state.drained` | Nothing proves "done" while it runs (L1.2). `exited` + `drained` is the only closed set. Otherwise: name a signal the program prints, or accept a confidence interval. |
| Did this repaint mean anything? | `collapsed.chunks`, `seq`, the screen | Read the span with `history_read`; a highlight that moved and moved back nets to no visible change, and only the count says anything happened. |

### Working rules

1. **State the observation, then the inference, separately.** "The wait returned
   `gap` after 40ms and the screen shows `beta` selected" is two sentences for a reason.
   Collapsing them into "it selected beta" hides the one thing you could be wrong about.
2. **A null is not a zero.** `grid: null` means *no grid delta exists* — which includes a
   resize and an alt-screen switch, some of the largest changes there are, and a change
   that touched only the cursor. `collapsed: null` means nothing was merged. Neither means
   "nothing happened".
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
send_sequence {key: down}             → written: the bytes
wait_for_group {timeoutMs: 5000}      → reason: group, collapsed.reason: gap, seq: 12, screen
read the screen                       → the highlight moved to row 2
```

Facts: bytes written; a group closed after a gap at state 12; the screen shows row 2
highlighted. **Inference (yours):** the arrow key moved the selection. The server never
claimed that, and could not — it saw bytes out and a repaint back.

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
- **A key whose bytes depend on a mode the program set but has not yet printed.**
  `down` is encoded from `applicationCursorKeysMode` as it stands at the moment of the
  send; a program that turns it on and is typed at in the same breath can still get
  `CSI B`. Wait for output from the program first — the result's `modes` field tells you
  which mode the encoding used.

## Habits that make a run legible

- Send one thing, wait for a signal you can name, then read. Keep that order.
- **Name keys; do not craft escape bytes as text.** A raw `ESC` typed as text is exactly
  what a transport drops, and a lone `ESC` is ambiguous to a reader besides. If
  `send_sequence` does not know the key you need, `{byte}` is the fallback — and if that
  is outside `0x01`–`0x7f`, use `{text}` and send the character.
- Report the facts you observed — what you sent, what the wait returned, what the
  screen showed — rather than a conclusion the observations do not support.
- When a wait times out, read the screen and say what you saw instead of retrying
  blindly. A timeout is information.
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
