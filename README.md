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

The **stream is the record**: one entry per delivery (`Delivery`), each carrying the
lines it completed, the scroll it caused, and its screen as a delta against the last
keyframe — or as a keyframe, where a delta would not have been smaller. That is what
`history.ts` stores. Measured on a scrolling log, a checkpoint plus deltas is 2% of a
grid per delivery at 120x40.

Output is grouped into **jobs** (`jobs.ts`): a job closes on a quiet period, on a cap,
or on a forced flush at a resize, an exit or a dispose. Where a delivery begins decides
what the classifier can see, so the boundary is the program's rather than the pty
buffer's. But a job is a **projection** over the stream, computed on read
(`history.jobs()`) — never stored — so it cannot disagree with the deliveries it came
from, and it can be recomputed at a different granularity later.

The verdict is read off **the screen and nothing else** — not off the escape sequences,
and not off what the program appears to have intended. There is no abstention and no
confidence value: the observations are a closed set. See `CLASSIFIER.md` §1 and §3.5.

L0.3 is built on top: one append-only timeline per session, split into **epochs** at each
resize — a resize freezes what came before it, and frozen history is reported at the size
it was produced at. A job swallowed many deliveries is not a gap: each reports what it
stands for, and `history.deliveries(from, to)` plays the states back in order. `host.ts`
is the composition root: it starts a session and its recording in one call.

It is measured against `corpus/` — 23 programmes, each recorded twice, `direct` and
through a real ConPTY. The **scored** numbers below use the `direct` traces only, because
the expectations are byte ranges from the programme's own marks and ConPTY rewrites the
bytes: 23/23 under job-aligned replay, 20/23 op-aligned, 17/23 under 64-byte chunks. Those
are measurements of a hand-written label set, not a specification — a rise is not
automatically progress (`CLASSIFIER.md` §11).

All 46 traces carry the checks that need no labels: every trace replays to the frames it
recorded, and every one reconstructs exactly through the timeline, keyframe plus deltas.
Those run on the pty half too, which is the feed where things actually go wrong.

A **first MCP surface** exists (`src/mcp.ts`, `npm run mcp:http`): open a session, send
input, read the screen, close it. It is a spike — history paging, intermediate playback,
settle detection and interaction beyond plain text are not on it yet. The most obvious
gap is that nothing can *wait*: a read taken straight after a send returns the previous
state.

Not built: delivery and boundedness (L1.1), settle detection (L1.2), interaction (L1.4)
and honest errors beyond the four coded ones (L1.5), and retention and durability (L3.4).
L1.3 is half-there — the byte watermarks exist on the session and on the pty, and nothing
consumes them yet. Grouping is on by default (`DEFAULT_JOB_POLICY`);
`SessionOptions.jobPolicy: false` opts out and gives one update per raw pty read.

## Development

```bash
npm install
npm run typecheck     # src, test, scripts and corpus — one project
npm run test          # 158 tests
npm run smoke         # end-to-end against a real shell
npm run corpus        # score the classifier across replay granularities
```

## License

MIT
