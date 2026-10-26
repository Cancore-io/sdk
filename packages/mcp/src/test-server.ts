import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server';
import { CancoreSession } from './session';

export function newTestSession(): CancoreSession {
  return new CancoreSession({
    apiBaseUrl: 'https://api.example',
    appBaseUrl: 'https://app.example',
    appName: 'mcp-test',
    grantPath: join(mkdtempSync(join(tmpdir(), 'cancore-mcp-')), 'grants.json'),
  });
}

// The package's own server joined to a client over memory: what a client sees, with no stdio or socket in the way.
export async function connectTestClient(session: CancoreSession = newTestSession()) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(session, '0.0.0-test');
  await server.connect(serverSide);
  const client = new Client({ name: 'mcp-test', version: '0' });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
