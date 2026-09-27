# Plan — from the 16-input black-box run

Nothing here is implemented. This supersedes the earlier version of this file: the
three separately-tracked asks were collapsed into one idea (§2), which is smaller
and fixes all three.

---

## 1. The npx fact (docs only) — **DONE** (`bff6150`)

**Reported:** `npx` fails to spawn ("Cannot create process, error code: 2"); an
absolute path to `npx.cmd` is needed.

**Verified on this machine:** `which npx` → `/c/Users/finnywxu/AppData/Local/hermes/node/npx`,
a **197-byte shell script**, not a Windows executable. That is why it cannot be
spawned — context.md §8 already states the general rule: *"The executable is spawned
as given: there is no PATH or PATHEXT resolution."* A real
`C:/Program Files/nodejs/npx.cmd` exists.

So the report is correct and the cause is confirmed. It is **not** an `npx`-specific
rule; it is the existing no-PATHEXT rule made concrete.

**Where:** `.claude/skills/agent-term/SKILL.md` — the driver asked for it, and it is
the file an agent reads before driving. It currently has **no** Pitfalls section at
all (sections: The loop, Keys, Waiting, Reading, Errors, What the server will not
decide for you, Habits that make a run legible). Add one. Add to context.md §14 too,
as item 14.

State the path as "wherever node is installed" — `C:/Program Files/nodejs/` is the
common location but is machine-dependent and must not be hard-coded into the repo.

---

## 2. One sequence number for everything — **DONE** (`30f527f`)

### The idea

Expose **one** sequence number. Every result sent to the agent carries it; every
historical request addresses with it. The "intermediate states" a group covered then
become nothing special — just the numbers between two deliveries.

### It already exists

`history.attach` subscribes to `onDelivery`, not `onUpdate` (`history.ts:313`), with
the comment: *"Deliveries, not updates: this timeline records the stream, and the job
the agent is shown is projected from it on read."* And `Delivery.seq` is
`++this._rawSeq` (`session.ts:537`) — incremented once per raw delivery.

So the timeline's `seq` **is already** the per-intermediate-state number:

- one record per raw delivery = one per intermediate state
- `screenAt({seq})` reconstructs any of them
- a job is a **projection on read** (`history.jobs` groups records by `job`); it
  occupies no number of its own
- `{seq}` is already one of the four `HistoryAddress` kinds (`history.ts:70`)

What is missing is only that **the MCP surface reports a different number**:
`present()` emits `update.seq` (`mcp.ts:58`), which is the *update* counter
(`_seq`, `session.ts:563`), not the raw stream counter (`_rawSeq`).

### The change

1. Add `rawSeq` to `SessionUpdate` — the `Delivery.seq` of the last raw delivery the
   update covers. In `feed()`, `seq` is already in scope per part
   (`session.ts:537`); carry the last one out.
2. `present()` reports `seq: update.rawSeq`. Renaming is not needed, but the field's
   meaning changes from "update N" to "state N" — say so in the tool description.
3. `wait_for_job` takes `sinceSeq` in that same space (see §3).
4. `history_read` needs no change — it already addresses `{seq}`.

### Consequence: the collapse of three asks

- **Ask 1 (timeout should return the screen)** — largely dissolved. Once the surface
  speaks in state numbers, a failed wait returns the number it reached, and the agent
  reads that state directly instead of re-reading "the current screen". Still worth
  attaching `screen` on non-match (see §4).
- **Ask 2 (wait for the screen to change)** — replaced by `wait_for_job` (§3).
- **Intermediate playback** — `{from:{seq:a}, to:{seq:b}, screen:true}`; already
  works, and now the numbers come from the same space the agent is already holding.

### Two corrections to earlier statements in this plan's history

- I previously claimed "two sequence spaces will be confused." At the timeline level
  that was wrong: `HistoryRecord.seq` is always the raw number. The real risk is only
  in a wait's *return value*, which would otherwise hand out `seq` (update) and
  `rawFrom/rawTo` (raw) side by side. §2 removes it by making the surface speak one
  number.
- `epoch.info.fromSeq/toSeq` are already raw numbers (`history.ts:363-365`, fed by
  `delivery.seq`). Changing `present()` does not disturb them; the misleading part is
  only that `update.seq` *sounds* like what they hold.

### One thing to watch

`session.seq` (the public getter, `session.ts:940`) returns `_seq` — the update
counter — and it advances *before* `classify()` runs
(`_seq++` at 563, construct at 574). It must not be used as a baseline. Only a seq
that came back from `read_screen` or a wait result is safe. Document this; consider
whether the getter should stay public.

