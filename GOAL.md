# GOAL.md — AgentTerm

> An MCP server that lets an agent operate a terminal the way a human does: it owns real
> virtual terminal sessions, watches them change, and reports those changes back in the
> form that actually makes sense for the kind of program that is running.

## Why

Agents already "run commands", but the primitives they get are wrong for modern terminals.

Two very different things come out of a CLI application:

1. **Streaming text.** A compiler, a test runner, `ls`, `grep`, a curl of an API. Output is
   append-only prose. What the agent wants is *the new text since last time*, in order. If
   you hand it a screen render of a build log you waste enormous context on repeated frames
   and lose the part that scrolled off.
2. **A redrawn surface.** `vim`, `htop`, `fzf`, `lazygit`, a TUI installer, a progress
   dashboard, a REPL doing inline redraw. The output is not a stream — it is a *state*.
   Sending the agent the raw escape-sequence byte stream is noise; sending it only "new
   bytes" gives it fragments of a picture it cannot reconstruct. What it wants is *the
   screen*: what is on it now, and how it differs from what was on it a moment ago.

Existing MCP terminal servers collapse both into "here are some bytes" or "here is a
truncated tail of the scrollback". The agent then has to guess which world it is in, and it
usually guesses wrong — it fights TUIs and it drowns in logs.

AgentTerm exists to make that distinction **first-class and automatic**, and to keep
everything it ever saw so the agent can go backwards.

## What it is

A single MCP server, running locally, that hosts **virtual terminal sessions** (real PTYs
with a real shell/process inside) and exposes them to an agent as durable, addressable
objects rather than as one-shot `exec` calls.

Each session:

- is long-lived and independent, with its own identity, size, working directory, and
  environment;
- accepts input as a human would give it — text, keystrokes, control/function keys, pastes,
  resizes — not as an argv string;
- is continuously observed, and every change is **classified** before it is reported.

## Core concepts

**Session** — a hosted terminal with a process tree inside it. Created, listed, inspected,
resumed, resized, and closed by the agent. Survives between tool calls and between agent
turns. Many can exist at once.

**Writing** — output that behaves like a document: text appended downward, scrolled, and
otherwise immutable once emitted. Reported to the agent as the *delta of new text* since it
last looked.

**Drawing** — output that behaves like a canvas: the program repositions the cursor, erases,
overwrites, redraws regions, moves to an alternate screen. Reported to the agent as a
*screen capture* — the full current screen, or the delta against a previous screen state
when that is the cheaper and clearer thing to send.

**Classification** — the server decides, per update, whether the change is writing or
drawing (or a mix of both), and reports accordingly. The agent must not have to run its own
heuristics, inspect escape sequences, or guess which mode a program is in. Misclassification
is a bug in the server, not a puzzle for the agent.

**History** — an append-only timeline per session holding everything: all writing, and all
screen states (or the states needed to reconstruct them), interleaved in true chronological
order. The agent can page back through it, jump to a point in time or a point in the
sequence, and see the terminal as it was — whether that moment was text, a screen, or a
mixture. History is a first-class thing to query, not a debug log.

**Observation** — a session can optionally be surfaced to the human user, live, so they can
watch what the agent is doing in the terminal. The user is a spectator by default.

## Goals

These are the capabilities that define done. They are deliberately stated as outcomes, not
as components; how they are built is the next step.

### G1 — Host real terminal sessions

- Start a session and get back a stable handle; run many in parallel without interference.
- Anything a human can run in a terminal runs in it: shells, REPLs, full-screen TUIs,
  long-lived servers, interactive prompts, programs that read from stdin and expect a TTY.
- The session is honest about being a TTY — programs that check `isatty`, query cursor
  position, request terminal size, enable raw mode, or emit color all behave correctly.
- Sessions are resizable while running, and the program inside is told.
- Sessions can be closed cleanly; their history remains inspectable afterwards.

### G2 — Feed the agent the right shape of update

- Every update delivered to the agent is tagged **writing** or **drawing** (or mixed),
  decided by the server.
- *Writing* is delivered as new text only — no re-sending what the agent already has.
- *Drawing* is delivered as a screen capture: the current screen in full when that is what
  is needed, a delta when a delta conveys the change. The agent is never handed raw escape
  sequences and asked to interpret them.
- The feed is continuous and ordered: the agent does not have to poll blindly or invent
  sleeps to "wait for output".
- A screen capture is faithful — the agent sees what a human at that terminal would see,
  including layout and position, not a flattened approximation.
- Updates are bounded. A runaway program producing megabytes of output, or a TUI repainting
  at 60fps, must not flood the agent; the server coalesces, summarizes, or holds back
  without losing the ability to reconstruct what happened.

### G3 — Preserve everything, retrievable in order

