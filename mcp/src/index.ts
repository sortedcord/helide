#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

// stdout belongs exclusively to MCP. Exiting only drops the CDP socket; it must
// never call browser.close(), which could terminate the user's browser.
const server = createServer();
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
