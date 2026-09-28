/**
 * The MCP surface — a spike of the core loop, not the whole thing.
 *
 * Nine tools, because that is the smallest set an agent can drive a terminal
 * with: open one, type into it, send a batch of input as one write, wait for it
 * to stop changing, wait for it to show something, wait for its next group,
 * read what happened, address the timeline it happened on, close it. The rest of interaction (the pending
 * prompt, large pastes) goes on top of these rather than beside them, and is
 * deliberately not here yet.
 *
 * The shape of a result matters more than the number of tools. A read returns
 * what a human at the screen would say: the screen, what changed on it, and
 * how much output the change stands for. It does not return escape sequences
 * and it does not ask the agent to guess a mode (L0.1). Where a value is not
 * knowable it is `null`, never 0 (L1.3).
 *
 * A write reports `written`: the bytes as they were handed to the terminal, in
 * a form that can be compared with what was meant. A transport between an agent
 * and this server can silently drop a control character, and one driving run
 * spent three inputs discovering that its `ESC` had become inert text
 * (`feedbacks/1.txt`). Naming a key removes the byte from the wire; reporting
 * the bytes makes the round trip visible when it does not.
 *
 * A read also reports the session's state as facts — whether it is running,
 * how long it has been idle, whether what it produced has been read through.
 * It does not report "settled". Whether a live program will produce more
 * output is not provable at a byte interface, and a value claiming otherwise
 * would be a judgement dressed as an observation (GOAL.md L1.2). The waits are
 * the same: each says which of its own reasons stopped it — `idle`, `exited` or
 * `timeout`; `matched`, `exited` or `timeout` — and leaves what that means to
 * the caller, who knows what it is driving.
 *
 * Errors are typed and actionable rather than opaque (L1.5): a caller gets a
 * code it can branch on, not a stack trace.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionHost } from './host.js';
import { composeSteps, escapeBytes, KeyInputError, KEY_SUMMARY, type Composed } from './keys.js';
import type { Segment } from './classify.js';
import type { HistoryPoint, HistoryReadOptions } from './history.js';
import type { SessionUpdate } from './session.js';
import type { TextLine } from './text-log.js';
import type { SessionId } from './types.js';

/** What went wrong, in a form a caller can branch on. */
export type ErrorCode = 'no_session' | 'not_live' | 'bad_input' | 'bad_pattern';

function fail(code: ErrorCode, message: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { error: { code, message } },
  };
}

/**
 * The segments as the agent reads them: the verdict, the byte span, and the
 * evidence it was reached on, flattened into one object.
 *
 * Flattened rather than nested because the evidence is the part a caller
 * branches on, and a caller that has to reach through `evidence.` to find it is
 * one that will not. `null` in, `null` out: a result that has no change to
 * report says so rather than reporting an empty one, which is the difference
 * between "no group arrived" and "a group arrived that changed nothing".
 */
function presentSegments(segments: readonly Segment[] | null) {
  return segments === null
    ? null
    : segments.map((s) => ({
        kind: s.kind,
        fromByte: s.fromByte,
        toByte: s.toByte,
        erased: s.evidence.erased,
        overwrote: s.evidence.overwrote,
        reachedBack: s.evidence.reachedBack,
        scrolledBy: s.evidence.scrolledBy,
        altScreen: s.evidence.altScreen,
      }));
}

/** The lines a change completed, as the agent reads them. `null` in, `null` out. */
function presentText(text: readonly TextLine[] | null) {
  return text === null ? null : text.map((l) => l.text);
}

/**
 * One screen, as the agent reads it: trailing blanks trimmed off every row.
 *
 * The grid is `cols` wide and every row is padded to it, so what a caller is
 * handed is `rows` x `cols` characters whether or not the program wrote them.
 * On the 140x40 grid used in `feedbacks/edca2559` that was 5,600 characters a
 * read and 12,870 tokens across nine screens, of which 11% carried anything.
 * Blank cells hold no fact the rest of the report does not: a row that was
 * erased or overwritten is in `segments`, a line that was completed is in
 * `text`, and neither needs the padding to be read.
 *
 * Trimmed from the end only, so every glyph keeps its column, and every row
 * stays in the array at its own index -- a row the program blanked is `''`,
 * not a shift. It is the stripping `wait_for_output` already does before
 * matching a pattern (`match.ts`), applied to what the caller is shown.
 */
