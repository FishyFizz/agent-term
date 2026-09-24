/**
 * Run the MCP server over stdio.
 *
 * The only entry point so far, and deliberately thin: everything it does is in
 * `src/mcp.ts`, so the same surface can be driven in-process by a test.
 *
 *   npx tsx scripts/mcp-stdio.ts
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/mcp.js';

const server = createServer();
await server.connect(new StdioServerTransport());
