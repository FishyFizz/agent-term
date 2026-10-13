/**
 * The loopback server a human's client connects to.
 *
 * `SessionView` decides what a viewer is shown and what a human sent; this puts
 * a socket in front of one. It is **L3** -- transport, safety, packaging --
 * and it is deliberately replaceable: nothing in `view.ts` knows it exists.
 *
 * ## Why its own server and not a route on the MCP one
 *
 * The MCP server may be stdio, spawned by the agent's client, with no HTTP
 * surface at all. A human's window has to reach the sessions through something
 * that exists in both modes, so the view server stands alone on its own
 * loopback port. It binds an **ephemeral port** and reports it, rather than
 * sharing 8787, because a second listener would be a second thing to configure
 * and a fixed one would collide with whatever else is running.
 *
 * ## The safety posture is the project's, stated once
 *
 * `scripts/mcp-http.ts` says it for the MCP side: *this server runs arbitrary
 * commands for whoever asks; changing that default is a change to the safety
 * posture, not a networking tweak.* A view is the same command runner wearing a
 * different face -- it hands a live terminal to whoever connects. So:
 *
 *  - **Loopback bind.** Nothing off the machine can reach it.
 *  - **`Host` must be loopback.** Bound to loopback is not the same as safe:
 *    a browser on this machine can be pointed at a hostile hostname that
 *    resolves to 127.0.0.1, and the request that arrives is indistinguishable
 *    from a local one except for the `Host` it names. That is DNS rebinding,
 *    and rejecting a `Host` that is not loopback is what stops it.
 *  - **An unguessable token in the path**, per view. Holding the URL is the
 *    capability; there is no other check, and there is no listing of them.
 *  - **A foreign `Origin` is refused** on the WebSocket. Otherwise any web page
 *    the human visits could open a socket to a view and drive a shell; the
 *    header is the only thing that tells us where the connection came from.
 *    A non-browser client sends none, and is allowed.
 *
 * ## A minimal WebSocket, and why it is here
 *
 * Interactive terminal frontends speak WebSocket (ttyd, gotty, and everything
 * built on them), so the protocol is chosen to be joinable rather than
 * invented. Node ships no WebSocket server, and adding one dependency for what
 * is used by clients we also wrote would be a poor trade -- so the handshake
 * and the framing are here, ~150 lines, handling what the protocol requires:
 * the accept hash, 7/16/64-bit lengths, masking, fragmentation, ping/pong and
 * close. Both ends are ours, which is what makes that safe; a general-purpose
 * server would be a much larger thing.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { SessionView, type ViewEvent, type ViewFacts, type ViewPolicy } from './view.js';
import { viewPage } from './view-page.js';
import type { Step } from './keys.js';
import type { TerminalSession } from './session.js';
import type { SessionId } from './types.js';

/** The GUID every WebSocket accept hash is computed with. RFC 6455. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * The largest frame accepted.
 *
 * A screen can be large -- a styled 200x50 grid is over 100 KiB -- but a
 * client's *input* is keystrokes, and a cap is what stops a peer from asking
 * us to buffer something unbounded.
 */
const MAX_FRAME = 8 * 1024 * 1024;

/** One view, and the clients attached to it. */
interface Entry {
  readonly view: SessionView;
  readonly token: string;
  /** Whether a client's declared size resizes the session. */
  readonly followResize: boolean;
  readonly peers: Set<Peer>;
}

/** What a connected client can be sent, and closed. */
interface Peer {
  send(text: string): void;
  close(): void;
}

/** What `open` hands back: how a human reaches this session. */
export interface ViewHandle {
  sessionId: SessionId;
  /** The unguessable part of the URL. Holding it is the capability. */
  token: string;
  /** Where the browser client is served. */
  url: string;
  /** What the terminal client is run with. Absolute, so it works from any cwd. */
  command: string;
  port: number;
  cols: number;
  rows: number;
}

export interface ViewServerOptions {
  /** Port to bind. Default 0 — the OS assigns one, and `open` reports it. */
  port?: number;
  /** Host to bind. Default `127.0.0.1`. */
  host?: string;
  policy?: ViewPolicy;
}

