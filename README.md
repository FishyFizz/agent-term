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
HISTORY.md       the timeline: resize epochs, deltas, and what was verified
src/             implementation
corpus/          test programmes and recorded traces — the classifier's
                 regression suite; see corpus/README.md
scripts/smoke.ts end-to-end check against a real shell
scripts/corpus-score.ts
                 score the classifier across replay granularities
```

## Status

**L0, the core model, is complete.** L0.1–L0.5 are built: a real pty (`pty.ts`) feeding a
faithful screen model (`screen.ts`) — characters, attributes, cursor and alternate
screen, with the grid indexed by column — whose control ops are recorded as an edit
record (`edit-record.ts`) and whose completed lines are kept in a text log
(`text-log.ts`), classified per segment as writing or drawing (`classify.ts`), exposed
as a session (`session.ts`) held in a registry (`registry.ts`).

L0.3 is built on top: one append-only timeline per session (`history.ts`), split
into **epochs** at each resize — a resize freezes what came before it, and frozen
history is reported at the size it was produced at. Screens are stored as a delta
against the previous one or, where a delta would not be smaller, as a keyframe
(`delta.ts`), so a repainting TUI does not retain a full grid per frame. `host.ts`
is the composition root: it starts a session and its recording in one call.

It is measured against `corpus/` — 23 programmes, 46 recorded traces — at
21/23 under op-aligned replay and 15/23 under pty-sized chunks. The gap is a
real finding, not noise: byte offsets are only as precise as the delivery
carrying them, so coalescing is a classification input and not merely a
delivery policy. See `CLASSIFIER.md` §9.

Not built: the MCP tool surface, delivery and boundedness (L1.1), settle
detection (L1.2), interaction (L1.4) and honest errors (L1.5), and retention
and durability (L3.4). L1.3 is half-there — the byte watermarks exist on the
session and on the pty, and nothing consumes them yet.

## Development

```bash
npm install
npm run typecheck     # src, test, scripts and corpus — one project
npm run test          # 131 tests
npm run smoke         # end-to-end against a real shell
npm run corpus        # score the classifier across replay granularities
```

## License

MIT
