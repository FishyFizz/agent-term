# AgentTerm

MCP server that lets an agent operate a terminal the way a human does.

Not usable yet. See `GOAL.md` for what this is building toward,
`PRIOR-ART.md` for the survey it came out of, and `CLASSIFIER.md`
for the design of the writing/drawing decision.

## Layout

```
GOAL.md          goals, layered L0 (core model) .. L3 (outer implementation)
PRIOR-ART.md     survey of tui-mcp, tmux-mcp, SmartCLI, terminal-bench
CLASSIFIER.md    how a change is classified as writing or drawing,
                 and what a test may assert (§11)
HISTORY.md       the timeline: resize epochs, deltas, and what was verified
src/jobs.ts      job boundaries — where one delivery ends and the next begins
src/             implementation
corpus/          test programmes and recorded traces — the classifier's
                 regression suite; see corpus/README.md
scripts/mcp-stdio.ts the MCP server over stdio — `npm run mcp`
scripts/smoke.ts end-to-end check against a real shell
scripts/corpus-score.ts
                 score the classifier across replay granularities
```

## Status

**L0, the core model, is complete.** L0.1–L0.5 are built: a real pty (`pty.ts`) feeding a
faithful screen model (`screen.ts`) — characters, attributes, cursor and alternate
screen, with the grid indexed by column — whose control ops are recorded as an edit
record (`edit-record.ts`) and whose completed lines are kept in a text log
(`text-log.ts`), classified per delivery as writing or drawing (`classify.ts`), exposed
as a session (`session.ts`) held in a registry (`registry.ts`).

Output is grouped into **jobs** before it is classified (`jobs.ts`): a job closes on a
quiet period, on a cap, or on a forced flush at a resize, an exit or a dispose. Where a
delivery begins decides what the classifier can see, so the boundary is the program's
rather than the pty buffer's. Each delivery reports how many raw deliveries it stands
for, so a burst that collapsed to little visible change says so — and the
intermediates are not just counted but kept: `session.intermediates(rawFrom, rawTo)`
plays back the states a job swallowed, in order. They are stored as a checkpoint plus
deltas, not a grid each — measured on a scrolling log, 2% of the size at 120x40.

The verdict is read off **the screen and nothing else** — not off the escape sequences,
and not off what the program appears to have intended. There is no abstention and no
confidence value: the observations are a closed set. See `CLASSIFIER.md` §1 and §3.5.

L0.3 is built on top: one append-only timeline per session (`history.ts`), split
into **epochs** at each resize — a resize freezes what came before it, and frozen
history is reported at the size it was produced at. Screens are stored as a delta
against the previous one or, where a delta would not be smaller, as a keyframe
(`delta.ts`), so a repainting TUI does not retain a full grid per frame. `host.ts`
is the composition root: it starts a session and its recording in one call.

It is measured against `corpus/` — 23 programmes, 46 recorded traces — at 23/23 under
job-aligned replay, 20/23 op-aligned and 17/23 under 64-byte chunks. Those numbers are
measurements of a hand-written label set, not a specification: a rise is not
automatically progress. The corpus's job is exactness — every delivery of every trace
reconstructs its screen exactly — and the rule is written down in `CLASSIFIER.md` §11.

Not built: the MCP tool surface, delivery and boundedness (L1.1), settle
detection (L1.2), interaction (L1.4) and honest errors (L1.5), and retention
and durability (L3.4). L1.3 is half-there — the byte watermarks exist on the
session and on the pty, and nothing consumes them yet. Grouping output into jobs
on by default (`DEFAULT_JOB_POLICY`); `SessionOptions.jobPolicy: false` opts out and
gives one update per raw pty read.

## Development

```bash
npm install
npm run typecheck     # src, test, scripts and corpus — one project
npm run test          # 151 tests
npm run smoke         # end-to-end against a real shell
npm run corpus        # score the classifier across replay granularities
```

## License

MIT
