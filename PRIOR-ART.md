# PRIOR-ART.md — AgentTerm

Survey of existing terminal-for-agents work, recorded before design. Facts here informed the
layered goals in `GOAL.md`. Where a claim is quoted or numbered, it came from the project's
own docs/source, not from inference.

## The three reference projects

### tui-mcp — TypeScript (`node-pty` + `xterm-headless`)

Closest to the idea. MIT, created 2026-03-13, v1.2.3.

Architecture: `your app <--> node-pty <--> xterm-headless <--> MCP tools`.

Dependencies: `node-pty ^1.0.0`, `@xterm/headless ^5.5.0`, `canvas ^3.1.0`,
`@modelcontextprotocol/sdk ^1.27.1`, `zod ^3.25.0`.

Tools (16): `launch`, `kill`, `list_sessions`, `status`, `resize`, `screenshot` (PNG),
`snapshot` (plain text), `scrollback`, `output` (raw byte stream, escapes intact),
`read_region` (rectangular area), `cursor`, `send_keys`, `send_text`, `send_mouse`,
`wait_for_text`, `wait_for_idle`, `wait_for_exit`.

Also ships `npx tui-mcp monitor` — a live TUI aggregating sessions across *every* tui-mcp
server running on the machine. Keys: `j/k` + arrows navigate, `g/G` jump, `enter` on a
session **attaches** (all typing passes through to the pty, `ctrl+\` detaches), `enter` on a
server opens a launch panel, `s` fetches full scrollback into a scrollable view, `esc` returns
to live, `l` launches on the selected server (`ctrl+s` cycles target), `x` twice within 3s
kills, `q` quits. Sessions on servers older than 1.2 are marked `ro` (watchable, not
driveable).

### tmux-mcp — Go, tmux-backed

MIT, created 2026-05-24, 139 commits, ships Dockerfile + goreleaser. Exposes ~100 tools,
mostly 1:1 tmux mappings (`bind_key`, `rotate_window`, `display_popup`, …). The ones that
were *designed* rather than mechanically wrapped:

- `capture` — `visible|scrollback`, optional `ansi`, `max_lines`. Returns
  `{snapshot, token, changed, truncated}`. Scrollback defaults to a 5000-line cap; when
  truncated the **oldest** lines are dropped.
- `snapshot_diff` — take `prior_token`, return changed lines as `{line, old, new, removed}`.
  **"History keeps only the two most recent captures per session — older tokens trigger a
  full reset."**
- `wait_for_stable` — `quiet_ms` (400) / `step_ms` (100) / `timeout_ms` (10000).
- `wait_for_text` — Go RE2 regex → `{match, snapshot, token}`.
- `find_window` — fnmatch or regex over window name / pane title / visible content.
- `list_clients` — is a human attached right now, with TTY, TERM, size, read-only flag.
- `send_prefix`, `send_signal`, `display_message`, `session_inspect`.

Typed error sentinels: `-32000` session-not-found, `-32001` tmux-too-old, `-32002` timeout,
`-32003` cancelled, `-32004` name-collision, `-32005` pane-active, `-32010` oversized
response. Input bounds enforced: name 1–64 `^[A-Za-z0-9_-]+$`, width 20–1000, height 5–500,
`*_ms` 0–600000. Operates in `-read-only` mode and under `-max-response-bytes`. Dynamic tool
registration via `notifications/tools/list_changed`.

Notable decision: `session_inspect` reports pid/cwd/command but **deliberately omits
environment variables** because they routinely carry tokens and keys.

### SmartCLI — Python (`pyte` + `pywinpty`)

MIT, Python 3.10+, distribution `smartcli-toolkit`, import `smartcli_core`.

Core modules: `pty_backend / screen_model / snapshot / readiness / session`. Pluggable PTY
(ConPTY via `pywinpty` on Windows, POSIX ptys or tmux elsewhere) — explicitly not tmux-bound.
CLI verbs: `start`, `wait-regex`, `send-line`, `snapshot`, `close`.

Three skills on that core: `cmd-art` (30 fx effects, 8 themes), `drive-tui` (8 recipes that
`classify()` a screen archetype and `drive()` it — repl, menu_select, pager, search_filter,
confirm, form, progress, wizard), `tui-ui` (17 layout widgets).

**The most transferable idea in this whole survey** — since 0.3.0, every observation carries
an `io` block: `local_cut`, byte watermarks, pending facts, where **unknown values are `null`,
never `0`**. So a caller can distinguish *quiet* from *not read yet*. `STABLE` requires a
drained observation. `close` reports `closed_confirmed` vs `close_unconfirmed` with last
progress rather than assuming a returned native call means the child is gone.

Why they built that: their own `drive_vim.py` demo sent five keystrokes back to back, and
under load `vim` had not processed `G` by the time `o` arrived — nothing was inserted and the
run failed with no useful diagnosis. A driver that cannot tell "done" from "haven't looked"
silently succeeds at nothing.

### Emulator facts verified here (not from their docs)

Measured against `@xterm/headless` v6.0.0 in this repo, because two of them decide the
classifier's design:

- **The alt buffer has no scrollback.** `length` stays fixed at `rows` while the normal buffer
  grows with its scrollback setting, and content written on alt is **destroyed on exit**
  (`\x1b[?1049l` restores the normal buffer with its prior content intact).
- **Writing on the alt screen is observationally identical to writing on the normal screen** —
  `onLineFeed` fires, content scrolls, no control ops required. So alt-screen membership carries
  no information about writing vs drawing.
- **Control ops are observable in order, with cursor position at the time**, via
  `parser.registerCsiHandler` / `registerEscHandler`. Printable text does not pass through those
  handlers.
- **`terminal.write()` is asynchronous** — the buffer does not reflect a write until its callback
  runs.
- **`buffer` is proposed API** and throws unless constructed with `allowProposedApi: true`.

### terminal-bench — the crude ancestor of the writing/drawing split

`terminal_bench/terminal/tmux_session.py` implements `get_incremental_output()`: it captures
the whole pane, diffs against `_previous_buffer` via `_find_new_content()`, and returns either
`New Terminal Output:\n<new content>` or falls back to
`Current Terminal Screen:\n<visible screen>`. That is our classification, done as a
string-substring heuristic, with a silent fallback and no history. It confirms the split is
the right abstraction and that nobody has implemented it properly yet.

**Its heuristic is also the failure mode to avoid, and it fails for a structural reason.** The
test is "is the new content a substring of the current pane" — i.e. a spatial diff of
before/after. Once output scrolls, a diff of a redrawn surface against its previous state cannot
recover *what the program did*: an appended line and a repainted status row are both just changed
rows, and row position carries no identity across a scroll. See `CLASSIFIER.md` §4 for the
reproduction. Any classifier that judges a before/after screen diff inherits this; ours segments
on the program's own operations instead.

## What all three lack (our differentiation is intact)

| Gap | Evidence |
|---|---|
| No writing/drawing classification | tui-mcp offers five representations (`screenshot`, `snapshot`, `scrollback`, `output`, `read_region`) and makes the agent choose |
| No delta-by-default | `snapshot` is full-screen; nothing anywhere returns "new text since last time" |
| No history / backtracking | tmux-mcp keeps **two** captures per session, then resets |
| No interleaved timeline | none can reconstruct shell → TUI → shell in order with screen states |
| No mixed-mode transition record | the alternating-journey case is unmet everywhere |
| No push / subscription | all pull-only, agent-driven |

Secondary: tmux-mcp requires the `tmux` binary and is POSIX-only (no Windows); its ~100-tool
surface is a warning about context cost.

## What they have that we missed

1. **Settle detection** — `wait_for_idle`, `wait_for_stable`, `STABLE`-requires-drained. All
   three have it; GOAL.md did not.
2. **Quiet vs. never-read** — SmartCLI's `io` block with `null`-not-`0`.
3. **Opaque snapshot tokens** — tmux-mcp's `capture` → `token` → `snapshot_diff` is a better
   history cursor than integer indices.
4. **Bounded retrieval, not just bounded feed** — `max_lines`, `truncated`, `-max-response-bytes`.
5. **`read_region` and `cursor`** — sub-rectangle reads and cursor position as a query.
6. **`send_mouse`** — increasingly required by modern TUIs.
7. **Raw-stream escape hatch** — `output` keeps unparsed bytes available even though an
   emulator exists, so a wrong screen model isn't a dead end.
8. **Emulator conformance harness** — SmartCLI feeds identical bytes to a real tmux pane and
   to their model, diffs the cell grids, requires three-way agreement (tmux **and** GNU
   screen) before trusting a behavior, and fuzzes random VT sequences. That campaign found
   **12 emulation bugs**, including: *"pyte implements none of modes 1049/1047/47, so a
   full-screen program's output used to be painted over the main screen and never restored."*
9. **Archetype classification** (`classify()` → menu/pager/confirm/wizard) — a different axis
   from ours; they classify *what kind of UI*, we classify *what kind of change*.

Open questions answered by shipped code:

- **#2 human handoff** — tui-mcp already does attach/detach (`ctrl+\`); tmux-mcp's
  `list_clients` answers "is a human watching" before you type.
- **#7 safety floor** — tmux-mcp's `-read-only` allowlist is a working minimum posture.
- **#4 retention** — `max_lines` with oldest-dropped plus an explicit `truncated` flag.

## Library survey

### TypeScript / Node — recommended

| Layer | Library | Status |
|---|---|---|
| PTY | `microsoft/node-pty` | ~1.9k stars, 90 contributors. v1.1.0 (2025-12-22) embeds conpty v1.22; v1.2.0 betas through 2026-06. forkpty / ConPTY / winpty in one API. Powers VS Code's terminal. |
| Screen model | `@xterm/headless` | v6.0.0, 436k weekly downloads, 272 dependents. xterm.js without a DOM. |
| MCP | `@modelcontextprotocol/sdk` | Tier 1. v1.x stable (1.27.1). v2 betas split into `@modelcontextprotocol/server` + `/client`; spec finalized 2026-07-28. **Pin v1.x.** |
| Viewer | `@xterm/xterm` + `addon-webgl` | 2M weekly. Same emulator online and headless — one screen model, two consumers. |

Caveats: `@xterm/headless` is labeled **experimental** and no official addons are packaged for
Node (`@xterm/addon-serialize`, wanted for history replay, needs manual wiring). PNG rendering
needs `canvas` — a native build dependency and the single biggest install-friction risk; keep
it optional and off by default.

### Go — credible #2

- `charmbracelet/x/xpty` v0.1.4 (2026-07-30) — genuinely cross-platform PTY interface
  (`UnixPty` / `ConPty` behind one `Pty` interface).
- `charmbracelet/x/conpty` v0.2.0 (2025-11-17).
- `charmbracelet/x/vt` (2026-09-13) — virtual terminal emulator with `Scrollback`,
  `Touched()`, `IsAltScreen()`, `Render()`.
- `charmbracelet/ultraviolet` — cell-based diffing renderer, powers Bubble Tea v2.
- `modelcontextprotocol/go-sdk` — Tier 1, maintained with Google.

Catch: `charmbracelet/x` is self-described *"experimental packages with no promises of
backwards compatibility."* Less emulator maturity than xterm.js, no browser viewer story.

### Python — weakest fit, not recommended

- PTY is split: stdlib `pty` is POSIX-only; `pywinpty` (Rust/PyO3, v3.0.4, requires-python
  ≥3.10, actively maintained) for Windows. Two backends to reconcile.
- `pexpect` 4.9.0 (2023-11) / `ptyprocess` 0.7.0 (2020-12) — POSIX-only, blocking, aging.
- `pyte` — the standard emulator, has `DiffScreen` (dirty-line tracking) and `HistoryScreen`
  (scrollback + pagination). But last release Nov 2023, slow under firehose output, and
  **LGPL-3.0** — a licensing problem. Missing alt-screen modes 1049/1047/47.
- Younger options not worth the bet: `stitch-pty` (embeds pyte→Rust, inherits LGPL),
  `par-term-emu-core-rust` 0.42.0 (has Kitty graphics), `python-libghostty-vt` (requires
  Python 3.14, no Windows wheel, upstream C API "public alpha").

## Decisions taken from this survey

- Node/TypeScript; `node-pty` + `@xterm/headless`; MCP SDK pinned to v1.x.
- Text-grid is the primary screen representation; PNG is an L2 opt-in for graphics protocols.
- Adopt settle detection, the `io`-block discipline, snapshot tokens, bounded retrieval,
  `read_region` + `cursor`, mouse input, and the raw-stream escape hatch.
- Adopt SmartCLI's conformance methodology (differential diff vs. real tmux, three-way
  agreement, VT fuzzing) as the way we make "faithful capture" a testable claim.
- Reject the `drive()` recipe engine — that's agent-framework work. Keep archetype
  classification as a passive signal at most.
- Target ~20 tools, not ~100.
