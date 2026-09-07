#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server';
import { CancoreSession } from './session';

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/**
 * Open the owner's browser at the consent page. Best effort by design: this
 * server also runs headless and over SSH, where there is no browser to ask —
 * the tool prints the URL either way, so a failure here costs a click.
 */
function openBrowser(url: string): Promise<boolean> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
      child.on('error', () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

const apiBaseUrl = (process.env.CANCORE_API_URL ?? '').replace(/\/+$/, '');
const appBaseUrl = (process.env.CANCORE_APP_URL ?? '').replace(/\/+$/, '');

// stderr, never stdout: stdout is the protocol channel, and one stray line on it
// makes the client drop the connection with a parse error that names nothing.
if (!apiBaseUrl) {
  process.stderr.write('cancore-mcp: CANCORE_API_URL is not set — tools will refuse until it points at a Cancore gateway\n');
}
if (!appBaseUrl) {
  process.stderr.write('cancore-mcp: CANCORE_APP_URL is not set — the consent link will be a path, not a URL\n');
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
