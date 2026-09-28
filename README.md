# AgentTerm

MCP server that lets an agent operate a terminal the way a human does.

It hosts real virtual terminal sessions — a real pty with a real process tree inside — watches
them change, and reports each change in the form that makes sense for the kind of program that
is running: **writing** (append-only text, delivered as the new text) or **drawing** (a redrawn
surface, delivered as screen state and how it differs). The agent does not have to guess which
world it is in.

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
npm install
npm run typecheck     # src, test, scripts, corpus and fixtures — one project
npm run test          # the whole suite
npm run smoke         # end-to-end against a real shell
npm run mcp           # the MCP server over stdio
npm run mcp:http      # the MCP server over HTTP
```

## License

MIT
