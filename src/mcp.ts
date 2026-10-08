/**
 * The MCP surface — a spike of the core loop, not the whole thing.
 *
 * Nine tools, because that is the smallest set an agent can drive a terminal
 * with: open one, type into it, send a batch of input as one write, wait for it
 * to stop changing, wait for it to show something, wait for its next group,
 * read what happened, address the timeline it happened on, close it. The rest of
 * interaction goes on top of these rather than beside them, and is deliberately
 * not here yet: a paste is a step of `send_sequence` rather than a tool of its
 * own, because the mode that decides its bytes is the same kind of fact a named
 * key already reads off the screen.
 *
 * The shape of a result matters more than the number of tools. A read returns
 * what a human at the screen would say: the screen, what changed on it, and
 * how much output the change stands for. It does not return escape sequences
 * and it does not ask the agent to guess a mode. Where a value is not
 * knowable it is `null`, never 0.
 *
 * A write reports `written`: the bytes as they were handed to the terminal, in
 * a form that can be compared with what was meant. A transport between an agent
 * and this server can silently drop a control character, and one driving run
 * spent three inputs discovering that its `ESC` had become inert text. Naming a
 * key removes the byte from the wire; reporting the bytes makes the round trip
 * visible when it does not.
 *
 * A read also reports the session's state as facts — whether it is running,
 * how long it has been idle, whether what it produced has been read through.
 * It does not report "settled". Whether a live program will produce more
 * output is not provable at a byte interface, and a value claiming otherwise
 * would be a judgement dressed as an observation. The waits are
 * the same: each says which of its own reasons stopped it — `idle`, `exited` or
 * `timeout`; `matched`, `exited` or `timeout` — and leaves what that means to
 * the caller, who knows what it is driving.
 *
 * Errors are typed and actionable rather than opaque: a caller gets a
 * code it can branch on, not a stack trace.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionHost } from './host.js';
import { composeSteps, escapeBytes, KeyInputError, KEY_SUMMARY, type Composed } from './keys.js';
import type { Segment } from './classify.js';
import type { HistoryPoint, HistoryReadOptions, Omission } from './history.js';
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
 * What a cut read left out, as the agent reads it: how much, why, and where to
 * resume. One shape for both a page and a span, so a caller branches on the
 * same fields whichever read it made — and so the anchor screen is trimmed and
 * shaped like every other screen the surface returns.
 */
function presentOmission(omitted: Omission) {
  return {
    count: omitted.count,
    reason: omitted.reason,
    fromSeq: omitted.fromSeq,
    overBudget: omitted.overBudget,
    ...(omitted.screen ? { screen: presentScreen(omitted.screen.lines) } : {}),
  };
}

/**
 * One screen, as the agent reads it: trailing blanks trimmed off every row.
 *
 * The grid is `cols` wide and every row is padded to it, so what a caller is
 * handed is `rows` x `cols` characters whether or not the program wrote them.
 * On a 140x40 grid that was 5,600 characters a read and 12,870 tokens across
 * nine screens, of which 11% carried anything. Blank cells hold no fact the
 * rest of the report does not: a row that was erased or overwritten is in
 * `segments`, a line that was completed is in `text`, and neither needs the
 * padding to be read.
 *
 * Trimmed from the end only, so every glyph keeps its column, and every row
 * stays in the array at its own index -- a row the program blanked is `''`,
 * not a shift. It is the stripping `wait_for_output` already does before
 * matching a pattern (`match.ts`), applied to what the caller is shown.
 */
function presentScreen(lines: readonly string[]): string[] {
  const rows = lines.map((line) => line.replace(/ +$/, ''));
  // The end of the grid as well as the end of each row: the blank rows below
  // the last one carrying anything are the same padding, stood upright, and a
  // repaint of a menu on a tall terminal pays for them on every delivery.
  // End-only again -- a blank row *between* two written ones is layout, and
  // cutting it would be cutting a fact rather than a margin.
  //
  // Every row that is delivered keeps its own index, and a row past the end is
  // blank, so `changedRows` may name a row the screen does not carry: an index
  // out of range means the act blanked it, which is the same thing the row
  // would have said had it been delivered. A screen with nothing on it is `[]`
  // rather than `rows` empty strings.
  let last = rows.length;
  while (last > 0 && rows[last - 1] === '') last--;
  return rows.slice(0, last);
}

/**
 * Rows, collapsed into runs on the way out.
 *
 * `changedRows` is the field that grows with the terminal rather than with what
 * happened: a repaint that touches every row of a 200-row grid names 200 rows,
 * at about four characters each, to say one thing -- the whole grid. So a
 * contiguous stretch becomes `"from-to"`, and a row on its own stays the number
 * it already was. Not uniform on purpose: a run of one costs *more* as a string
 * than as the number, and one row is the common case (measured over the corpus
 * at the granularity the server delivers at: 36% of deliveries report a single
 * row, the mean is 3.3, and none reported more than ten).
 *
 * The model keeps `number[]` -- `classify` is where the fact lives, and the
 * grid is not a delivery detail. This is the shape of the *delivery*, so a
 * caller reading rows out of the screen it was handed expands the ranges
 * first: `"1-10"` is ten rows, not one.
 */
