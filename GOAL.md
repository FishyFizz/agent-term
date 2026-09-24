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
usually guesses wrong — it fights TUIs and it drowns in logs. The closest prior art
(`tui-mcp`) offers five different representations and makes the agent choose between them;
`tmux-mcp` keeps two snapshots and then resets. See `PRIOR-ART.md`.

AgentTerm exists to make that distinction **first-class and automatic**, and to keep
everything it ever saw so the agent can go backwards.

## Layering

Goals are organized in concentric layers. The rule that governs them:

> **Inner layers do not depend on outer layers. Outer layers can be changed, or replaced
> entirely, without redesigning anything inside them.**

Concretely: the writing/drawing model must survive swapping node-pty for a Go PTY library,
swapping stdio for HTTP, dropping PNG rendering, or rewriting the human viewer. If a change
to an outer layer would force an inner layer to change, the boundary is drawn wrong.

| Layer | Name | Contains | Stability |
|---|---|---|---|
| **L0** | Core model | Writing vs. drawing, classification contract, history timeline, session identity | Frozen early; everything else is built on it |
| **L1** | Important capabilities | Interaction, settle detection, bounded delivery, correct observation | Shape locked once L0 is validated |
| **L2** | Nice-to-have | Precision reads, mouse, escape hatches, optional representations | Additive; can ship late or never |
| **L3** | Outer implementation | Stack, transport, viewer, retention policy, safety, packaging | Freely swappable |

---

## L0 — Core model

The invariant kernel. These are semantics, not features, and they are what makes AgentTerm
different rather than merely another terminal server.

### L0.1 — Writing and drawing are distinct, and the server decides which

The server classifies each change as **writing** (append-only text; delivered as the delta of
new text since the agent last looked) or **drawing** (a redrawn surface; delivered as a screen
capture — full when that is what is needed, delta when a delta conveys the change).

The agent does not run heuristics, inspect escape sequences, or guess which mode a program is
in. **Misclassification is a bug in the server, not a puzzle for the agent.**

A change may be **both** — a program can emit a line of text and repaint a status bar in the
same update. The model admits mixtures rather than forcing a binary choice.

The unit of classification is the **delivery** — one job of the program's output, one segment. A
segment cannot claim a finer range than the thing it was measured over, and the measurement is a
frame diff across the whole delivery. "Mixed" is therefore a fact about a *sequence* of
deliveries, not something one delivery contains. See `CLASSIFIER.md` §2.

The verdict is read off the **screen** and nowhere else. Not off the escape sequences, and not
off what the program appears to have intended: a human at the terminal sees a screen, and the
agent is meant to see the same thing. There is consequently no abstention and no confidence
value — the observations that drive the verdict are a closed set, so every change lands in one
of them. What replaces doubt is volume: every delivery reports how many raw deliveries it stands
for, so many deliveries behind little visible change is legible to the agent as exactly that,
and the intermediates remain readable. See `CLASSIFIER.md` §3.5.

Two corollaries, both load-bearing for the layers above:

- **The alt screen is not a verdict.** A program can write on it exactly as on the normal
  screen; verified indistinguishable. It is a prior and a capture-urgency flag — alt-screen
  content is destroyed on exit, so recording it while live is mandatory for L0.3.
- **Classification gates delivery, and the two kinds collapse differently.** Writing deltas
  concatenate; drawing states collapse to the latest. Hence coalescing cannot precede
  classification.

### L0.2 — The screen is a structured model, never a byte stream

A drawing is reported as a faithful cell grid — characters, attributes, cursor, alternate
screen — not as escape sequences and not as a flattened approximation. The agent sees what a
human at that terminal would see, including layout and position.

*Faithful* is a testable claim, not an assertion: the emulator is validated by differential
testing against real terminals (identical bytes in, diff the cell grids out), with
disagreement treated as a bug in our model. Prior art that skipped this shipped alt-screen
bugs that failed silently — see `PRIOR-ART.md`.

### L0.3 — History is a single interleaved timeline

One append-only timeline per session holds everything: all writing and all screen states (or
the states needed to reconstruct them), in true chronological order.

