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
corpus/          test programmes and recorded traces — the classifier's
                 regression suite; see corpus/README.md
scripts/smoke.ts end-to-end check against a real shell
scripts/corpus-score.ts
                 score the classifier across replay granularities
```

## Status

L0.1–L0.5 are built: a real pty (`pty.ts`) feeding a screen model
(`screen.ts`) whose control ops are recorded as an edit record
(`edit-record.ts`), classified per segment as writing or drawing
(`classify.ts`), exposed as a session (`session.ts`) held in a registry
(`registry.ts`).

It is measured against `corpus/` — 22 programmes, 44 recorded traces — at
20/22 under op-aligned replay and 14/22 under pty-sized chunks. The gap is a
real finding, not noise: byte offsets are only as precise as the delivery
carrying them, so coalescing is a classification input and not merely a
delivery policy. See `CLASSIFIER.md` §9.

Not built: the MCP tool surface, delivery and boundedness (L1.1), settle
detection (L1.2), and history (L0.3).

## Development

```bash
npm install
npm run typecheck     # src, test, scripts and corpus — one project
npm run test          # 72 tests
npm run smoke         # end-to-end against a real shell
npm run corpus        # score the classifier across replay granularities
```

## License

MIT
