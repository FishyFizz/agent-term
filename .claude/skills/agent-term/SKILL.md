---
name: agent-term
description: Usage guide for the agent-term MCP server — how to drive an interactive terminal program through its tools (open_session, send_input, wait_for_idle, wait_for_output, read_screen, close_session). Use whenever you are operating a terminal session through agent-term, including black-box driving exercises where you are handed an interactive program to operate and are not told how it behaves.
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
3. **Wait. Do not read immediately.** A read taken straight after a send returns the
   state from *before* the send was processed. This is the most common way a driver
   silently accomplishes nothing.
4. **`read_screen`** — what is on the screen now, what changed, and the session state.
5. **`close_session`** — ends the process tree. History stays readable afterwards.

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
when it matched, `match` = `{surface, text, atByte, row, buffer}`. Prefer this over
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

For example, a REPL that prints `>>> ` when it is ready: after sending a line, wait
for `{pattern: "^>>>$", timeoutMs: 20000}`. That resolves on the *next* prompt, not
the one you were already looking at.

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
  existed that you were not shown**. Nothing on the surface pages back to them yet;
  read it as a warning that a redraw may have hidden something, not as a handle.
- `io` — `bytesRead`, a monotonic watermark you can compare against a later read, and
  `bytesPending`.

`state` rides on every read: `running`, `idleMs` (`null` before the first byte),
`drained`, `bytesPending`, `exit`. It is how you tell "output has finished" from "the
server has not caught up" — `drained: false` after an exit is a read that is missing
its tail. `null` means not knowable; it never means zero.

An update of `null` means nothing has arrived yet. That is not an empty screen — look
at `screen`.

## Errors

Failures carry `isError: true` and `structuredContent.error.code`: `no_session`,
`not_live` (the process has exited), `bad_input`, `bad_pattern` (your regex did not
compile). Branch on the code; the message is for a human.

## What the server will not decide for you

- Whether the program is finished, ready, or blocked on input. That is `idle` /
  `exited` / `drained` plus what is on the screen, and it is your call.
- What the output means. It does not summarise, parse, or interpret.
- Whether your input was consumed. The next evidence is output, or a prompt.
- What a program is waiting for: blocked on a prompt and still working look identical
  to a byte interface. Wait on the pattern it prints when it is ready, or on enough
  idle to be confident.
- **Key events.** `send_input` sends text; arrows, Tab, Escape and Ctrl-C are not on
  the surface yet. If a program needs a keystroke it has no character for, say so
  rather than acting as though the interaction happened.

## Habits that make a run legible

- Send one thing, wait for a signal you can name, then read. Keep that order.
- Report the facts you observed — what you sent, what the wait returned, what the
  screen showed — rather than a conclusion the observations do not support.
- When a wait times out, read the screen and say what you saw instead of retrying
  blindly. A timeout is information.
- Prefer an explicit anchored pattern over a long `idleMs`: a guess about time is a
  guess, a pattern is an observation.
- Keep the `bytesRead` watermark from a read when you expect to compare it with a
  later one.
