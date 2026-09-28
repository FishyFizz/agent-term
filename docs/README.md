# AgentTerm — documentation

AgentTerm is an MCP server that hosts real terminal sessions and reports what they do.
The whole project exists for **one distinction**, made automatically and without the caller
asking:

- **Writing** — append-only text. A compiler, `ls`, `grep`, a test runner. The agent wants
  *the new text since last time*, in order.
- **Drawing** — a redrawn surface. `vim`, `htop`, `fzf`, a progress dashboard, a REPL doing
  inline redraw. Output is a *state*; the agent wants the screen and how it differs from a
  moment ago.

A server that collapses both into "here are some bytes", or "here is a truncated scrollback
tail", leaves the agent to guess which world it is in. It usually guesses wrong — fighting
TUIs and drowning in logs. AgentTerm decides, and keeps everything it saw so the agent can go
backwards.

## The documents

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | The layers, the modules, and how a byte becomes a reported change |
| [design.md](design.md) | The rules the whole system is built to obey |
| [classifier.md](classifier.md) | How writing vs. drawing is decided, and what it refuses to decide |
| [mcp-surface.md](mcp-surface.md) | The tools an agent drives, and their contracts |
| [testing.md](testing.md) | The corpus, the lifelike fixture, and what a test may assert |

## Non-goals

- **Not a command runner.** Shell semantics, command construction, and what to run remain the
  agent's job.
- **Not a GUI automator.** Sessions are text terminals. No window automation, no pixel
  screenshotting of graphical apps.
- **Not an output interpreter.** The server decides *how* to present a change (text delta vs.
  screen); it does not decide what the change *means*. No summarising logs, no parsing program
  output on the agent's behalf.
- **Not an agent framework.** No planning, no tool-use policy, no prompt engineering. In
  particular: no scripted recipes that drive a TUI on the agent's behalf. That is framework
  work, and it is why a batch of input steps does not wait between them.
- **Not a sandbox.** Isolation and permission policy are deployment decisions, kept out of the
  core model.

## Running it

```bash
npm install
npm run typecheck     # src, test, scripts, corpus and fixtures — one project
npm run test          # the whole suite
npm run smoke         # end-to-end against a real shell
npm run mcp:http      # the MCP server over HTTP
npm run mcp           # the MCP server over stdio
```

See [testing.md](testing.md) for the corpus commands and the recording workflow.