---

## 3. `wait_for_job` — wait for the next job — **DONE** (`2f0b9d3`)

Implemented as described, with one deviation: a session opened without grouping
returns a job per update rather than `bad_input` — rejecting it would make the
tool unusable on a session that legitimately opted out, and there is no
boundary to group to, so "each update is one act" is the honest answer.

Also fixed while implementing: `dispose()` cleared its listener lists before
waking anyone, so a waiter was silently unsubscribed and sat out its deadline,
indistinguishable from a timeout. `onDispose` now fires first and the wait
returns `disposed`.

### Why this and not a "screen changed" wait

A change-wait fires on the first change, which inside one menu repaint is a partial
frame. Jobs exist precisely to say what one *act* of the program was. But job
boundaries are inferred from silence (`gapMs: 50`) — `jobs.ts:19` calls silence *"a
fallback, not the truth"* — so a job wait is not *more* correct than idle, it is
*better aimed*: it ends on the unit the classifier already computes.

### Shape

`wait_for_job {sessionId, sinceSeq?, timeoutMs}` →
`{reason: 'job'|'exited'|'timeout', seq, collapsed?, screen?}`

- **Hang on `onUpdate`, not on the job's emit.** The emit callback is
  `void this.feed(job.bytes, job).then(this.deliver)` (`session.ts:395`) — `feed` is
  async and queued, so at job-close time the update, `collapsed`, and `rawFrom..rawTo`
  do not exist yet. Returning there would recreate the very complaint that started
  this: you get told something happened and must call again to see it. `onUpdate`
  delivers the whole object atomically (`session.ts:453`), so one call returns job +
  screen + reason.
- **`sinceSeq` is required, not optional decoration.** `wait_for_output` needs
  `sinceByte` for exactly this reason (`session.ts:265-271`): without a baseline the
  prompt already on screen matches instantly. Identical bug here — a fast program can
  close the job before the wait begins, and the waiter would return the *previous*
  job, i.e. output from before the input was sent.
- **Return every close reason.** `JobCloseReason` is `gap | bytes | chunks | flush`.
  `bytes`/`chunks` mean the job was **cut by a cap while the program was still
  writing** — that is the "too much output, return anyway" mechanism, and the agent
  must be told the program has not stopped. `gap` is the only reason that means "the
  program went quiet on its own".

### Three bounds, because no one of them is unconditional

1. **Policy caps** (`maxBytes`/`maxChunks`) — firehose cannot hold a job open forever.
2. **The wait's own `timeoutMs`** — required because `JobPolicy` has
   `gapMs: number` **but `maxBytes?: number` and `maxChunks?: number` are optional**
   (`types.ts:19-31`). A caller-supplied policy without caps means a firehose never
   closes a job, and the wait would hang to its own deadline. So `timeoutMs` is not
   belt-and-braces; it is the only bound that always exists.
3. **`flush`** — resize/exit/dispose force the job closed.

### Known hazards to handle explicitly

- **`grid: null` does not mean "nothing changed".** `gridDelta` returns `null` across
  a resize or a buffer switch (`delta.ts:100-101`), and `resize()` flushes the job
  first (`session.ts:966`) — so the resize job is `reason:'flush'` with `grid:null`,
  the single largest change there is. Must be documented. (Also relevant to the open
  cursor question below: alt-screen entry/exit is the biggest change of all and never
  goes through `grid`.)
- **`dispose()` clears listeners before waking.** `this.listeners.length = 0`
  (`session.ts:984`) runs before `this.wake()`, so a waiter is silently unsubscribed
  and only returns at the deadline. `state()` itself is safe (it reads only the pty
  and counters), so this will not crash — but it must return an explicit reason, not
  a timeout the caller has to interpret.
- **`jobPolicy: false`** means there is no `JobDetector` at all (`session.ts:388`) and
  `collapsed` is always `null`. `wait_for_job` would hang to timeout. Return
  `bad_input` (L1.5) or document it as unsupported.
- **A firehose produces a sequence of jobs.** Cap-cut jobs arrive one after another
  while the program runs, so this is closer to an iterator than a one-shot wait;
  callers will loop with `sinceSeq`. Also: `close()` resets `chunks = 0` and `push()`
  sets `startedAt` when `chunks === 0` (`jobs.ts:257`), so each cap-cut job reports a
  short `spanMs`. `reason`, not `spanMs`, is what says whether an act completed.

---

