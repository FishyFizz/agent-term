/**
 * Run the MCP server over stdio.
 *
 * The only entry point so far, and deliberately thin: everything it does is in
 * `src/mcp.ts`, so the same surface can be driven in-process by a test.
 *
 *   npx tsx scripts/mcp-stdio.ts
 *
 * One `ViewServer` for the process, constructed here rather than inside
 * `createServer`. The reason is the one `src/mcp.ts` gives: the HTTP entry
 * point builds a server per request, so a view server built there would be a
 * different one each time, each with its own port and none of them the one a
 * human is connected to. It is the same argument that puts the `SessionHost`
 * here -- sessions and views both outlive a request, so the process owns them.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/mcp.js';
import { SessionHost } from '../src/host.js';
import { ViewServer } from '../src/view-server.js';

const views = new ViewServer();
const server = createServer(new SessionHost(), views);
await server.connect(new StdioServerTransport());