The agent can page back, seek to a point in time or a point in the sequence, and retrieve the
terminal *as it was* — text, screen, or mixture. A session that starts as a build log and
then drops into a TUI keeps both, in order, with the transition visible.

History survives the process exiting and remains queryable after the fact.

### L0.4 — Sessions are durable, independent objects

A session is a hosted terminal with a process tree inside — long-lived, addressable by a
stable handle, with its own size, working directory, and environment. Many run at once without
interference. This is the difference between "sit down at a terminal and use it" and
"`exec()`".

### L0.5 — The terminal is honest

Programs that check `isatty`, query cursor position, request terminal size, enable raw mode,
or emit color all behave correctly. Anything a human can run in a terminal runs in it: shells,
REPLs, full-screen TUIs, long-lived servers, interactive prompts, programs that read stdin and
expect a TTY. Sessions resize while running and the program inside is told.

---

## L1 — Important capabilities

What the server must do for L0 to be usable by a real agent. These shape the tool surface and
the agent's loop; getting them wrong makes L0's guarantees unusable in practice even if the
model is right.

### L1.1 — Feed continuity and boundedness

Updates are **ordered** and **continuous** — the agent does not poll blindly or invent sleeps
to "wait for output". Updates are also **bounded**: a firehose of output, or a TUI repainting
at 60fps, must not flood the agent. The server coalesces, summarizes, or holds back without
losing the ability to reconstruct what happened.

Retrieval is bounded too, not just the feed: reading history takes a window and returns that
window, with truncation reported explicitly rather than silently.

### L1.2 — Settle detection

The agent can wait for the terminal to stop changing. Critically: *quiet for N milliseconds*
is not the same as *fully drained*. Settled requires a drained observation. Without this the
agent guesses how long to wait, and guessing is how a driver silently succeeds at nothing.

### L1.3 — Quiet vs. never-read

Every observation carries enough state for the agent to distinguish "output has finished" from
"the server has not read yet": byte watermarks, pending facts. **Unknown values are `null`,
never `0`.** Conflating the two is the root cause of a whole class of interaction bugs — a
keystroke sent before the program processed the previous one, with no diagnosis afterwards.

### L1.4 — Interact like a human

Send text, line-by-line input, individual keystrokes, control and function keys, and large
pastes, with explicit control over whether a line is submitted. Send interrupts the way a
human reaches for Ctrl-C.

A program blocking on a prompt is visible **as a pending prompt** — distinct from a program
still producing output — so the agent can answer it without polling on a timer or guessing
whether output has finished.

An interaction can be composed — write, wait for a specific change, respond — without a
turn-shaped round trip per keystroke.

### L1.5 — Honest errors

"No such session", "process exited with status N", "session is waiting for input" — actionable
and typed, not opaque failures. Tool schemas are self-describing enough that an agent can use
them correctly without out-of-band documentation.

---

## L2 — Nice-to-have

Additive capabilities. They make the server more precise or more robust, but L0 and L1 stand
without them, and any one can ship late or be dropped.

- **Sub-region reads** — read a rectangular slice of the screen instead of the whole thing.
  On a large terminal this is a significant token saving.
- **Cursor query** — position, visibility, shape, exposed as a first-class question. Answers
  "where is the prompt" and "is the editor in insert mode".
- **Mouse input** — click, drag, scroll, with the common encodings. Modern TUIs increasingly
  need it.
- **Raw stream escape hatch** — expose unparsed PTY output on request. Defensive: when the
  screen model is provably wrong, the agent is not stuck.
- **Screen archetype hints** — an optional signal that a screen looks like a menu, pager,
  confirm prompt, or wizard. This is a *different axis* from writing/drawing (what kind of UI
  vs. what kind of change); it is passive information only, not a driver.
- **Alternate representations** — PNG or HTML renderings of a screen. Needed only for
  genuinely pixel-drawn content (Sixel, Kitty graphics, images). Text grid stays primary;
  these are opt-in and never the default path.

---

## L3 — Outer implementation

Everything here is a decision *about how*, not *about what*. Any item can change — including
a wholesale replacement — without touching L0, L1, or L2. Changing one of these is a normal
maintenance event, not a redesign.

