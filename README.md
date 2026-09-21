# AgentTerm

MCP server that lets an agent operate a terminal the way a human does.

Not usable yet. See `GOAL.md` for what this is building toward and
`PRIOR-ART.md` for the survey it came out of.

## Layout

```
GOAL.md          goals, layered L0 (core model) .. L3 (outer implementation)
PRIOR-ART.md     survey of tui-mcp, tmux-mcp, SmartCLI, terminal-bench
src/             implementation
scripts/smoke.ts end-to-end check against a real shell
```

## Development

```bash
npm install
npm run typecheck
npm run smoke
```

## License

MIT