## 4. Attach the screen to a failed wait — **DONE** (`30f527f`)

Cheap and independent of §2/§3. On `timeout`/`exited`, `wait_for_output` returns
`reason` and nothing else (`OutputWaitResult` has only `match`, populated solely on
`matched`, `session.ts:292-302`). Recommendation: attach `screen` on non-match and
make it explicitly `null` on `matched` — a field that is sometimes *absent* gets read
as "nothing", which is the `bytesPending: null vs 0` class of bug (L1.3). Do this
after §2 so the attached screen carries the unified number.

## 5. Cursor motion — **CLOSED, no change** (`35ac797`)

**Question:** does cursor motion count as a change? `gridDelta` ignores `cursorX/Y`, so a
menu moving its highlight with no glyph or colour change yields `grid: null`.

**Answer: it is already supported, and putting the cursor into the diff space would
break things.** Three findings:

1. **The cursor is already per-state history.** `HistoryRecord` carries its own `cursor`
   (`history.ts:113`), stored on every push (`:356`), and `screenInEpoch` overlays it
   back onto the reconstructed screen (`:463-468`) with the comment *"The cursor is not
   part of a delta; it belongs to the record being read."* So `screenAt({seq})` already
   returns the cursor position of that state — a menu whose highlight moved is two
   records with different cursors, and replaying them shows the move. This was
   deliberate, not an oversight.
2. **It would break the keyframe test.** `isAnchor = records.length === 0 ||
   update.grid === null` (`history.ts:346`). A cursor-only change would produce a
   non-null delta with empty `runs`/`rows`, so the record would not become a keyframe —
   storing an empty delta to reconstruct two bytes the record already holds.
3. **It would distort cost.** The `bestCost === 0` early return depends on cost counting
   the appearance payload (`delta.ts:126`). A two-byte position difference would pollute
   the shift search, and the chosen shift is a **classifier input** — this would hang an
   interaction convenience off classification quality.

The remaining risk is not in history but on the wait side: a job whose only change was
the cursor reports `grid: null`, which a caller may misread as "nothing happened".
Already documented in context.md §7 and the skill. `intermediates: true` /
`collapsed.chunks > 1` is the signal that something was swallowed.

**One doc gap this leaves:** `grid: null` currently has three distinct meanings and only
two are documented (resize, alt-screen switch). The third — no *grid* change, possibly a
cursor change — should be spelled out.

---

## Backlog (consolidated)

Everything from this plan is done, including the last two threads: `grid: null`'s three
meanings are spelled out (context.md §7), and L1.1 is split into 1.1a/b/c in `GOAL.md`
because one number covering three obligations at different stages of done is why the backlog
could never say whether it was finished.

What remains, from `context.md` §11 and `GOAL.md`:

| # | Item | Where it comes from | Size |
|---|---|---|---|
| 1 | ~~**L1.4 the pending prompt**~~ — **resolved: not implementable.** Measured, four candidates all fail to distinguish a prompt from a busy builtin. Shipped instead: `inputUnconsumed` (bytes) and `afterInput` (placement), plus consumer guidance in the skill | GOAL.md L1.4 | done |
| 2 | **Large pastes** | context.md §11, L1.4 | small |
| 3 | **Composed write-wait-respond call** — GOAL.md warns a batch that waits between steps is the scripted-recipes non-goal | context.md §11 | design |
| 4 | **L3.4 retention and durability** | context.md §11 | medium |
| 5 | **All of L2** — sub-region reads, cursor query, mouse, raw escape hatch, PNG/HTML | context.md §11 | large |
| 6 | **Open questions 1,2,3,5,6** — update delivery, retention, human input handoff, safety floor, optional representations | context.md §11 | design |
| 7 | **Delivery granularity** — the one open item that is *not* L3; per-op, per-chunk or adaptive | context.md §11 | design |
| 8 | **L1.5 honest errors** beyond the four coded ones | context.md §11 | small |

### Suggested order

Not a commitment — items 4, 5, 6 and 7 each need a design decision before code.

The pending prompt is **off the list**: research showed it is not observable, and what shipped
instead (input watermark + consumer guidance) addresses the symptom that put it here — `ls`
"looked like nothing happened" is now answered by anchoring on the program's own output rather
than by detecting readiness.

1. **B8 (L1.5 honest errors) and B3 (large pastes)** — small and independent; either first.
   Note L1.5's "session is waiting for input" error was removed from `GOAL.md` as undeliverable.
2. **B4, B6, B7** — larger; decide, then build.