### L3.1 — Stack

Node/TypeScript: `node-pty` (PTY; embeds current ConPTY binaries, one API across
forkpty/ConPTY/winpty) + `@xterm/headless` (screen model) + MCP SDK pinned to v1.x. The
headless and browser builds of xterm.js are the same emulator, so the agent's view and the
human's view share one screen model.

Revisitable: Go (`charmbracelet/x/xpty` + `x/vt`) is the credible alternative if a static
binary is ever wanted. Python is not recommended — PTY support is split across backends and
the standard emulator (`pyte`) is LGPL-3.0, slow, and lacks alt-screen modes.

### L3.2 — Transport and update delivery

Push (notifications/subscriptions), pull (cursor-based reads), or both — and what guarantees
ordering and no-missed-updates under load. History seeks address points by opaque token
rather than integer index, so retention policy can change underneath without breaking callers.

### L3.3 — Human observation

Any session can be opened for live human viewing on demand; the session does not depend on a
viewer being attached. Watching is safe by default — a spectator does not accidentally drive
the session or fight the agent for the keyboard.

Whether a human can *take* the keyboard, and how that handoff is signalled to the agent, is
decided here. Working prior art exists: attach/detach on an explicit key, plus a "is a human
watching right now" query the agent can make before typing.

### L3.4 — Retention and resource limits

How much screen state is retained, at what cadence, and what is pruned first under pressure.
Whether history is durable across server restarts. Idle and abandoned sessions must not leak.

### L3.5 — Safety posture

Running a terminal is inherently powerful. Isolation, allowlists, and permission policy are
decided here and kept out of L0–L2. The minimum viable posture is a read-only mode: a
deployment where the agent can observe and read history but cannot send input or create
sessions.

### L3.6 — Tool surface size

Target roughly twenty tools, not a hundred. Every tool definition is context the agent pays
for on every turn; a large surface is a real cost, not a feature.

---

## Non-goals

- **Not a command runner.** Shell semantics, command construction, and what to run remain the
  agent's job.
- **Not a GUI automator.** Sessions are text terminals. No window automation, no pixel
  screenshotting of graphical apps, no desktop control.
- **Not an output interpreter.** The server decides *how* to present a change (text delta vs.
  screen); it does not decide what the change *means*, summarize logs, or parse program
  output on the agent's behalf.
- **Not an agent framework.** No planning, no tool-use policy, no prompt engineering. It is a
  capability an agent is given. Explicitly excluded: scripted recipes that drive a TUI on the
  agent's behalf — that is framework work, and it belongs to whoever builds the agent.
- **Not a sandbox.** See L3.5.
- **Not a remote terminal multiplexer for humans.** The human view exists for observation of
  agent-driven sessions. Being a general-purpose tmux replacement is not the point.

## Success criteria

The project is working when an agent can, without special-casing any program:

1. Start a session, run a long noisy build, and receive only the new output — and afterwards
   page back to any earlier part of that build.
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

Each is exercised against real programs, not mocks, and lives in the regression suite.

## Open questions

All remaining open questions are L3 — implementation choices that cannot constrain L0–L2.

1. **Update delivery** — push, pull, or both (L3.2).
2. **Retention and durability** — how much, how long, persisted across restarts or not (L3.4).
3. **Human input handoff** — read-only only, or an explicit keyboard handoff, and how it is
   signalled (L3.3).
4. ~~**Ambiguity handling** — whether to send both representations, flag uncertainty, or ask,
   when classification is genuinely uncertain.~~ **Answered in `CLASSIFIER.md` §3.5**: never ask,
   never guess — and never report doubt either. The verdict is read off the screen, which is a
   closed set of observations, so nothing abstains; a suspicious delivery is instead reported as
   collapsing many raw deliveries behind little visible change, and the intermediates stay
   readable. The contract that the server must not silently guess is unchanged.
5. **Safety floor** — what ships by default (L3.5).
6. **Optional representations** — whether PNG/HTML ship at all, given the native-dependency
   cost (L2, L3.1).
