/**
 * The view server, over a real loopback port.
 *
 * No test in this repository binds a port today -- everything is in memory --
 * so this one is a deliberate exception and says why: the safety posture is
 * *in the transport*, and a posture that is never exercised is a posture that
 * is only asserted in a comment. The `Host` and `Origin` refusals, the token,
 * and the handshake are all things a caller gets wrong in the socket rather
 * than in the object, so they are tested in the socket.
 *
 * Every server is closed in `t.after`, and the port is ephemeral, so a test
 * never picks one that something else is using.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Duplex } from 'node:stream';
import { TerminalSession } from '../src/session.js';
import { ViewServer } from '../src/view-server.js';

const isWindows = process.platform === 'win32';
const command = isWindows ? 'powershell.exe' : '/bin/sh';
const args = isWindows ? ['-NoLogo', '-NoProfile'] : [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitFor(
  predicate: () => boolean,
  { timeoutMs = 10000, label = 'condition' } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(25);
    }
    console.log(`       (timed out waiting for ${label})`);
    return false;
  })();
}

/** A live session, and a view server serving it. */
async function harness() {
  const session = new TerminalSession('view-server-test', { command, args, cols: 100, rows: 24 });
  await waitFor(() => session.pty.bytesRead > 0, { label: 'the shell prompt' });
  const views = new ViewServer();
  const handle = await views.open(session);
  return { session, views, handle };
}

/** A plain GET, with headers a hostile client would send. */
function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A WebSocket upgrade, as a browser would open one. */
function upgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; socket?: Duplex }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      resolve({ status: res.statusCode ?? 0, socket });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Resolve when a socket is open. */
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) return resolve();
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('the view did not accept the connection'));
  });
}

type Message = { type: string; screen?: { lines: string[] }; cols?: number; rows?: number };

/** A client that keeps everything it was sent. */
async function connect(handle: { url: string; token: string }) {
  const socket = new WebSocket(`ws://127.0.0.1:${new URL(handle.url).port}/v/${handle.token}/ws`);
  const messages: Message[] = [];
  socket.onmessage = (event) => {
    try {
      messages.push(JSON.parse(String(event.data)) as Message);
    } catch {
      // Not ours to parse; ignore.
    }
  };
  await opened(socket);
  return {
    socket,
    messages,
    send(body: unknown): void {
      socket.send(JSON.stringify(body));
    },
    has(predicate: (message: Message) => boolean): boolean {
      return messages.some(predicate);
    },
  };
}

test('a client is served the screen, and what it types reaches the session', async (t) => {
  const { session, views, handle } = await harness();
  t.after(async () => {
    await views.closeAll();
    session.dispose();
  });

  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/v\/[0-9a-f-]+\/$/, 'the url is loopback and unguessable');
  assert.ok(handle.port > 0, 'the port it bound is reported');
  assert.equal(handle.cols, 100);
  assert.equal(handle.rows, 24);

  const client = await connect(handle);
  t.after(() => client.socket.close());

  const greeted = await waitFor(() => client.has((m) => m.type === 'hello'), { label: 'the greeting' });
  assert.ok(greeted, 'an attaching client is sent the screen as it is now');
  const hello = client.messages.find((m) => m.type === 'hello')!;
  assert.equal(hello.cols, 100, 'and the grid it was produced at');

  client.send({ kind: 'keys', steps: [{ text: 'echo VIEW-WS' }, { key: 'enter' }] });
  const got = await waitFor(
    () => client.has((m) => m.type === 'screen' && (m.screen?.lines ?? []).some((l) => l.includes('VIEW-WS'))),
    { label: 'the echoed line' },
  );
  assert.ok(got, 'what the human typed went into the pty and came back on the screen');

  const facts = views.facts(session.id)!;
  assert.equal(facts.attached, 1, 'the agent is told a human is attached');
  assert.ok(facts.lastInputAt !== null, 'and when they last typed');
});

test('the page is served to a loopback client and to nobody else', async (t) => {
  const { session, views, handle } = await harness();
  t.after(async () => {
    await views.closeAll();
    session.dispose();
  });

  const served = await get(handle.port, `/v/${handle.token}/`);
  assert.equal(served.status, 200);
  assert.ok(served.body.includes('<pre id="screen">'), 'it is the client, not a placeholder');

  // The token is the capability: a path that does not name a view is a
  // missing one, and there is no listing of them.
  const unknown = await get(handle.port, '/v/00000000-0000-0000-0000-000000000000/');
  assert.equal(unknown.status, 404);

  // Bound to loopback is not the same as safe: a browser can be pointed at a
  // hostname that resolves here, and the `Host` is what gives it away.
  const rebound = await get(handle.port, `/v/${handle.token}/`, { host: 'evil.example' });
  assert.equal(rebound.status, 403);
});

test('an upgrade from somewhere else is refused, and closing detaches', async (t) => {
  const { session, views, handle } = await harness();
  t.after(async () => {
    await views.closeAll();
    session.dispose();
  });

  const foreign = await upgrade(handle.port, `/v/${handle.token}/ws`, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403, 'a web page cannot open a view');

  // A browser on this machine is allowed, and its Origin carries a scheme --
  // the case a plain string comparison gets wrong, and gets wrong in the
  // direction that looks like the server not running at all.
  const localOrigin = await upgrade(handle.port, `/v/${handle.token}/ws`, {
    Origin: `http://127.0.0.1:${handle.port}`,
  });
  assert.equal(localOrigin.status, 101, 'and one from here is accepted');
  localOrigin.socket?.destroy();

  // A non-browser client sends no origin and is allowed -- it is a person
  // running a command.
  const local = await upgrade(handle.port, `/v/${handle.token}/ws`, {});
  assert.equal(local.status, 101, 'and one from here is accepted');
  local.socket?.destroy();
  // Detaching is the socket's own event, so it lands after the destroy.
  assert.ok(
    await waitFor(() => views.facts(session.id)!.attached === 0, { label: 'the probe to detach' }),
    'a client that goes away is no longer counted as attached',
  );

  const client = await connect(handle);
  let closed = false;
  client.socket.onclose = () => {
    closed = true;
  };
  assert.equal(views.facts(session.id)!.attached, 1);

  views.close(session.id);
  assert.ok(await waitFor(() => closed, { label: 'the client to be detached' }), 'closing the view closes its clients');
  assert.equal(views.facts(session.id), null, 'and the agent is told there is no view');
});