function presentScreen(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/ +$/, ''));
}

/** One update, in the form the agent reads: what the screen is and what changed. */
function present(update: SessionUpdate) {
  return {
    seq: update.seq,
    screen: presentScreen(update.screen.lines),
    segments: presentSegments(update.segments),
    text: presentText(update.text),
    collapsed: update.collapsed,
    io: update.io,
  };
}

/**
 * Build the server over a host.
 *
 * The host is injected rather than constructed here so a test can drive the
 * same surface without a stdio transport, and so the surface has no state of
 * its own beyond what the host already owns.
 */
export function createServer(host: SessionHost = new SessionHost()): McpServer {
  const server = new McpServer({ name: 'agent-term', version: '0.0.0' });

  const session = (id: string) => host.session(id);

  server.registerTool(
    'open_session',
    {
      title: 'Open a terminal session',
      description:
        'Start a hosted terminal session running a command. Returns its id, which every ' +
        'other tool needs. Defaults to a platform shell.',
      inputSchema: {
        command: z.string().optional().describe('Executable to run. Defaults to a shell.'),
        args: z.array(z.string()).optional().describe('Arguments to the executable.'),
        cwd: z.string().optional().describe('Working directory.'),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
      },
    },
    async ({ command, args, cwd, cols, rows }) => {
      const { session: opened } = host.open({ command, args, cwd, cols, rows });
      return {
        content: [{ type: 'text', text: opened.id }],
        structuredContent: { sessionId: opened.id, cols: opened.screen.cols, rows: opened.screen.rows, pid: opened.pty.pid },
      };
    },
  );

  server.registerTool(
    'send_input',
    {
      title: 'Send input to a session',
      description:
        'Write text into a session, as if typed. `submit` appends a newline, so a command ' +
        'that needs Enter pressed should set it. To press a key rather than type characters — ' +
        'arrows, Tab, Escape, Ctrl-C — use `send_sequence`. The result reports `written`, the ' +
        'bytes as they were actually handed to the terminal.',
      inputSchema: {
        sessionId: z.string(),
        text: z.string().describe('What to type.'),
        submit: z.boolean().optional().describe('Append a newline, submitting the line.'),
      },
    },
    async ({ sessionId, text, submit }) => {
      const target = session(sessionId);
      if (!target) return fail('no_session', `no session ${sessionId}`);
      if (!target.pty.alive) return fail('not_live', `session ${sessionId} has exited`);
      const bytes = submit ? `${text}\r\n` : text;
      target.send(bytes);
      return {
        content: [{ type: 'text', text: 'sent' }],
        structuredContent: {
          sessionId,
          bytesWritten: Buffer.byteLength(bytes, 'utf8'),
          written: escapeBytes(bytes),
          submitted: submit ?? false,
        },
      };
    },
  );

  server.registerTool(
    'send_sequence',
    {
      title: 'Send a batch of input as one write',
      description:
        'Write several inputs at one instant: each step is `{text}`, `{key}` or `{byte}`, and ' +
        'the whole batch goes in a single write, in order. This is how a keystroke a program ' +
        'needs but has no character for gets sent -- "type this, then press Enter" is one call ' +
        'rather than two, and no raw escape bytes cross the wire.\n\n' +
        'Keys are named, not spelled: ' +
        KEY_SUMMARY +
        '. A key is encoded using the mode the program has set, read from the screen -- ' +
        '`down` is `CSI B`, or `SS3 B` when the program has turned on application cursor ' +
        'keys -- so the same call is right in a shell and in a full-screen editor.\n\n' +
        '**A key that only counts twice in quick succession belongs in one batch.** Two ' +
        '`{key: "ctrl+c"}` steps in one call arrive as one write, which is what a program ' +
        'waiting for a double press is measuring. The same two keys sent as two calls are a ' +
        'model round trip apart, so the program sees two single presses and the gesture does ' +
        'nothing -- which reads exactly like a key that was ignored.\n\n' +
        'Nothing waits inside a batch. It is a sequence of writes at one instant, not a ' +
        'script with reactions; send, then wait, then read, and keep that loop in your own ' +
        'control. The result reports `written`, the bytes as they were actually handed to the ' +
        'terminal, so what the program received can be checked without reading the screen.',
      inputSchema: {
        sessionId: z.string(),
        steps: z
          .array(
            z.looseObject({
              text: z.string().optional().describe('Literal text to type.'),
              key: z
                .string()
                .optional()
                .describe(`A key by name. Known keys: ${KEY_SUMMARY}`),
              byte: z
                .union([z.number(), z.string()])
                .optional()
                .describe(
                  'A raw byte, 0x01-0x7f, as a number or as hex ("1b" or "0x1b"). The ' +
                    'escape hatch for a byte no key names.',
                ),
            }),
          )
          .describe('The steps, in order. Each step is exactly one of text, key or byte.'),
      },
    },
    async ({ sessionId, steps }) => {
      const target = session(sessionId);
      if (!target) return fail('no_session', `no session ${sessionId}`);
      if (!target.pty.alive) return fail('not_live', `session ${sessionId} has exited`);

      // The mode is read once, before composing: a step's bytes go *to* the
      // program, and the mode only ever changes from the program's output,
      // which this does not parse before returning.
      let composed: Composed;
      try {
        composed = composeSteps(steps, target.screen.modes);
      } catch (cause) {
        if (cause instanceof KeyInputError) return fail('bad_input', cause.message);
        throw cause;
      }

      target.send(composed.bytes);
      return {
        content: [{ type: 'text', text: `sent ${composed.steps.length} steps` }],
        structuredContent: {
          sessionId,
          bytesWritten: Buffer.byteLength(composed.bytes, 'utf8'),
          written: escapeBytes(composed.bytes),
          steps: composed.steps.map((step) => ({
            kind: step.kind,
            ...(step.key === undefined ? {} : { key: step.key }),
            ...(step.byte === undefined ? {} : { byte: step.byte }),
            written: step.written,
          })),
          // `null` when no step consulted it -- a text-only batch made no
          // decision that depended on the mode, and `false` would answer a
          // question that was never asked (L1.3).
          modes:
            composed.applicationCursorKeys === null
              ? null
              : { applicationCursorKeys: composed.applicationCursorKeys },
        },
      };
    },
  );

  server.registerTool(
    'read_screen',
    {
      title: 'Read what a session shows now',
      description:
        'The screen as it is now, what changed on it, and how much output that change ' +
        'stands for. Returns the last classified update, or null when nothing has arrived ' +
        'yet — which is not the same as an empty screen. **A `wait_for_group` already returned ' +
        'this same report for the state it ended at**, so a read taken straight after one is ' +
        'the same answer again unless output arrived since. Also reports `state`: whether ' +
        'the session is running, how long it has been idle, and whether what it produced ' +
        'has been read through. **`state.inputUnconsumed` is how many bytes you sent that ' +
        'no output has followed** — `null` before any input, `0` once something came back. ' +
        'It is a byte count, not a verdict: a shell running a slow builtin and a shell ' +
        'sitting at a prompt are indistinguishable from outside, so there is deliberately ' +
        'no `atPrompt`. **`seq` is the number of the state being shown** — one ' +
        'number for the whole timeline, incremented per raw delivery, and the same one ' +
        '`history_read` addresses with. A group that swallowed states 3..9 reports 9, and ' +
        '`history_read({from:{seq:3}, to:{seq:9}, screen:true})` plays 3..9 back.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const target = session(sessionId);
      if (!target) return fail('no_session', `no session ${sessionId}`);
      const last = host.lastUpdate(sessionId);
      // The state rides along on every read, so a caller can tell "nothing
      // arrived" from "has not been read yet" without a second call.
      const state = target.state();
      if (!last) {
        return {
          content: [{ type: 'text', text: '(no output yet)' }],
          structuredContent: {
            sessionId,
            screen: presentScreen(target.screen.snapshot().lines),
            update: null,
            bytesRead: target.pty.bytesRead,
            state,
          },
        };
      }
      return {
        content: [{ type: 'text', text: presentScreen(last.screen.lines).join('\n') }],
        structuredContent: { sessionId, ...present(last), state },
      };
    },
  );

  server.registerTool(
    'wait_for_idle',
    {
      title: 'Wait for a session to stop changing',
      description:
        'Block until the session has been quiet for `idleMs` and everything it produced ' +
        'has been read through, or until `timeoutMs` passes. Returns which of those ' +
        'stopped it: `idle`, `exited`, or `timeout`. `idle` does NOT mean the program has ' +
        'finished — nothing observable can establish that while it runs; it means the ' +
        'quiet period you asked for was observed. Use this instead of sleeping after a ' +
        'send: a read taken straight after a send returns the previous state.',
      inputSchema: {
        sessionId: z.string(),
        idleMs: z.number().int().nonnegative().describe('How long the pty must have been quiet.'),
        timeoutMs: z.number().int().positive().describe('Give up after this long.'),
      },
    },
    async ({ sessionId, idleMs, timeoutMs }) => {
      const target = session(sessionId);
      if (!target) return fail('no_session', `no session ${sessionId}`);
      const result = await target.waitForIdle({ idleMs, timeoutMs });
      return {
        content: [{ type: 'text', text: result.reason }],
        structuredContent: { sessionId, ...result },
      };
    },
  );

  server.registerTool(
    'wait_for_output',
    {
      title: 'Wait for a session to show something',
      description:
        'Block until a regular expression appears in what the session produced, or until ' +
        '`timeoutMs` passes or the process exits. Returns which of those stopped it: ' +
        '`matched`, `exited` or `timeout`, and what matched (the text, the screen row, the ' +
        'byte it arrived at). When it does NOT match, `screen` carries the rows as they ' +
        'were when the wait ended, so a timeout answers "what is it showing?" without a ' +
        'second call; it is `null` on `matched`, where the match is the answer. A pattern ' +
        'is matched against screen rows the session wrote, ' +
        'and against completed lines it emitted. Trailing blanks are removed before ' +
        'matching, so a prompt printed as "$ " is a row whose content is "$" — anchor with ' +
        '`^...$` to mean a whole line. Only output produced after ' +
        'the byte the session was last typed into counts by default, so a prompt already on ' +
        'screen does not match instantly; pass `sinceByte` to match from another watermark. ' +
        'A match is an observation, not evidence the program has finished — the terminal ' +
        'echoes what is typed, and an echo is new output too. Use this instead of waiting ' +
        'for idle and then guessing from the screen that the program is ready.',
      inputSchema: {
        sessionId: z.string(),
        pattern: z
          .string()
          .describe('A regular expression, matched against a screen row or a completed line.'),
        surface: z
          .enum(['screen', 'text', 'both'])
          .optional()
          .describe('What to match: screen rows, completed lines, or both. Default both.'),
        sinceByte: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Match only output produced after this byte watermark. Default: the last input.'),
        timeoutMs: z.number().int().positive().describe('Give up after this long.'),
      },
    },
    async ({ sessionId, pattern, surface, sinceByte, timeoutMs }) => {
      const target = session(sessionId);
      if (!target) return fail('no_session', `no session ${sessionId}`);

      let compiled: RegExp;
      try {
        compiled = new RegExp(pattern);
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        return fail('bad_pattern', `not a usable regular expression: ${pattern} (${why})`);
      }

      const result = await target.waitForOutput({
        pattern: compiled,
        surface,
        sinceByte,
        timeoutMs,
      });
      const said = result.match
        ? `matched ${result.match.surface} at byte ${result.match.atByte}: ${JSON.stringify(result.match.text)}`
        : result.reason;
      // Rows, not the snapshot: a wait that ended without a match is answered
      // with what was on screen so the caller can decide without reading again.
      // The snapshot carries styles and widths a branch on `reason` never uses.
      const { screen, ...rest } = result;
      return {
        content: [{ type: 'text', text: said }],
        structuredContent: {
          sessionId,
          ...rest,
          screen: screen ? presentScreen(screen.lines) : null,
        },
      };
    },
  );

  server.registerTool(
    'wait_for_group',
    {
      title: 'Wait for the next group',
      description:
        'Block until the next **group** is delivered, or until `timeoutMs` passes. A group ' +
        'is a run of output delivered together; its boundary is drawn by `gapMs` of silence ' +
        'or by a cap. ' +
        'The third wait, and the one a full-screen TUI needs: `wait_for_idle` is negative ' +
        '(nothing arrived for a while) so it returns whether or not anything happened, and ' +
        '`wait_for_output` needs a pattern to anchor on, which a repainting menu does not ' +
        'have. A group is positive and content-agnostic. ' +
        '**What this reports is measured, not interpreted.** The boundary is *inferred from ' +
        'silence, not declared by the program* — nothing here can tell you the program ' +
        'finished an act, is still working, or will produce more. Whether this group is the ' +
        'unit you care about is your call. ' +
        'Returns `reason`: `group`, `exited`, `disposed`, or `timeout`. **On a group the wait ' +
        'carries the change itself** — `seq`, `group`, `collapsed`, `screen`, and the ' +
        '`segments`, `text` and `io` a read would report for the same state — so a wait is ' +
        'not a prelude to a read. `segments` is the part the screen cannot show you: a group ' +
        'with `text: []` beside a non-empty `segments` repainted without writing a line, ' +
        'which is a cursor moving or a highlight following it, not output that stopped. ' +
        '**`afterInput` says whether the group you got contains ' +
        'bytes produced after your last write** — `null` before any input. `false` means the ' +
        'wait ended on output that was already in flight, so sending more now would be ' +
        'typing into something that has not read the last thing yet. It is placement, not ' +
        'causation: output after input may still be unrelated to it. ' +
        '**`collapsed.reason` is how the group ended, measured by the detector** — `gap`: no ' +
        'bytes arrived for `gapMs`; `bytes`: the merged bytes reached `maxBytes`; `chunks`: ' +
        'the merged deliveries reached `maxChunks`; `flush`: a resize, an exit or a dispose ' +
        'closed it. It does **not** say whether the program is still writing or whether more ' +
        'output is coming: at a byte interface that is not provable, and a claim either way ' +
        'would be a judgement dressed as an observation (GOAL.md L1.2). ' +
        '**A group is bytes, and bytes are not always a visible change.** A group of a few ' +
        'hundred bytes can leave every row identical — a cursor moving, a highlight redrawn ' +
        'on itself, a menu painted over itself. `text` and `segments` are what tell those ' +
        'apart: comparing two screens can call a cursor move "nothing happened". ' +
        'When `collapsed.chunks > 1`, states existed that were not shown: read them with ' +
        '`history_read({from:{seq:collapsed.rawFrom}, to:{seq}, screen:true})`. ' +
        '`sinceSeq` defaults to the state the session was last typed at, so a group that ' +
        'closed *before* your input cannot satisfy the wait; pass the `seq` you last saw ' +
        'to continue from there. A firehose produces a sequence of groups — loop with ' +
        '`sinceSeq`. A session opened without grouping still ends on a group: with no ' +
        'detector there is no boundary to group to, so each update is one, and ' +
        '`collapsed` is null.',
      inputSchema: {
        sessionId: z.string(),
        sinceSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Only a group ending after this state counts. Default: the last input.'),
        timeoutMs: z.number().int().positive().describe('Give up after this long.'),
      },
    },
    async ({ sessionId, sinceSeq, timeoutMs }) => {
      const target = session(sessionId);
      if (!target) return fail('no_session', `no session ${sessionId}`);
      const result = await target.waitForGroup({ sinceSeq, timeoutMs });
      const { screen, segments, text, io, ...rest } = result;
      const said =
        result.reason === 'group'
          ? `group ${result.group} at state ${result.seq} (${result.collapsed?.reason ?? 'none'})`
          : result.reason;
      return {
        content: [{ type: 'text', text: said }],
        structuredContent: {
          sessionId,
          ...rest,
          screen: screen ? presentScreen(screen.lines) : null,
          // The change itself, in the form a read reports it, so a wait and a
          // read of one state are the same answer twice rather than two
          // descriptions a caller has to reconcile.
          segments: presentSegments(segments),
          text: presentText(text),
          io,
        },
      };
    },
  );

  server.registerTool(
    'history_read',
    {
      title: 'Read a session\'s history',
      description:
        'Address a session\'s timeline and read it back. This is one surface over one ' +
        'timeline: paging through what happened and replaying the states inside a group ' +
        'are the same operation here, at different settings. `from` and `to` take any ' +
        'address — a token from a previous read (`next`), a sequence number, a timestamp ' +
        'in ms, or a byte offset — and the two ends need not be the same kind. `level` ' +
        'chooses the projection: `records` (default, the deliveries as recorded), `groups` ' +
        '(the units the agent was shown, with verdicts), or `text` (plain lines). ' +
        '`screen: true` materializes the screen at each point, which is what turns a page ' +
        'into a playback — leave it off for cheap paging. Passing `to` reads a span and ' +
        'may cross a resize; paging with only `from` never does, and every result reports ' +
        'the grid size its records were produced at. This is how `collapsed.intermediates` ' +
        'from `read_screen` is followed up: read the group\'s span with `screen: true` to see ' +
        'the states it merged. History stays readable after `close_session` (L0.3). ' +
        'Returns `next` to resume, `truncated` when the limit stopped the read, and ' +
        '`stoppedAtEpochEnd` when the grid changed. **`ended` is how the process finished** ' +
        '— `{at, exitCode, signal}`, or `null` while it is still running. `exitCode` is ' +
        '`null` when a signal is what ended it, and it stays `null` after `close_session`: ' +
        'closing disposes the pty without an exit event, so a driven close has no code to ' +
        'report. `state.exit` on a read is the same fact without the timeline.',
      inputSchema: {
        sessionId: z.string(),
        from: z
          .union([
            z.string(),
            z.object({ token: z.string() }),
            z.object({ seq: z.number().int().nonnegative() }),
            z.object({ at: z.number().int().nonnegative() }),
            z.object({ byte: z.number().int().nonnegative() }),
          ])
          .optional()
          .describe('Where to start: a token, or {seq}, {at} (ms) or {byte}. Default: the beginning.'),
        to: z
          .union([
            z.string(),
            z.object({ token: z.string() }),
            z.object({ seq: z.number().int().nonnegative() }),
            z.object({ at: z.number().int().nonnegative() }),
            z.object({ byte: z.number().int().nonnegative() }),
          ])
          .optional()
          .describe('Where to stop, same address space. Default: read on from `from`.'),
        limit: z.number().int().positive().optional().describe('Cap on records, groups or lines. Default 50.'),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Cap in **characters**, cut at a whole delivery. For a driver returning after a gap: ' +
            'of 300 unseen groups the newest ones are actionable and the oldest are history, so ' +
            'assembly runs from the newest end and stops at a seq boundary. What did not fit is ' +
            'counted in `omitted`, with the screen at the cut so the gap is resumable. A single ' +
            'delivery larger than the budget still comes back in full rather than half a screen.',
          ),
        level: z
          .enum(['records', 'groups', 'text'])
          .optional()
          .describe('The projection: deliveries as recorded (default), the groups shown, or plain text.'),
        screen: z
          .boolean()
          .optional()
          .describe('Materialize the screen at each record — playback. Off by default.'),
      },
    },
    async ({ sessionId, from, to, limit, maxChars, level, screen }) => {
      const history = host.historyFor(sessionId as SessionId);
      if (!history) return fail('no_session', `no session ${sessionId}`);

      const options: HistoryReadOptions = {
        from: from as HistoryPoint | undefined,
        to: to as HistoryPoint | undefined,
        limit,
        level,
        screen,
        maxChars,
      };

      try {
        // A span is a replay: `deliveries` is what crosses a resize, because
        // what one group did is not less true for the grid having changed.
        if (options.to !== undefined && options.to !== null) {
          if ((options.level ?? 'records') === 'groups') {
            return fail('bad_input', 'a span (`to`) is read at the `records` or `text` level');
          }
          const records = history.deliveries(options.from, options.to);
          const capped = limit === undefined ? records : records.slice(0, limit);
          const lines = capped.flatMap((r) => r.text);
          const shaped = (options.level ?? 'records') === 'text'
            ? { level: 'text' as const, lines: lines.map((l) => ({ text: l.text })) }
            : {
                level: 'records' as const,
                records: capped.map((r) => ({
                  seq: r.seq,
                  group: r.group,
                  at: r.at,
                  fromByte: r.fromByte,
                  toByte: r.toByte,
                  text: r.text.map((l) => l.text),
                  epoch: r.epoch,
                  screen: presentScreen(r.screen.lines),
                  cursor: r.cursor,
                  buffer: r.buffer,
                })),
              };
          return {
            content: [
              {
                type: 'text',
                text:
                  (options.level ?? 'records') === 'text'
                    ? `${lines.length} lines across ${capped.length} deliveries`
                    : `${capped.length} deliveries`,
              },
            ],
            structuredContent: {
              sessionId,
              span: true,
              // A property of the timeline, not of the span: the caller that
              // came back after a gap is the one that most needs to know the
              // process is gone, and it is not something the span says.
              ended: history.ended,
              truncated: capped.length < records.length,
              ...shaped,
            },
          };
        }

        const page = history.readBack(options);
        const said = page.level === 'text'
          ? `${page.lines.length} lines`
          : page.level === 'groups'
            ? `${page.groups.length} groups`
            : `${page.records.length} deliveries${page.screens ? ' with screens' : ''}`;

        const shaped =
          page.level === 'text'
            ? { level: page.level, lines: page.lines.map((l) => l.text) }
            : page.level === 'groups'
              ? {
                  level: page.level,
                  groups: page.groups.map((j) => ({
                    group: j.group,
                    at: j.at,
                    fromByte: j.fromByte,
                    toByte: j.toByte,
                    text: presentText(j.text),
                    screen: presentScreen(j.screen.lines),
                    segments: presentSegments(j.segments),
                    chunks: j.chunks,
                  })),
                }
              : {
                  level: page.level,
                  records: page.records.map((r) => ({
                    seq: r.seq,
                    group: r.group,
                    at: r.at,
                    fromByte: r.fromByte,
                    toByte: r.toByte,
                    text: r.text.map((l) => l.text),
                    cursor: r.cursor,
                    buffer: r.buffer,
                    ...(r.screen ? { screen: presentScreen(r.screen.lines) } : {}),
                  })),
                };

        return {
          content: [{ type: 'text', text: said }],
          structuredContent: {
            sessionId,
            span: false,
            epoch: page.epoch,
            ended: history.ended,
            from: page.from,
            next: page.next,
            truncated: page.truncated,
            stoppedAtEpochEnd: page.stoppedAtEpochEnd,
            omitted: {
              count: page.omitted.count,
              reason: page.omitted.reason,
              fromSeq: page.omitted.fromSeq,
              ...(page.omitted.screen ? { screen: presentScreen(page.omitted.screen.lines) } : {}),
            },
            ...shaped,
          },
        };
      } catch (cause) {
        if (cause instanceof RangeError) return fail('bad_input', cause.message);
        throw cause;
      }
    },
  );

  server.registerTool(
    'close_session',
    {
      title: 'Close a session',
      description:
        'End a session and kill its process tree. Its history stays readable afterwards ' +
        '(L0.3), so closing is not forgetting.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      if (!session(sessionId)) return fail('no_session', `no session ${sessionId}`);
      host.close(sessionId as SessionId);
      return { content: [{ type: 'text', text: 'closed' }], structuredContent: { sessionId, closed: true } };
    },
  );

  return server;
}
