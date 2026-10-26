import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server';
import { CancoreSession } from './session';

function newSession(): CancoreSession {
  return new CancoreSession({
    apiBaseUrl: 'https://api.example',
    appBaseUrl: 'https://app.example',
    appName: 'server-test',
    grantPath: join(mkdtempSync(join(tmpdir(), 'cancore-mcp-')), 'grants.json'),
  });
}

async function connected(session: CancoreSession) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(session, '0.0.0-test');
  await server.connect(serverSide);
  const client = new Client({ name: 'server-test', version: '0' });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('a tool call reaches the session with its arguments and returns the answer as JSON text', async () => {
  const session = newSession();
  const intentStatus = jest.spyOn(session, 'intentStatus').mockResolvedValue({ intentId: 'i-1', status: 'pending' });
  const { client, close } = await connected(session);
  const result = await client.callTool({ name: 'cancore_intent_status', arguments: { intentId: 'i-1' } });
  expect(intentStatus).toHaveBeenCalledWith('i-1');
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ intentId: 'i-1', status: 'pending' }, null, 2) }]);
  await close();
});

test('a wrong argument type is refused by the SDK before the session runs', async () => {
  const session = newSession();
  const intentStatus = jest.spyOn(session, 'intentStatus');
  const { client, close } = await connected(session);
  const result = await client.callTool({ name: 'cancore_intent_status', arguments: { intentId: 5 } });
  expect(result.isError).toBe(true);
  expect(intentStatus).not.toHaveBeenCalled();
  await close();
});

test('the agent label travels beside the proposal, not inside it', async () => {
  const session = newSession();
  const propose = jest.spyOn(session, 'proposeAutotrade').mockResolvedValue({ intentId: 'i-2' });
  const { client, close } = await connected(session);
  await client.callTool({
    name: 'cancore_propose_autotrade',
    arguments: { sourceTokenName: 'CC', targetTokenName: 'CBTC', sourceAmount: '5', agentLabel: 'bot' },
  });
  expect(propose).toHaveBeenCalledWith({ sourceTokenName: 'CC', targetTokenName: 'CBTC', sourceAmount: '5' }, 'bot');
  await close();
});