/** Whether a `Host`/`Origin` names this machine. */
function isLoopback(value: string | undefined): boolean {
  if (!value) return false;
  // An `Origin` carries a scheme and a `Host` does not; either may carry a
  // port, and an IPv6 literal is bracketed. Strip all three before comparing,
  // or `http://127.0.0.1:8787` is read as a hostname that starts with "http"
  // and every browser is refused -- which is a refusal that looks, from the
  // outside, exactly like a server that is not running.
  const host = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** `/v/<token>` and `/v/<token>/ws`, and nothing else. */
function tokenFromPath(url: string | undefined): { token: string; ws: boolean } | null {
  const path = (url ?? '/').split('?')[0] ?? '/';
  const parts = path.split('/').filter((p) => p !== '');
  if (parts[0] !== 'v' || !parts[1]) return null;
  return { token: parts[1]!, ws: parts[2] === 'ws' };
}

export class ViewServer {
  private readonly entries = new Map<string, Entry>();
  private readonly bySession = new Map<SessionId, string>();
  private readonly policy: ViewPolicy;
  private readonly port: number;
  private readonly host: string;

  private server: ReturnType<typeof createHttpServer> | null = null;
  private listening: Promise<number> | null = null;
  private boundPort = 0;

  constructor(options: ViewServerOptions = {}) {
    this.policy = options.policy ?? {};
    this.port = options.port ?? 0;
    this.host = options.host ?? '127.0.0.1';
  }

  /**
   * Serve a view of `session`. Idempotent per session: a second call returns
   * the view that is already open, because "give me a window on this session"
   * asked twice is the same question, and two views would disagree about who
   * is attached.
   */
  async open(
    session: TerminalSession,
    options: { followResize?: boolean } = {},
  ): Promise<ViewHandle> {
    const existing = this.bySession.get(session.id);
    if (existing) {
      const entry = this.entries.get(existing);
      if (entry && !entry.view.closed) return this.handle(entry);
      this.forget(session.id);
    }

    const view = new SessionView(session, this.policy);
    const token = randomUUID();
    const entry: Entry = {
      view,
      token,
      followResize: options.followResize ?? true,
      peers: new Set(),
    };
    this.entries.set(token, entry);
    this.bySession.set(session.id, token);

    const bound = await this.listen();
    return this.handle(entry, bound);
  }

  /** What the agent is told about the human on `sessionId`, or `null` if no view was opened. */
  facts(sessionId: SessionId): ViewFacts | null {
    const token = this.bySession.get(sessionId);
    if (!token) return null;
    return this.entries.get(token)?.view.facts ?? null;
  }

  /** Detach every client, end the view, and release the port if it was the last one. */
  close(sessionId: SessionId): boolean {
    const token = this.bySession.get(sessionId);
    if (!token) return false;
    const entry = this.entries.get(token);
    if (!entry) return false;
    for (const peer of [...entry.peers]) peer.close();
    entry.peers.clear();
    entry.view.close();
    this.forget(sessionId);
    if (this.entries.size === 0) void this.stop();
    return true;
  }

  /** End every view. Called when the process is done with them. */
  async closeAll(): Promise<void> {
    for (const id of [...this.bySession.keys()]) this.close(id);
    await this.stop();
  }

  private forget(sessionId: SessionId): void {
    const token = this.bySession.get(sessionId);
    if (token === undefined) return;
    this.entries.delete(token);
    this.bySession.delete(sessionId);
  }

  private handle(entry: Entry, port = this.boundPort): ViewHandle {
    const url = `http://${this.host}:${port}/v/${entry.token}/`;
    const size = entry.view.size;
    return {
      sessionId: entry.view.sessionId,
      token: entry.token,
      url,
      // Absolute, so the human can run it from anywhere and not only from the
      // repository root -- the agent is relaying this to someone who may not
      // know where the server lives.
      command: `npx tsx ${scriptPath()} ${url}`,
      port,
      cols: size.cols,
      rows: size.rows,
    };
  }

  private listen(): Promise<number> {
    if (this.listening) return this.listening;
    this.listening = new Promise<number>((resolve, reject) => {
      const server = createHttpServer((req, res) => this.onRequest(req, res));
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        const address = server.address();
        this.boundPort = typeof address === 'object' && address !== null ? address.port : 0;
        this.server = server;
        resolve(this.boundPort);
      });
    });
    return this.listening;
  }

  private async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.listening = null;
    this.boundPort = 0;
    await new Promise<void>((resolve) => {
      // Connections are dropped rather than waited on: a client watching a
      // session that has been closed is not going to send anything useful,
      // and a server that waits for them keeps the port and the process.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopback(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    const path = tokenFromPath(req.url);
    const entry = path ? this.entries.get(path.token) : undefined;
    if (!path || path.ws || !entry) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // A view is a live terminal; nothing should keep a copy of one.
      'cache-control': 'no-store',
    });
    res.end(viewPage(entry.token));
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const deny = (): void => {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };
    if (!isLoopback(req.headers.host)) return deny();
    // A browser tells us where it came from; a non-browser client sends none
    // and is allowed, because it is a person running a command.
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopback(origin)) return deny();

    const path = tokenFromPath(req.url);
    const entry = path?.ws ? this.entries.get(path.token) : undefined;
    if (!entry) return deny();
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') return deny();
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') return deny();

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.serve(entry, socket, head);
  }

  /** One client, for the life of its socket. */
  private serve(entry: Entry, socket: Duplex, head: Buffer): void {
    const peer = acceptWebSocket(socket, head, (text) => this.onMessage(entry, peer, text));
    entry.peers.add(peer);

    const detach = entry.view.attach((event: ViewEvent) => {
      peer.send(JSON.stringify(event));
      // Nothing more will arrive, so there is nothing left to keep this socket
      // for -- a client left open would sit there looking connected.
      if (event.type === 'ended') {
        peer.send(JSON.stringify({ type: 'closed' }));
        peer.close();
      }
    });

    peer.send(
      JSON.stringify({
        type: 'hello',
        sessionId: entry.view.sessionId,
        seq: entry.view.seq,
        cols: entry.view.size.cols,
        rows: entry.view.size.rows,
        modes: entry.view.modes,
        screen: entry.view.snapshot(),
        followResize: entry.followResize,
      }),
    );

    socket.on('close', () => {
      detach();
      entry.peers.delete(peer);
    });
  }

  private onMessage(entry: Entry, peer: Peer, text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const body = message as { kind?: unknown };
    try {
      if (body.kind === 'keys') {
        const steps = (message as { steps?: unknown }).steps;
        if (!Array.isArray(steps)) return;
        // Composed against the mode the program set -- the same call
        // `send_sequence` makes, so a human's arrow key is the bytes the
        // program asked for.
        entry.view.send(steps as readonly Step[]);
      } else if (body.kind === 'raw') {
        const data = (message as { data?: unknown }).data;
        if (typeof data !== 'string' || data === '') return;
        entry.view.sendRaw(Buffer.from(data, 'base64').toString('utf8'));
      } else if (body.kind === 'size') {
        if (!entry.followResize) return;
        const cols = (message as { cols?: unknown }).cols;
        const rows = (message as { rows?: unknown }).rows;
        if (typeof cols === 'number' && typeof rows === 'number' && cols >= 1 && rows >= 1) {
          entry.view.resize(Math.floor(cols), Math.floor(rows));
        }
      }
    } catch {
      // A caller's mistake -- a step that will not compose, a size that is not
      // a grid. It goes back to the client that made it and no further: a
      // human typing must not be able to end the server, and an error that is
      // not theirs must never be dressed up as one.
      peer.send(
        JSON.stringify({ type: 'error', code: 'bad_input', message: 'that input could not be sent' }),
      );
    }
  }
}

