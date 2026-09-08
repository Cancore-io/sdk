import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { projectTools, type ContractTool } from './contract';
import { createServer } from './server';
import { CancoreSession } from './session';

const CONTRACT_PATH = join(__dirname, '..', 'contract', 'agent-tools.contract.json');

/**
 * What this server actually announces, read the way a client reads it — over
 * the protocol, not by importing the registration table.
 */
async function announcedTools(): Promise<ContractTool[]> {
  const session = new CancoreSession({
    apiBaseUrl: 'https://api.example',
    appBaseUrl: 'https://app.example',
    appName: 'contract',
    grantPath: join(mkdtempSync(join(tmpdir(), 'cancore-mcp-')), 'grants.json'),
  });
  const server = createServer(session, '0.0.0-test');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'contract-test', version: '0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return projectTools(tools);
}

// `UPDATE_CONTRACT=1 npx jest contract` rewrites the file from the running
// server. Doing that IS a contract change: the Go server's copy has to follow.
test('the announced agent tools equal the written contract', async () => {
  const announced = await announcedTools();
  if (process.env.UPDATE_CONTRACT) {
    writeFileSync(CONTRACT_PATH, `${JSON.stringify(announced, null, 2)}\n`);
  }
  const written = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as ContractTool[];
  expect(announced).toEqual(written);
});

test('the contract is the whole agent surface, not a sample of it', async () => {
  const announced = await announcedTools();
  expect(announced.map((t) => t.name)).toEqual([
    'cancore_connect_wallet',
    'cancore_intent_status',
    'cancore_list_intents',
    'cancore_propose_autotrade',
    'cancore_propose_order',
    'cancore_propose_transfer',
  ]);
});
