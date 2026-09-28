/**
 * Run the MCP server over Streamable HTTP.
 *
 * This exists for one reason: reloading code. A stdio server is spawned by the
 * client and never reconnected, so its process holds the modules it imported
 * for the life of the session. An HTTP server is a *remote* server to Claude
 * Code, and remote servers are reconnected automatically — "up to five
 * attempts, starting at a one-second delay and doubling it each time" for a
 * mid-session drop, and three retries when the first connection is refused.
 *
 * So a restart is the reload mechanism. Run this under `tsx watch` and edit
 * anything: the process restarts, the client reconnects, and no code of ours
 * has to know.
 *
 *   npm run mcp:http        # serve
 *   npm run mcp:dev         # serve, restart on change
 *
 * Stateless, deliberately. Session state lives in the `SessionHost`, which is
 * process-wide, not per-MCP-session — so there is nothing for a session id to
 * carry, and a restart needs no negotiation: the next request simply
 * initialises again. The alternative, stateful mode, would reject a stale
 * session id with a 404 and make the client rediscover that a restart
 * happened. The same rule applies to transport state too — an absence
 * should be an absence, not a number to interpret.
 *
 * Bound to loopback with DNS-rebinding protection. This server runs arbitrary
 * commands for whoever asks; `createMcpExpressApp` defaults to 127.0.0.1 and
 * applies the middleware that stops a web page from reaching it by pointing a
 * hostname at it. Changing that default is a change to the safety posture,
 * not a networking tweak.
 */
import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../src/mcp.js';
import { SessionHost } from '../src/host.js';

const PORT = Number(process.env.AGENT_TERM_PORT ?? 8787);
const HOST = process.env.AGENT_TERM_HOST ?? '127.0.0.1';

// One host for the process, so sessions outlive a request -- and, because a
// restart is how code reloads, sessions do not outlive a reload. That is the
// cost of this loop and it is worth naming: editing `classify.ts` kills the
// terminals you had open.
const host = new SessionHost();
const app = createMcpExpressApp({ host: HOST });

app.post('/mcp', async (req, res) => {
  // A server and transport per request: stateless means nothing is carried
  // between them, and the alternative leaves connections to leak.
  const server = createServer(host);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless servers have no stream to open and no session to delete, so these
// say so rather than 404 and leave a client guessing.
const stateless = (_req: Request, res: Response): void => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'method not allowed: this server is stateless' },
    id: null,
  });
};
app.get('/mcp', stateless);
app.delete('/mcp', stateless);

app.listen(PORT, HOST, () => {
  // stdout is the client's, not ours; a startup line on stderr cannot corrupt
  // a protocol that a stdio transport would be speaking.
  process.stderr.write(`agent-term: listening on http://${HOST}:${PORT}/mcp (pid ${process.pid})\n`);
});