/** The absolute path of the terminal client, next to this module's package. */
function scriptPath(): string {
  const url = new URL('../scripts/view.ts', import.meta.url);
  // A file URL on Windows is `/E:/…`; the leading slash is not part of a path.
  return decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, '$1');
}

/**
 * Speak WebSocket over an upgraded socket.
 *
 * Returns what the caller needs to push text at the peer. Frames are decoded
 * as they arrive and reassembled across continuation frames, because
 * fragmentation is part of the protocol even though the clients here do not
 * use it -- a peer that did would otherwise be silently half-read.
 */
function acceptWebSocket(
  socket: Duplex,
  head: Buffer,
  onMessage: (text: string) => void,
): Peer {
  let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let closed = false;
  const fragments: Buffer[] = [];
  let fragmentOpcode = 0;

  // The upgraded socket is a `net.Socket` at runtime; `node:http` types it as
  // a bare `Duplex`, and Nagle's algorithm is not what a keystroke wants.
  const asSocket = socket as unknown as { setNoDelay?: (value: boolean) => void };
  asSocket.setNoDelay?.(true);

  const write = (opcode: number, payload: Buffer): void => {
    if (closed) return;
    socket.write(frame(opcode, payload));
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      socket.write(frame(0x8, Buffer.alloc(0)));
    } catch {
      // Gone already; ending is all that is left.
    }
    socket.destroy();
  };

  const deliver = (opcode: number, payload: Buffer): void => {
    if (opcode === 0x1 || opcode === 0x2) onMessage(payload.toString('utf8'));
  };

  socket.on('data', (chunk: Buffer) => {
    const bytes = Buffer.from(chunk);
    buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let at = 2;

      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) {
          close();
          return;
        }
        length = Number(big);
        at = 10;
      }

      let mask: Buffer | null = null;
      if (masked) {
        if (buffer.length < at + 4) return;
        mask = Buffer.from(buffer.subarray(at, at + 4));
        at += 4;
      }
      if (buffer.length < at + length) return;

      const payload = Buffer.from(buffer.subarray(at, at + length));
      buffer = Buffer.from(buffer.subarray(at + length));
      // Clients must mask; the mask is XORed off before anything reads it.
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      }

      if (opcode === 0x8) {
        close();
        return;
      }
      if (opcode === 0x9) {
        write(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments.splice(0));
          deliver(fragmentOpcode, whole);
        }
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x2) {
        close();
        return;
      }
      if (fin) {
        deliver(opcode, payload);
      } else {
        fragmentOpcode = opcode;
        fragments.push(payload);
      }
      if (closed) return;
    }
  });

  socket.on('error', () => close());

  return {
    send(text: string): void {
      write(0x1, Buffer.from(text, 'utf8'));
    },
    close,
  };
}

/** One frame, server to client, never masked. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
