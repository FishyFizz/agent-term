# `fixtures/life` — the lifelike subject

An interactive program that behaves like a real one. Launch it and it acts like a
shell — a line in, a chunk of output — except that what it does next is chosen at
random, sometimes slowly, and sometimes it hands you a menu or a chat frame
instead of a reply.

It exists to be driven. The corpus (`corpus/programmes/`) is a set of scripted
output bursts recorded to committed traces, which is the right shape for scoring
the classifier and the wrong shape for this: nothing in it reads a line, waits, or
reacts. This subject does, so it can answer questions the corpus cannot, such as
whether a driver waits for the prompt instead of typing into a twenty-second
silence.

```
npm run life                          # random
npm run life -- --seed 42             # replay one exact run
npx tsx scripts/life.ts --pick menu   # drive it through AgentTerm and print the screen
```

## What it does

On startup it prints a banner and a prompt:

```
lifelike shell · seed 42 · 'exit' or Ctrl-D to quit
$
```

Each line you type is answered with one randomly chosen action. **The input text
is ignored** — the subject is testing whether the driver waits, not whether it can
compose a command.

| action | chance | behaviour |
|---|---|---|
| reply | 34% | one pause, then 1–3 lines, then the prompt |
| multiline | 24% | one pause, then 3–6 lines with a pause between each, then the prompt |
| silent | 10% | one pause, then just the prompt |
| menu | 16% | enter the menuconfig mode |
| chat | 16% | enter the chat frame |

`silent` is in there because it is the sharpest form of "is it ready yet?" —
nothing at all arrives.

### The readiness contract

**The prompt is printed only when the subject is idle.** While it works there is
no prompt and no progress output — just silence, occasionally for as long as
twenty seconds. That is the entire signal, and noticing it is what is being
tested.

Gaps are usually short and sometimes long:

- 85% of gaps are 300ms–5s
- 15% are 5s–20s
- at most **one** long gap per action, so a turn stays bounded at roughly 25s
  instead of running for minutes

### Input typed while the subject is busy

It is held and run after, in order. The tty echoes what you typed immediately, so
what you see is your own line appearing in the middle of someone else's reply and
nothing happening until the reply finishes — which is exactly the mistake worth
catching. Lines queued this way each get their own action, and the prompt is
printed once, when the queue has drained.

### Menu mode

Alt screen, `@clack/prompts`. A menu of four or five items drawn from a fixed pool
of names (`cute-little-sheep`, `big-red-apple`, `tiny-brass-lantern`, …) plus a
trailing `back`. Arrow keys move, Enter opens. Each item opens one of four window
kinds:

- **text** — a typed value
- **choice** — a selection from provided options
- **toggle** — a yes/no
- **info** — a read-only box

The item's current value is shown beside it the way menuconfig shows `[*]` and
`(value)`, so it is visible that opening a window did something. `back` leaves the
alt screen and returns to the shell prompt; the shell transcript is untouched.

### Chat mode

Alt screen, hand-rolled frame. Messages above, input pinned to the bottom row, and
every send answered with `Got it - [message].` after a short delay. The frame says
how to leave:

```
┌ chat · type 'quit' to exit ────────┐
│ you: hello                         │
│ bot: Got it - hello.               │
├────────────────────────────────────┤
│ > _                                │
└ type a message, ⏎ to send ─────────┘
```

`quit`, `/quit`, `/exit`, `:q` or Ctrl-C returns to the shell.

This one is not built on clack. A chat is a persistent frame redrawn in place, and
a prompt library renders a linear flow one question at a time — it cannot hold a
layout.

## Flags

| flag | meaning |
|---|---|
| `--seed <n>` | Replay one exact run: same actions, same gaps. The seed is printed in the banner. |
| `--pick <kind>` | Force **every** action to one of `reply`, `multiline`, `silent`, `menu`, `chat`. |
| `--speed <n>` | Divide every delay by `n`. `--speed 20` makes a run fast enough for a test. |
| `--help` | Usage. |

## Driving it through AgentTerm

```ts
const { session } = new SessionHost().open({
  command: process.execPath,
  args: ['--import', 'tsx', 'fixtures/life/index.ts', '--seed', '42'],
  cols: 80,
  rows: 24,
});
session.pty.write('hello\r');
await session.waitForIdle({ idleMs: 400, timeoutMs: 30_000 });
```

`scripts/life.ts` does this and prints the screen at each step:

```
npx tsx scripts/life.ts --pick menu
npx tsx scripts/life.ts --pick chat
npx tsx scripts/life.ts --seed 7 --speed 4
```

Streaming text is classified as **writing**; entering menu or chat switches to the
alt screen and is classified as **drawing**.

## Tests

`test/life.test.ts` covers the contract: one seed replays as one run, gaps stay
inside the promised range with at most one long gap per action, no prompt is shown
while the subject is working, a line typed into that silence is answered rather
than dropped, and both modes give the shell back. It does not assert timings or
screen bytes — the subject is random by design, and ConPTY rewrites escape bytes
(`corpus/OPS.md`).