function presentChangedRows(rows: readonly number[] | null): (number | string)[] | null {
  if (rows === null) return null;
  const out: (number | string)[] = [];
  for (let first = 0; first < rows.length; ) {
    let last = first;
    while (last + 1 < rows.length && rows[last + 1] === rows[last]! + 1) last++;
    out.push(last === first ? rows[first]! : `${rows[first]}-${rows[last]}`);
    first = last + 1;
  }
  return out;
}

/**
 * The terminal modes a batch consulted, as the agent reads them.
 *
 * The object is `null` when no step consulted any of them — a batch of plain
 * text made no decision that depended on a mode, and a `false` would answer a
 * question that was never asked. Inside a reported object a mode no step
 * consulted is `null` for the same reason, so `bracketedPaste: false` always
 * means "a paste was encoded, and the program had not enabled it".
 */
function presentModes(composed: Composed) {
  if (composed.applicationCursorKeys === null && composed.bracketedPaste === null) return null;
  return {
    applicationCursorKeys: composed.applicationCursorKeys,
    bracketedPaste: composed.bracketedPaste,
  };
}

/** One update, in the form the agent reads: what the screen is and what changed. */
function present(update: SessionUpdate) {
  return {
    seq: update.seq,
    screen: presentScreen(update.screen.lines),
    segments: presentSegments(update.segments),
    changedRows: presentChangedRows(update.changedRows),
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

  // One address space, for both ends of a read. Declared once because that is
  // the fact the two parameters share -- the ends "need not be the same kind"
  // but they are the same *kinds*, and two copies of the union are two
  // definitions of what an address is. A kind added to one and not the other
  // would be a range that cannot be expressed.
  const address = z.union([
    z.string(),
    z.object({ token: z.string() }),
    z.object({ seq: z.number().int().nonnegative() }),
    z.object({ at: z.number().int().nonnegative() }),
    z.object({ byte: z.number().int().nonnegative() }),
  ]);

  server.registerTool(
    'open_session',
    {
      title: 'Open a terminal session',
      description:
        'Start a hosted terminal session running a command; with no command you get a ' +
        'platform shell. Returns the `sessionId` every other tool addresses, plus the grid ' +
        'size and the pid.',
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
        'Write text into a session, as if typed. `submit: true` appends the line ending, so a ' +
        'command that needs Enter pressed should set it. To press a key rather than type ' +
        'characters — arrows, Tab, Escape, Ctrl-C — use `send_sequence`. The result reports ' +
        '`written`: the bytes as they were handed to the terminal.',
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
        'Write several inputs as one write, in order: each step is `{text}`, `{paste}`, ' +
        '`{key}` or `{byte}`. This is how a named key or a raw byte is sent, and how "type ' +
        'this, then press Enter" becomes one call rather than two. Keys are named, not ' +
        'spelled (' +
        KEY_SUMMARY +
        '); a key is encoded for the mode the program has set, read off the screen. A ' +
        '`{paste}` is an insertion, wrapped in bracketed-paste guards when the program has ' +
        'enabled them. Nothing waits inside a batch. The result reports what each step wrote ' +
        'and the modes it consulted; the agent-term skill covers key names and paste ' +
        'semantics in full.',
      inputSchema: {
        sessionId: z.string(),
        steps: z
          .array(
            z.looseObject({
              text: z.string().optional().describe('Literal text to type.'),
              paste: z
                .string()
                .optional()
                .describe(
                  'Text to paste — an insertion, not keystrokes. Wrapped in bracketed-paste ' +
                    'guards when the program has enabled them, written plain when not.',
                ),
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
          .describe('The steps, in order. Each step is exactly one of text, paste, key or byte.'),
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
            ...(step.wrapped === undefined ? {} : { wrapped: step.wrapped }),
            written: step.written,
          })),
          modes: presentModes(composed),
        },
      };
    },
  );

  server.registerTool(
    'read_screen',
    {
      title: 'Read what a session shows now',
      description:
        'The screen as it is now, what changed on it, and how much output that change stands ' +
        'for. Returns the last classified update — `null` when nothing has arrived yet, ' +
        'which is not the same as an empty screen — plus `state`. A `wait_for_group` already ' +
        'returns this same report for the state it ended at. See the agent-term skill for ' +
        'the field contract (`screen`, `segments`, `changedRows`, `seq`, `state`).',
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
      // Reading is looking: a read hands the caller this state, so it is where
      // the waits' default baseline starts from next. Without it, a read
      // followed by a wait hands back the state that was just read -- the same
      // repeat as two waits with nothing in between.
      target.noteShown(last.seq, last.io.bytesRead);
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
        'Block until the session has been quiet for `idleMs` and everything it produced has ' +
        'been read through, or until `timeoutMs` passes. Returns which of those stopped it: ' +
        '`idle`, `exited` or `timeout`. Idle does not mean the program has finished. Use it ' +
        'instead of sleeping after a send; when you want the change itself, `wait_for_group` ' +
        'returns it with the verdict.',
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
        '`timeoutMs` passes or the process exits. Returns `reason` (`matched`, `exited`, ' +
        '`timeout`) and, on a match, the text, row and byte it was found at. When it does ' +
        'not match, `screen` carries the rows it ended on, so a timeout needs no second ' +
        'call. Prefer this over wait-then-eyeball when the program has a readiness signal ' +
        'you can name. A match is an observation, not proof the program is finished. See the ' +
        'agent-term skill for `surface`, `sinceByte` and the matching rules.',
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
          .describe(
            'Match only output produced after this byte watermark. Default: the later of the ' +
              'last input and the last byte shown to you.',
          ),
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
        'Block until the next group is delivered — a run of output closed by silence or by a ' +
        'cap — or until `timeoutMs`. This is the wait a full-screen TUI needs: idle is ' +
        'negative and a repainting menu has no text to anchor a pattern on. **The wait ' +
        'carries the change with the verdict** (`seq`, `screen`, `segments`, `text`, ' +
        '`changedRows`, `collapsed`, `io`), so `send` then `wait_for_group` is a whole loop ' +
        'in two calls. Returns `reason`: `group`, `exited`, `disposed` or `timeout`. A group ' +
        'is measured, not interpreted — it does not say the program has finished. See the ' +
        'agent-term skill for what a group is and how to read one.',
      inputSchema: {
        sessionId: z.string(),
        sinceSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Only a group ending after this state counts. Default: the later of the last ' +
              'input and the last state shown to you.',
          ),
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
          changedRows: presentChangedRows(result.changedRows),
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
        'Address a session\'s timeline and read it back; history stays readable after ' +
        '`close_session`. `from`/`to` take any address — a token from a previous read ' +
        '(`next`), `{seq}`, `{at}` in ms, or `{byte}` — and the ends need not match. `to` ' +
        'reads a span (a replay, which crosses a resize); `from` alone pages. `level` picks ' +
        'the projection: `records` (default), `groups`, or `text`. Both reads are bounded by ' +
        '`limit` and `maxChars`, and a cut read reports `truncated` and `omitted` rather ' +
        'than failing silently. See the agent-term skill for the full contract — page vs ' +
        'span, `epoch`, `ended`, and how to resume.',
      inputSchema: {
        sessionId: z.string(),
        from: address
          .optional()
          .describe('Where to start: a token, or {seq}, {at} (ms) or {byte}. Default: the beginning.'),
        to: address
          .optional()
          .describe('Where to stop, same address space. Setting it makes this a span (a replay). Default: read on from `from`.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Cap on records, groups or lines. Default 50 for a page; a span is already bounded ' +
              'by the addresses you gave it.',
          ),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Cap in characters, cut at a whole delivery, for a page and a span alike. What did ' +
              'not fit is counted in `omitted`; a single delivery larger than the budget still ' +
              'comes back in full, flagged `overBudget`.',
          ),
        level: z
          .enum(['records', 'groups', 'text'])
          .optional()
          .describe('The projection: deliveries as recorded (default), the groups shown, or plain text. A span is read at `records` or `text`.'),
        screen: z
          .boolean()
          .optional()
          .describe(
            'Materialize the screen at each record — playback. Off by default for a page; a ' +
              'span is a replay and always carries it.',
          ),
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
        const level = options.level ?? 'records';

        // A span is a replay: it crosses a resize, because what one group did
        // is not less true for the grid having changed. And it is bounded by
        // the same two caps a page is -- a span is how `collapsed.rawFrom` and
        // `rawTo` are followed up, and an unbounded answer to that is the one
        // that blows a caller's context.
        if (options.to !== undefined && options.to !== null) {
          if (level === 'groups') {
            return fail('bad_input', 'a span (`to`) is read at the `records` or `text` level');
          }
          const replay = history.span(options.from, options.to, { level, limit, maxChars });
          const lines = replay.records.flatMap((r) => r.text);
          const shaped =
            level === 'text'
              ? { level: 'text' as const, lines: lines.map((l) => l.text) }
              : {
                  level: 'records' as const,
                  records: replay.records.map((r) => ({
                    seq: r.seq,
                    group: r.group,
                    at: r.at,
                    fromByte: r.fromByte,
                    toByte: r.toByte,
                    text: r.text.map((l) => l.text),
                    // A span crosses epochs, so each record has to say which
                    // grid it was produced at -- the page reports one size for
                    // the whole read, and a span has no one size to report.
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
                  level === 'text'
                    ? `${lines.length} lines across ${replay.records.length} deliveries`
                    : `${replay.records.length} deliveries${replay.truncated ? ' (cut)' : ''}`,
              },
            ],
            structuredContent: {
              sessionId,
              span: true,
              // A property of the timeline, not of the span: the caller that
              // came back after a gap is the one that most needs to know the
              // process is gone, and it is not something the span says.
              ended: history.ended,
              truncated: replay.truncated,
              omitted: presentOmission(replay.omitted),
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
            omitted: presentOmission(page.omitted),
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
        'End a session and kill its process tree. Its history stays readable afterwards, ' +
        'so closing is not forgetting.',
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
