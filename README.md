# AgentTerm

MCP server that lets an agent operate a terminal the way a human does.

Not usable yet. See `GOAL.md` for what this is building toward,
`PRIOR-ART.md` for the survey it came out of, and `CLASSIFIER.md`
for the design of the writing/drawing decision.

## Layout

```
GOAL.md          goals, layered L0 (core model) .. L3 (outer implementation)
PRIOR-ART.md     survey of tui-mcp, tmux-mcp, SmartCLI, terminal-bench
CLASSIFIER.md    how a change is classified as writing or drawing
src/             implementation
scripts/smoke.ts end-to-end check against a real shell
```

## Status

`src/env.ts`, `src/pty.ts`, `src/registry.ts` implement L0.4/L0.5 and pass
`npm run smoke` against a real shell. `src/xterm.ts` is a loading shim only —
nothing feeds the emulator yet, so the screen model and classifier (L0.1/L0.2)
are unbuilt. Next steps are in `CLASSIFIER.md` §9.

## Development

```bash
npm install
npm run typecheck
npm run smoke
```

## License

MIT
