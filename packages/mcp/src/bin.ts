#!/usr/bin/env node
import './install-http1-dispatcher';
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openBrowser } from './browser';
import { createServer } from './server';
import { CancoreSession } from './session';

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const apiBaseUrl = (process.env.CANCORE_API_URL ?? '').replace(/\/+$/, '');
const appBaseUrl = (process.env.CANCORE_APP_URL ?? '').replace(/\/+$/, '');

// stderr, never stdout: stdout is the protocol channel, and one stray line on it
// makes the client drop the connection with a parse error that names nothing.
if (!apiBaseUrl) {
  process.stderr.write('cancore-mcp: CANCORE_API_URL is not set — tools will refuse until it points at a Cancore gateway\n');
}
if (!appBaseUrl) {
  process.stderr.write('cancore-mcp: CANCORE_APP_URL is not set — cancore_connect_wallet will refuse until it points at the Cancore wallet\n');
}

const session = new CancoreSession(
  {
    apiBaseUrl,
    appBaseUrl,
    appName: process.env.CANCORE_APP_NAME || 'Cancore MCP',
    ...(process.env.CANCORE_GRANT_FILE ? { grantPath: process.env.CANCORE_GRANT_FILE } : {}),
  },
  { openBrowser },
);

await createServer(session, version).connect(new StdioServerTransport());
