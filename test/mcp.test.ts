/**
 * The MCP surface, driven through a real client rather than by calling the
 * handlers directly.
 *
 * That distinction is the point: a handler called in-process proves nothing
 * about the schema a client sees, or about what survives being serialised and
 * answered. So this connects a Client and a Server over a linked in-memory
 * transport and exercises the loop the way an agent would — open, type, read,
 * close — against a real pty running a real shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';
import { SessionHost } from '../src/host.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connected() {
  const host = new SessionHost();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(host);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, host, close: async () => { await client.close(); await server.close(); } };
}

type ToolResult = Record<string, unknown> & { content?: Array<{ text?: string }> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

test('the surface exposes the core loop', async (t) => {
  const { client, close } = await connected();
  t.after(close);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'close_session',
    'open_session',
    'read_screen',
    'send_input',
    'wait_for_idle',
  ]);
  for (const tool of tools.tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} says what it does`);
    assert.ok(tool.inputSchema, `${tool.name} declares its input`);
  }
});

test('an agent can open a shell, run a command, and read the result', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
  assert.ok(sessionId, 'a session id came back');

  await call(client, 'send_input', { sessionId, text: 'echo AGENTTERM-MCP', submit: true });

  // Real output over a real pty, so it arrives when it arrives.
  let screen = '';
  for (let i = 0; i < 200 && !screen.includes('AGENTTERM-MCP'); i++) {
    await delay(50);
    const read = await call(client, 'read_screen', { sessionId });
    screen = (read.content?.[0]?.text ?? '') + JSON.stringify(read.structuredContent ?? {});
  }
  assert.ok(screen.includes('AGENTTERM-MCP'), `the echo came back, got: ${screen.slice(0, 300)}`);

  const read = await call(client, 'read_screen', { sessionId });
  const payload = read.structuredContent as {
    screen: string[];
    segments: Array<{ kind: string }>;
    collapsed: unknown;
    io: { bytesRead: number };
  };
  assert.ok(payload.screen.length > 0, 'the screen came back as rows');
  assert.ok(payload.segments.length > 0, 'with what changed on it');
  assert.equal(payload.segments[0]!.kind, 'writing', 'appended text is reported as writing');
  assert.ok(payload.io.bytesRead > 0, 'and a byte watermark to distinguish quiet from unread');
});

test('a read after a wait is the new state, not the one the send interrupted', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
  await call(client, 'send_input', { sessionId, text: 'echo WAITED-WELL', submit: true });

  // No polling loop anywhere in this test: the wait is what finds the output.
  const waited = await call(client, 'wait_for_idle', { sessionId, idleMs: 300, timeoutMs: 15000 });
  const result = waited.structuredContent as {
    reason: string;
    waitedMs: number;
    state: { running: boolean; idleMs: number | null; drained: boolean | null };
  };
  assert.ok(
    result.reason === 'idle' || result.reason === 'exited',
    `the wait ended well, got: ${result.reason}`,
  );
  assert.ok(result.waitedMs >= 0, 'and reports how long it took');
  assert.equal(result.state.drained, true, 'drained: what it produced has been read through');

  const read = await call(client, 'read_screen', { sessionId });
  const screen = (read.content?.[0]?.text ?? '') + JSON.stringify(read.structuredContent ?? {});
  assert.ok(screen.includes('WAITED-WELL'), `the output is there, got: ${screen.slice(0, 300)}`);
});

test('a read reports the session state as facts, with no verdict on it', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
  await call(client, 'wait_for_idle', { sessionId, idleMs: 200, timeoutMs: 15000 });

  const read = await call(client, 'read_screen', { sessionId });
  const state = (read.structuredContent as { state: Record<string, unknown> }).state;
  assert.deepEqual(
    Object.keys(state).sort(),
    ['bytesPending', 'drained', 'exit', 'idleMs', 'running'],
    'a caller is given measurements and can find no field that decided for it',
  );
  assert.equal(state.running, true, 'running');
  assert.equal(state.exit, null, 'and no exit');
});

test('a wait that cannot be satisfied says so, rather than hanging', async (t) => {
  const { client, host, close } = await connected();
  t.after(() => {
    host.disposeAll();
    return close();
  });

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  // A minute of quiet asked for, 50ms allowed: unreachable, and reported.
  const waited = await call(client, 'wait_for_idle', { sessionId, idleMs: 60000, timeoutMs: 50 });
  const result = waited.structuredContent as { reason: string; waitedMs: number };
  assert.equal(result.reason, 'timeout', 'gave up rather than hanging');
  assert.ok(result.waitedMs <= 50 + 100, `and did not overrun by much (${result.waitedMs}ms)`);
});

test('an unknown session is a typed error, not a stack trace', async (t) => {
  const { client, close } = await connected();
  t.after(close);

  const result = await call(client, 'read_screen', { sessionId: 'nope' });
  assert.equal(result.isError, true, 'reported as an error');
  const error = (result.structuredContent as { error: { code: string } }).error;
  assert.equal(error.code, 'no_session', 'with a code a caller can branch on');
});

test('closing ends the session and the tool says so', async (t) => {
  const { client, close } = await connected();
  t.after(close);

  const opened = await call(client, 'open_session', {});
  const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;

  const closed = await call(client, 'close_session', { sessionId });
  assert.equal((closed.structuredContent as { closed: boolean }).closed, true);

  const after = await call(client, 'read_screen', { sessionId });
  assert.equal(after.isError, true, 'the session is gone afterwards');
});
