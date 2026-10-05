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

type Route = { status: number; body: unknown };

/** Answers by "METHOD path"; anything unrouted is a 404, so a stray call shows up as a failure. */
function routingFetch(routes: Record<string, Route>): { fetchImpl: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = routes[`${method} ${new URL(url).pathname}`] ?? { status: 404, body: { message: 'no route' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const DEVICE_START = {
  status: 200,
  body: { deviceCode: 'dev', userCode: 'ABCD-EFGH', verificationUri: '/wallet/authorize?code=ABCD-EFGH', expiresIn: 600, interval: 1 },
};
const GRANTED = {
  status: 200,
  body: { status: 'granted', token: 'new', sessionId: 'ses_2', expiresAt: '2100-01-01T00:00:00.000Z' },
};

function forcedSession(path: string, fetchImpl: typeof globalThis.fetch): CancoreSession {
  return new CancoreSession(
    { apiBaseUrl: API, appBaseUrl: APP, appName: 'Claude', grantPath: path },
    { fetchImpl, sleep: async () => {} },
  );
}

// CAN-2087: reconnecting with force used to overwrite the file and leave the
// old grant alive on the server for up to 30 days.
test('a forced reconnect revokes the grant it replaces, with that grant, once the new one is stored', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'old', scopes: ['agent:propose'], appName: 'Claude' });
  const { fetchImpl, calls } = routingFetch({
    'POST /auth/device/authorize': DEVICE_START,
    'POST /auth/device/token': GRANTED,
    'DELETE /auth/sessions/current': { status: 200, body: { revoked: true } },
  });

  const result = await forcedSession(path, fetchImpl).connectWallet({ force: true });

  expect(result.status).toBe('granted');
  expect(result.warning).toBeUndefined();
  const revoke = calls.find((c) => c.method === 'DELETE');
  expect(revoke?.url).toBe(`${API}/auth/sessions/current`);
  expect(revoke?.headers.authorization).toBe('Bearer old');
  expect(calls[calls.length - 1]?.method).toBe('DELETE');
  expect(loadGrant(path, API)).toMatchObject({ token: 'new', sessionId: 'ses_2', expiresAt: 4_102_444_800 });
});

test('an old grant the server already refuses is simply replaced', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'old', scopes: [], appName: 'Claude' });
  const { fetchImpl } = routingFetch({
    'POST /auth/device/authorize': DEVICE_START,
    'POST /auth/device/token': GRANTED,
    'DELETE /auth/sessions/current': { status: 401, body: { message: 'revoked' } },
  });

  const result = await forcedSession(path, fetchImpl).connectWallet({ force: true });

  expect(result.status).toBe('granted');
  expect(result.warning).toBeUndefined();
  expect(loadGrant(path, API)?.token).toBe('new');
});

// The owner asked for a new grant; failing to end the old one must not take the
// new one away — it must be said, so the owner can end it in the wallet.
test('a revoke that fails still reconnects and says the old grant may be alive', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'old', scopes: [], appName: 'Claude' });
  const { fetchImpl } = routingFetch({
    'POST /auth/device/authorize': DEVICE_START,
    'POST /auth/device/token': GRANTED,
    'DELETE /auth/sessions/current': { status: 500, body: { message: 'boom' } },
  });

  const result = await forcedSession(path, fetchImpl).connectWallet({ force: true });

  expect(result.status).toBe('granted');
  expect(String(result.warning)).toMatch(/revoke it in the wallet/);
  expect(loadGrant(path, API)?.token).toBe('new');
});
