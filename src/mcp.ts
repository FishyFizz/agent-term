/**
 * The MCP surface — a spike of the core loop, not the whole thing.
 *
 * Four tools, because that is the smallest set an agent can drive a terminal
 * with: open one, type into it, read what happened, close it. Everything else
 * — history paging, intermediate playback, settle detection, interaction
 * beyond plain text — goes on top of these rather than beside them, and is
 * deliberately not here yet.
 *
 * The shape of a result matters more than the number of tools. A read returns
 * what a human at the screen would say: the screen, what changed on it, and
 * how much output the change stands for. It does not return escape sequences
 * and it does not ask the agent to guess a mode (L0.1). Where a value is not
 * knowable it is `null`, never 0 (L1.3).
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
export type ErrorCode = 'no_session' | 'not_live' | 'bad_input';

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

  // The last update each session produced, kept so a read can report what
  // *changed* and not only what the screen is. The session itself does not
  // retain its updates -- that is history's job -- and history is paged
  // rather than peeked at, so the surface keeps the one it needs.
  const latest = new Map<string, SessionUpdate>();

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
      opened.onUpdate((update) => latest.set(opened.id, update));
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
        'yet — which is not the same as an empty screen.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const target = session(sessionId);
      if (!target) return fail('no_session', `no session ${sessionId}`);
      const last = latest.get(sessionId);
      if (!last) {
        return {
          content: [{ type: 'text', text: '(no output yet)' }],
          structuredContent: {
            sessionId,
            screen: target.screen.snapshot().lines,
            update: null,
            bytesRead: target.pty.bytesRead,
          },
        };
      }
      return {
        content: [{ type: 'text', text: last.screen.lines.join('\n') }],
        structuredContent: { sessionId, ...present(last) },
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
      latest.delete(sessionId);
      host.close(sessionId as SessionId);
      return { content: [{ type: 'text', text: 'closed' }], structuredContent: { sessionId, closed: true } };
    },
  );

  return server;
}
