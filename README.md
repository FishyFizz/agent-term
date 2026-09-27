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
src/groups.ts      group boundaries — where one delivery ends and the next begins
src/keys.ts      named keys, and the batch a caller composes out of them
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

Output is grouped into **groups** (`groups.ts`): a group closes on a quiet period, on a cap,
or on a forced flush at a resize, an exit or a dispose. Where a delivery begins decides
what the classifier can see, so the boundary is the program's rather than the pty
buffer's. But a group is a **projection** over the stream, computed on read
(`history.groups()`) — never stored — so it cannot disagree with the deliveries it came
from, and it can be recomputed at a different granularity later.

Waiting is not guessing whether output has finished (`session.ts`). `waitForIdle` resolves on
observation — a byte arriving, a feed finishing, an exit — never on a step the caller
invented, and it reports which of `idle`, `exited` or `timeout` ended it. Idle is measured
from the last *byte*, not the last delivery: a program that never pauses never opens a gap,
so no delivery completes for seconds at a time, and idle measured from a delivery would call
a firehose idle while it floods output. There is no *settled* — see `GOAL.md` L1.2.

The verdict is read off **the screen and nothing else** — not off the escape sequences,
and not off what the program appears to have intended. There is no abstention and no
confidence value: the observations are a closed set. See `CLASSIFIER.md` §1 and §3.5.

L0.3 is built on top: one append-only timeline per session, split into **epochs** at each
resize — a resize freezes what came before it, and frozen history is reported at the size
it was produced at. A group covering many deliveries is not a gap: each reports what it
stands for, and `history.deliveries(from, to)` plays the states back in order. `host.ts`
is the composition root: it starts a session and its recording in one call.

It is measured against `corpus/` — 23 programmes, each recorded twice, `direct` and
through a real ConPTY. The **scored** numbers below use the `direct` traces only, because
the expectations are byte ranges from the programme's own marks and ConPTY rewrites the
bytes: 23/23 under group-aligned replay, 20/23 op-aligned, 17/23 under 64-byte chunks. Those
are measurements of a hand-written label set, not a specification — a rise is not
automatically progress (`CLASSIFIER.md` §11).

All 46 traces carry the checks that need no labels: every trace replays to the frames it
recorded, and every one reconstructs exactly through the timeline, keyframe plus deltas.
Those run on the pty half too, which is the feed where things actually go wrong.

A **first MCP surface** exists (`src/mcp.ts`, `npm run mcp:http`): open a session, send
input, send a batch of input as one write, wait for it to stop changing, wait for a pattern
to appear, read the screen, address the timeline, close it. It is a spike — the pending
prompt and large pastes are not on it yet.

`history_read` is one tool over the timeline, not a pair. Paging through what happened and
replaying the frames a group swallowed are the same operation at different settings: `from` and
`to` take any address — a token, a seq, a timestamp, a byte offset, and the two ends need not
match — `level` picks the projection (deliveries, groups, text), and `screen: true` materializes
the state at each point, which is what turns a page into a playback. A span (`to`) crosses a
resize; a page (`from` alone) never does, and reports the grid size it was produced at. This
is what makes `collapsed.intermediates` from `read_screen` reachable — read the group's span with
`screen: true` and the states it merged come back.

Input can be **named** rather than spelled (`send_sequence`, `src/keys.ts`). `{key: "down"}`
sends the bytes an arrow sends; the caller never puts a raw escape sequence on the wire, which
is what a transport between an agent and this server silently drops — one driving run sent
`\x1b[B`, the ESC did not survive, and the program received the inert text `[B`. A key is
encoded from the mode the program has set, read off the screen, so `down` is `CSI B` in a shell
and `SS3 B` in a program that has turned on application cursor keys. Several steps — text, keys,
or a raw byte — compose into one write, and the result reports the bytes actually written so
the round trip can be checked without reading the screen.

It can **wait** (`wait_for_idle`), which is what makes a read taken after a send mean
anything. The wait is bounded and reports which of `idle`, `exited` or `timeout` ended it.
It does not report *settled*: whether a live program will produce more output is not provable
at a byte interface, and a value claiming otherwise would be a judgement dressed as an
observation. What a read carries instead is `state` — running, how long it has been idle,
and whether what it produced has been read through (`GOAL.md` L1.2).

It can also **wait for a pattern** (`wait_for_output`): resolve when a regular expression
appears, or on `exited` / `timeout`. Unlike idle, a match is a positive observation and needs
no quiet period, so there is no interval to guess — which is what collapses wait-then-read-
then-eyeball into one call. A pattern is matched against screen rows the session *wrote*
since a byte watermark (a row that merely scrolled is not a row that appeared, told apart by
the delta's runs rather than by comparing text) and against completed lines it emitted. The
watermark defaults to the last input, so a prompt already on screen cannot match the instant
a wait starts. A match is still an observation, not a verdict: the terminal echoes what is
typed, and an echo is new output too (`GOAL.md` L1.4).

Not built: delivery and boundedness (L1.1), the pending prompt, large pastes and a composed
write-wait-respond call (L1.4), honest errors beyond the four coded ones (L1.5), and
retention and durability (L3.4). Grouping is on by default
(`DEFAULT_GROUP_POLICY`); `SessionOptions.groupPolicy: false` opts out, and gives one update
per raw pty read.

## Development

```bash
npm install
npm run typecheck     # src, test, scripts and corpus — one project
npm run test          # 232 tests
npm run smoke         # end-to-end against a real shell
npm run corpus        # score the classifier across replay granularities
```

## License

MIT
