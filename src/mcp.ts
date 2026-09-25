/**
 * The MCP surface — a spike of the core loop, not the whole thing.
 *
 * Six tools, because that is the smallest set an agent can drive a terminal
 * with: open one, type into it, wait for it to stop changing, wait for it to
 * show something, read what happened, close it. Everything else — history
 * paging, intermediate playback, interaction beyond plain text — goes on top of
 * these rather than beside them, and is deliberately not here yet.
 *
 * The shape of a result matters more than the number of tools. A read returns
 * what a human at the screen would say: the screen, what changed on it, and
 * how much output the change stands for. It does not return escape sequences
 * and it does not ask the agent to guess a mode (L0.1). Where a value is not
 * knowable it is `null`, never 0 (L1.3).
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
import type { SessionUpdate } from './session.js';
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

/** One update, in the form the agent reads: what the screen is and what changed. */
function present(update: SessionUpdate) {
  return {
    seq: update.seq,
    screen: update.screen.lines,
    segments: update.segments.map((s) => ({
      kind: s.kind,
      fromByte: s.fromByte,
      toByte: s.toByte,
      erased: s.evidence.erased,
      overwrote: s.evidence.overwrote,
      reachedBack: s.evidence.reachedBack,
      scrolledBy: s.evidence.scrolledBy,
      altScreen: s.evidence.altScreen,
    })),
    text: update.text.map((l) => l.text),
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
        'that needs Enter pressed should set it.',
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
      target.pty.write(submit ? `${text}\r\n` : text);
      return {
        content: [{ type: 'text', text: 'sent' }],
        structuredContent: { sessionId, bytesWritten: Buffer.byteLength(text, 'utf8'), submitted: submit ?? false },
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
        'yet — which is not the same as an empty screen. Also reports `state`: whether ' +
        'the session is running, how long it has been idle, and whether what it produced ' +
        'has been read through.',
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
            screen: target.screen.snapshot().lines,
            update: null,
            bytesRead: target.pty.bytesRead,
            state,
          },
        };
      }
      return {
        content: [{ type: 'text', text: last.screen.lines.join('\n') }],
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
        'byte it arrived at). A pattern is matched against screen rows the session wrote, ' +
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
      return {
        content: [{ type: 'text', text: said }],
        structuredContent: { sessionId, ...result },
      };
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
