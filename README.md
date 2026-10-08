# AgentTerm

**An MCP server that lets an agent drive a terminal the way a human does.**

[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-6E4AFF.svg)](https://modelcontextprotocol.io)

AgentTerm hosts real virtual terminal sessions — a real pty with a real process tree inside
it — watches them change, and reports each change in the form that matches the kind of program
that is running:

| The program is | Its output is | The agent gets |
|---|---|---|
| **Writing** — a compiler, `ls`, `grep`, a test runner | append-only text | *the new text since last time*, in order |
| **Drawing** — `vim`, `htop`, `fzf`, a progress dashboard | a redrawn surface | *the screen*, and how it differs from a moment ago |

The agent never has to guess which world it is in.

## Why

A server that collapses both into "here are some bytes", or "here is a truncated scrollback
tail", leaves the agent to guess — and it usually guesses wrong, fighting TUIs and drowning in
logs. AgentTerm decides. It classifies every change, keeps the whole history so the agent can
go backwards, and refuses to decide when the evidence does not support it.

It also refuses to pretend: a wait tells you what it stopped on, not that the program has
finished; a pattern match is an observation, not a verdict. The server reports facts and leaves
the judgement to the caller, who is the one that knows what it is driving.

## Quick start

AgentTerm is not published to npm — clone it and run it from source.

```bash
git clone git@github.com:FishyFizz/agent-term.git
cd agent-term
npm install
```

Then connect an MCP client to it.

**Over stdio** — the server is spawned by the client:

```json
{
  "mcpServers": {
    "agent-term": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/agent-term/scripts/mcp-stdio.ts"]
    }
  }
}
```

**Over HTTP** — a long-lived local server, reconnecting on its own:

```bash
npm run mcp:http     # http://127.0.0.1:8787/mcp
npm run mcp:dev      # same, restarting on change
```

```json
{
  "mcpServers": {
    "agent-term": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

The HTTP transport binds to loopback with DNS-rebinding protection. This server runs arbitrary
commands for whoever asks; changing that default is a change to the safety posture, not a
networking tweak.

## The tools

Nine tools, one loop: open, send, wait, read, close.

| Tool | What it does |
|---|---|
| `open_session` | Starts a hosted session (a shell by default). Returns the `sessionId` every other tool addresses. |
| `send_input` | Writes text as if typed; `submit` presses Enter. |
| `send_sequence` | Composes several steps — text, a paste, a named key, a raw byte — into one write. |
| `read_screen` | The last classified update: the screen, what changed, and the session state. |
| `history_read` | One surface over the timeline — page through it or replay it, addressed by token, `seq`, timestamp or byte. |
| `wait_for_idle` | Blocks until output has been quiet. |
| `wait_for_output` | Blocks until a pattern appears — on the screen or in the text log. |
| `wait_for_group` | Blocks for the next act of output and returns the change with it — the wait a full-screen TUI needs. |
| `close_session` | Ends the session and kills its process tree. History stays readable. |

The surface is deliberately small — every tool definition is context the agent pays for on
every turn — so capabilities are added by making a call carry more, not by adding a call.

## Documentation

Everything is in [`docs/`](docs/README.md):

| Document | What it covers |
|---|---|
| [architecture.md](docs/architecture.md) | The layers, the modules, and how a byte becomes a reported change |
| [design.md](docs/design.md) | The rules the whole system is built to obey |
| [classifier.md](docs/classifier.md) | How writing vs. drawing is decided, and what it refuses to decide |
| [mcp-surface.md](docs/mcp-surface.md) | The tools an agent drives, and their contracts |
| [testing.md](docs/testing.md) | The corpus, the lifelike fixture, and what a test may assert |

## Development

```bash
npm run typecheck     # src, test, scripts, corpus and fixtures — one project
npm run test          # the whole suite
npm run smoke         # end-to-end against a real shell
npm run mcp           # the MCP server over stdio
npm run mcp:http      # the MCP server over HTTP
```

## Non-goals

- **Not a command runner.** What to run is the agent's job.
- **Not a GUI automator.** Sessions are text terminals — no window automation, no pixel
  screenshotting of graphical apps.
- **Not an output interpreter.** It decides *how* to present a change, not what the change
  *means*.
- **Not an agent framework.** No planning, no tool-use policy, no scripted recipes.
- **Not a sandbox.** Isolation and permission policy are deployment decisions.

## License

[MIT](LICENSE) © 2026 Yuwei Xu