- Full history of both kinds, per session, interleaved chronologically.
- The agent can go backwards: page through prior output, seek to a timestamp or a sequence
  point, and retrieve prior screen states, not just prior text.
- Mixed regions are preserved as mixed — a session that starts as a build log and then drops
  into a TUI keeps both, in the right order, and the transition point is visible.
- History survives the process exiting, and is queryable after the fact.
- Retrieval is scoped and cheap: the agent asks for a window of history and gets that
  window, not the whole session.

### G4 — Interact like a human

- Send text, line-by-line input, individual keystrokes, control and function keys, and
  large pastes, with explicit control over whether a line is submitted.
- Deal with programs that ask questions: the agent can see a pending prompt as a pending
  prompt and answer it, rather than guessing whether output has finished.
- Send signals and interrupts the way a human would reach for Ctrl-C.
- Compose an interaction — write, wait for a specific change, respond — without a
  turn-shaped round trip per keystroke.

### G5 — Show the terminal to the user

- Any session can be opened for live human observation, on demand; the agent's session is
  not dependent on a viewer being attached.
- The view is the real terminal, rendered as a user would expect, updating live.
- Watching is safe by default — a spectator does not accidentally drive the agent's session
  or fight it for the keyboard. Whether a human can take over input, and under what explicit
  handoff, is an open question below.

### G6 — Be a good MCP citizen

- Session lifecycle, input, updates, and history are all reachable through MCP tools and
  resources with self-describing schemas an agent can use correctly without out-of-band
  documentation.
- Errors are actionable — "no such session", "process exited with status N", "session is
  waiting for input" — not opaque failures.
- Works across the environments people actually run agents in; a session's environment,
  working directory, and shell are explicit rather than inherited by accident.
- Predictable resource behavior: sessions and their history do not grow without bound, and
  idle or abandoned sessions do not leak.

## Non-goals

- **Not a command runner.** AgentTerm is not a safer `/bin/sh` wrapper. Shell semantics,
  command construction, and what to run remain the agent's job.
- **Not a GUI automator.** Sessions are text terminals. No window automation, no pixel
  screenshotting of graphical apps, no desktop control.
- **Not an output interpreter.** The server decides *how* to present a change (text delta vs
  screen); it does not decide what the change *means*, summarize logs, or parse program
  output on the agent's behalf.
- **Not an agent framework.** No planning, no tool-use policy, no prompt engineering. It is
  a capability an agent is given.
- **Not a sandbox.** Running a terminal is inherently powerful. Isolation, allowlists, and
  permission policy are a separate concern and are deliberately left out of the initial
  goal, to be decided explicitly rather than assumed.
- **Not a remote terminal multiplexer for humans.** The human view exists for observation of
  agent-driven sessions. Being a general-purpose tmux replacement is not the point.

## Success criteria

The project is working when an agent can, without special-casing any program:

1. Start a session, run a long noiseless build, and receive only the new output — and
   afterwards page back to any earlier part of that build.
2. Start a session, launch a full-screen TUI (editor, `htop`, `fzf`, `lazygit`), and receive
   faithful screen state as the UI changes — then retrieve what the screen looked like three
   interactions ago.
3. Drive a program that alternates: shell output → interactive full-screen prompt → more
   shell output — and afterwards reconstruct that journey in order, in the right modes,
   including each screen state.
4. Notice that a program is blocking on a prompt, answer it, and continue — without polling
   on a timer or guessing how long to wait.
5. Survive a pathological program (a firehose of output, or a TUI repainting continuously)
   without drowning the agent or losing the record of what happened.
6. Let a human open any of those sessions and watch it happen live, while the agent keeps
   working.

## Open questions

Deliberately unresolved; each needs an explicit decision in design.

1. **Screen representation.** Is a drawing delivered to the agent as a text grid (faithful
   characters + attributes + cursor), as a rendered image, or both? Text grid is far cheaper
   for a language model; images are needed for anything drawing with pixels, box-drawing
   beyond the character set, or true color.
2. **Human input handoff.** Is the user's view strictly read-only, or is there an explicit
   "user takes the keyboard" handoff, and how is that signalled to the agent?
3. **Classification confidence.** What does the server do when a change is genuinely
   ambiguous — send both representations, send one and flag uncertainty, or ask the agent?
4. **History granularity and retention.** How much screen state is retained, at what
   cadence, and what is pruned first under pressure — and can history be made durable across
   server restarts?
5. **Update delivery.** Push (notifications/subscriptions), pull (cursor-based reads), or
   both — and what guarantees ordering and no-missed-updates under load.
6. **Shell/PTY substrate.** What provides the PTY and the terminal emulation, and across
   which host platforms, given the environment the server must run in.
7. **Safety posture.** Even as a non-goal for v1, what is the minimum guardrail — is there
   any default restriction on what a session may do?
