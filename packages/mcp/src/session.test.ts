import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGrant, saveGrant } from './grant';
import { CancoreSession } from './session';

const API = 'https://api-dev.cancore.app';
const APP = 'https://app-dev.cancore.app';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cancore-mcp-')), 'grants.json');
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recordingFetch(reply: { status: number; body: unknown }): { fetchImpl: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function session(grantPath: string, fetchImpl: typeof globalThis.fetch): CancoreSession {
  return new CancoreSession({ apiBaseUrl: API, appBaseUrl: APP, appName: 'Claude', grantPath }, { fetchImpl });
}

test('with no grant, nothing is sent and the answer says how to get one', async () => {
  const { fetchImpl, calls } = recordingFetch({ status: 200, body: {} });

  const result = await session(tempPath(), fetchImpl).proposeAutotrade({
    sourceTokenName: 'CC',
    targetTokenName: 'CBTC',
    sourceAmount: '5',
  });

  expect(result.error).toMatch(/cancore_connect_wallet/);
  expect(calls).toHaveLength(0);
});

test('an auto-trade goes out as a kind envelope, with the grant as a bearer token', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'tok', scopes: ['agent:propose'], appName: 'Claude' });
  const { fetchImpl, calls } = recordingFetch({ status: 200, body: { id: 'int_1', status: 'pending' } });

  const result = await session(path, fetchImpl).proposeAutotrade(
    { sourceTokenName: 'CC', targetTokenName: 'CBTC', sourceAmount: '5' },
    'Claude',
  );

  expect(result.intentId).toBe('int_1');
  expect(calls[0]?.url).toBe(`${API}/agent/intents`);
  expect(calls[0]?.headers.authorization).toBe('Bearer tok');
  expect(calls[0]?.body).toEqual({
    kind: 'autotrade',
    params: { sourceTokenName: 'CC', targetTokenName: 'CBTC', sourceAmount: '5' },
    agentLabel: 'Claude',
  });
});

// The transfer stays flat while the other kinds are enveloped: a stand running
// a backend from before the queue carried kinds would reject the envelope.
test('a transfer stays flat, and empty optional fields are left out', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'tok', scopes: [], appName: 'Claude' });
  const { fetchImpl, calls } = recordingFetch({ status: 200, body: { id: 'int_2', status: 'pending' } });

  await session(path, fetchImpl).proposeTransfer({ receiverPartyId: 'alice::ns', amount: '1.5' });

  expect(calls[0]?.body).toEqual({ receiverPartyId: 'alice::ns', amount: '1.5' });
});

test('a refused grant is dropped, so the next call asks for a new one', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'stale', scopes: [], appName: 'Claude' });
  const { fetchImpl } = recordingFetch({ status: 401, body: { message: 'expired' } });

  const result = await session(path, fetchImpl).listIntents();

  expect(result.error).toMatch(/cancore_connect_wallet/);
  expect(loadGrant(path, API)).toBeUndefined();
});

// A live grant that lacks a scope is not a broken grant. Dropping it would make
// the owner re-approve for something they already approved.
test('a scope refusal keeps the grant', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'tok', scopes: ['agent:read'], appName: 'Claude' });
  const { fetchImpl } = recordingFetch({ status: 403, body: { message: 'scope agent:propose required' } });

  const result = await session(path, fetchImpl).proposeAutotrade({
    sourceTokenName: 'CC',
    targetTokenName: 'CBTC',
    sourceAmount: '5',
  });

  expect(result.error).toMatch(/not approved for that/);
  expect(loadGrant(path, API)?.token).toBe('tok');
});

test('connecting when this stand is already authorized asks the owner nothing', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'tok', scopes: ['agent:propose'], appName: 'Claude' });
  const { fetchImpl, calls } = recordingFetch({ status: 200, body: {} });

  const result = await session(path, fetchImpl).connectWallet();

  expect(result.status).toBe('granted');
  expect(calls).toHaveLength(0);
});

test('the approved token is never handed back to the caller', async () => {
  const path = tempPath();
  const { fetchImpl } = recordingFetch({ status: 200, body: { status: 'granted', token: 'secret-token' } });
  const started = new CancoreSession(
    { apiBaseUrl: API, appBaseUrl: APP, appName: 'Claude', grantPath: path },
    {
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (String(url).endsWith('/auth/device/authorize')) {
          return new Response(JSON.stringify({ deviceCode: 'dc', userCode: 'ABCD', verificationUri: '/a', expiresIn: 600, interval: 1 }));
        }
        return fetchImpl(url as never, init as never);
      }) as unknown as typeof globalThis.fetch,
    },
  );

  const result = await started.connectWallet({ waitSeconds: 5 });

  expect(result.status).toBe('granted');
  expect(JSON.stringify(result)).not.toContain('secret-token');
  expect(loadGrant(path, API)?.token).toBe('secret-token');
});
