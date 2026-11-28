import { mkdtempSync, readFileSync } from 'node:fs';
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

test('balances are read from the credential, never from an argument (CAN-2259)', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'tok', scopes: ['balances:read'], appName: 'Claude' });
  const rows = [{ instrumentId: 'CC', balance: 1, locked: 0, total: 1, inSwaps: 0 }];
  const { fetchImpl, calls } = recordingFetch({ status: 200, body: rows });

  const result = await session(path, fetchImpl).getBalances();

  expect(calls[0]?.method).toBe('GET');
  expect(calls[0]?.url).toBe(`${API}/tokens/balances`);
  expect(calls[0]?.headers.authorization).toBe('Bearer tok');
  expect(result).toEqual({ balances: rows, count: 1 });
});

// A grant approved before balances:read existed: the refusal must say how to
// get the scope, since a plain connect answers "already authorized".
test('a scope refusal says to reconnect with force', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'tok', scopes: ['agent:read'], appName: 'Claude' });
  const { fetchImpl } = recordingFetch({ status: 403, body: { message: 'scope balances:read required' } });

  const result = await session(path, fetchImpl).getBalances();

  expect(result.error).toMatch(/cancore_connect_wallet with force/);
  expect(loadGrant(path, API)?.token).toBe('tok');
});

// Same rule as mcp-server: only a refusal that names a scope is fixed by
// re-approving; a surface switched off on the stand is not.
test('a 403 that is not about a scope does not send the agent to reconnect', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'tok', scopes: ['balances:read'], appName: 'Claude' });
  const { fetchImpl } = recordingFetch({ status: 403, body: { message: 'agent surface is disabled' } });

  const result = await session(path, fetchImpl).getBalances();

  expect(result.error).toMatch(/not approved for that/);
  expect(result.error).not.toMatch(/force/);
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

test('BUG-1634 clears server-expired consent and opens a fresh request on retry', async () => {
  const { fetchImpl, calls } = routingFetch({
    'POST /auth/device/authorize': DEVICE_START,
    'POST /auth/device/token': { status: 404, body: {} },
  });
  const openBrowser = jest.fn(async () => true);
  const started = new CancoreSession(
    { apiBaseUrl: API, appBaseUrl: APP, appName: 'Claude', grantPath: tempPath() },
    { fetchImpl, openBrowser, now: () => 0 },
  );

  await expect(started.connectWallet()).resolves.toMatchObject({ status: 'expired' });
  await expect(started.connectWallet()).resolves.toMatchObject({ status: 'expired' });

  expect(calls.filter((call) => call.url.endsWith('/authorize'))).toHaveLength(2);
  expect(openBrowser).toHaveBeenCalledTimes(2);
});

test.each(['authorization', 'poll'] as const)('BUG-1634 force supersedes an in-flight %s', async (phase) => {
  const path = tempPath();
  let releaseOld!: () => void;
  let releaseNew!: () => void;
  let markOldWaiting!: () => void;
  let markNewWaiting!: () => void;
  const oldWaiting = new Promise<void>((resolve) => { markOldWaiting = resolve; });
  const newWaiting = new Promise<void>((resolve) => { markNewWaiting = resolve; });
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
  let authorizations = 0;
  const polls: string[] = [];
  const revoked: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (init?.method === 'DELETE') {
      revoked.push(new Headers(init.headers).get('authorization') ?? '');
      return Response.json({ revoked: true });
    }
    if (String(url).endsWith('/authorize')) {
      const deviceCode = ++authorizations === 1 ? 'old' : 'new';
      if (deviceCode === 'old' && phase === 'authorization') {
        markOldWaiting();
        await oldGate;
      }
      return Response.json({ ...DEVICE_START.body, deviceCode });
    }

    const { deviceCode } = JSON.parse(String(init?.body));
    polls.push(deviceCode);
    if (deviceCode === 'old') {
      markOldWaiting();
      await oldGate;
      return Response.json({ ...GRANTED.body, token: 'superseded-token' });
    }
    markNewWaiting();
    await newGate;
    return Response.json(GRANTED.body);
  };
  const started = forcedSession(path, fetchImpl);
  const oldRequest = started.connectWallet();
  await oldWaiting;
  const newRequest = started.connectWallet({ force: true });
  await newWaiting;
  releaseOld();

  await expect(oldRequest).resolves.toMatchObject({ status: 'superseded' });
  expect(loadGrant(path, API)).toBeUndefined();
  expect(revoked).toEqual(phase === 'poll' ? ['Bearer superseded-token'] : []);
  expect(started.connectWallet()).toBe(newRequest);

  releaseNew();
  await expect(newRequest).resolves.toMatchObject({ status: 'granted' });
  expect(polls).toEqual(phase === 'authorization' ? ['new'] : ['old', 'new']);
  expect(revoked).toHaveLength(phase === 'poll' ? 1 : 0);
});

// RX-1 (sdk#313 audit r2): a superseded poll that collected a token must say so when ending it fails.
test('BUG-1634 a superseded poll whose token cannot be revoked says the session may be alive', async () => {
  const path = tempPath();
  let releaseOld!: () => void;
  let markOldWaiting!: () => void;
  let markNewWaiting!: () => void;
  const oldWaiting = new Promise<void>((resolve) => { markOldWaiting = resolve; });
  const newWaiting = new Promise<void>((resolve) => { markNewWaiting = resolve; });
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  let authorizations = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (init?.method === 'DELETE') return Response.json({ message: 'boom' }, { status: 500 });
    if (String(url).endsWith('/authorize')) {
      return Response.json({ ...DEVICE_START.body, deviceCode: ++authorizations === 1 ? 'old' : 'new' });
    }
    const { deviceCode } = JSON.parse(String(init?.body));
    if (deviceCode === 'old') {
      markOldWaiting();
      await oldGate;
      return Response.json({ ...GRANTED.body, token: 'superseded-token' });
    }
    markNewWaiting();
    return new Promise<Response>(() => {});
  };
  const started = forcedSession(path, fetchImpl);
  const oldRequest = started.connectWallet();
  await oldWaiting;
  void started.connectWallet({ force: true });
  await newWaiting;
  releaseOld();

  const result = await oldRequest;
  expect(result.status).toBe('superseded');
  expect(String(result.warning)).toMatch(/revoke it in the wallet/);
  expect(loadGrant(path, API)).toBeUndefined();
});


function clockedSession(path: string, fetchImpl: typeof globalThis.fetch, openBrowser = jest.fn(async () => true)): CancoreSession {
  let clock = 0;
  return new CancoreSession(
    { apiBaseUrl: API, appBaseUrl: APP, appName: 'Claude', grantPath: path },
    { fetchImpl, openBrowser, now: () => clock, sleep: async (ms: number) => { clock += ms; } },
  );
}

test('BUG-1634 an ordinary call resumes a forced reconnect that answered pending while the old grant is stored', async () => {
  const path = tempPath();
  saveGrant(path, API, { token: 'old', scopes: ['agent:read'], appName: 'Claude' });
  let approved = false;
  const { fetchImpl, calls } = routingFetch({
    'POST /auth/device/authorize': DEVICE_START,
    'DELETE /auth/sessions/current': { status: 200, body: { revoked: true } },
  });
  const routed: typeof fetch = async (url, init) => String(url).endsWith('/auth/device/token')
    ? Response.json(approved ? GRANTED.body : { status: 'pending' })
    : fetchImpl(url, init);
  const openBrowser = jest.fn(async () => true);
  const started = clockedSession(path, routed, openBrowser);

  await expect(started.connectWallet({ force: true, waitSeconds: 5 })).resolves.toMatchObject({ status: 'pending', opened: true });
  approved = true;
  await expect(started.connectWallet({ waitSeconds: 5 })).resolves.toMatchObject({ status: 'granted' });

  expect(calls.filter((call) => call.url.endsWith('/authorize'))).toHaveLength(1);
  expect(openBrowser).toHaveBeenCalledTimes(1);
  expect(loadGrant(path, API)?.token).toBe('new');
  expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.headers.authorization)).toEqual(['Bearer old']);
});

test('BUG-1634 a forced reconnect that fails to authorize drops the old pending code', async () => {
  let authorizations = 0;
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url).endsWith('/authorize')) {
      return ++authorizations === 2 ? new Response('busy', { status: 503 }) : Response.json(DEVICE_START.body);
    }
    return Response.json({ status: 'pending' });
  };
  const openBrowser = jest.fn(async () => true);
  const started = clockedSession(tempPath(), fetchImpl, openBrowser);

  await expect(started.connectWallet({ waitSeconds: 5 })).resolves.toMatchObject({ status: 'pending' });
  await expect(started.connectWallet({ waitSeconds: 5, force: true })).rejects.toThrow(/503/);
  await expect(started.connectWallet({ waitSeconds: 5 })).resolves.toMatchObject({ status: 'pending', resumed: false, opened: true });

  expect(authorizations).toBe(3);
  expect(openBrowser).toHaveBeenCalledTimes(2);
});

test('BUG-1634 a call superseded while the browser opens never polls its code', async () => {
  const path = tempPath();
  let releaseBrowser!: () => void;
  let markOpening!: () => void;
  const browserGate = new Promise<void>((resolve) => { releaseBrowser = resolve; });
  const opening = new Promise<void>((resolve) => { markOpening = resolve; });
  let authorizations = 0;
  const polls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/authorize')) return Response.json({ ...DEVICE_START.body, deviceCode: ++authorizations === 1 ? 'old' : 'new' });
    const { deviceCode } = JSON.parse(String(init?.body));
    polls.push(deviceCode);
    return Response.json({ ...GRANTED.body, token: deviceCode + '-token' });
  };
  const openBrowser = jest.fn(async () => {
    if (openBrowser.mock.calls.length === 1) {
      markOpening();
      await browserGate;
    }
    return true;
  });
  const started = new CancoreSession(
    { apiBaseUrl: API, appBaseUrl: APP, appName: 'Claude', grantPath: path },
    { fetchImpl, openBrowser, sleep: async () => {} },
  );

  const oldRequest = started.connectWallet();
  await opening;
  await expect(started.connectWallet({ force: true })).resolves.toMatchObject({ status: 'granted' });
  releaseBrowser();

  await expect(oldRequest).resolves.toMatchObject({ status: 'superseded' });
  expect(polls).toEqual(['new']);
  expect(loadGrant(path, API)?.token).toBe('new-token');
});

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

// CAN-2628, the MCP Agent column of the sdk audit's authorization matrix. The agent holds no key:
// every money operation is a request the owner signs in the wallet. So the column comes down to two
// rules, held for every tool the contract announces (connect_wallet is how a grant is obtained):
// with no grant nothing reaches the API, and with one each call sends one request to the stand, the
// grant as its bearer.
describe('every agent tool (CAN-2628)', () => {
  const ORDER = { sourceNetwork: 'canton', sourceTokenAddress: 'CC', sourceAmount: '5', targetNetwork: 'base', targetTokenAddress: '0x1', targetAmount: '1' };
  const tools: Record<string, (s: CancoreSession) => Promise<Record<string, unknown>>> = {
    cancore_propose_autotrade: (s) => s.proposeAutotrade({ sourceTokenName: 'CC', targetTokenName: 'CBTC', sourceAmount: '5' }),
    cancore_propose_order: (s) => s.proposeOrder(ORDER),
    cancore_propose_transfer: (s) => s.proposeTransfer({ receiverPartyId: 'alice::ns', amount: '1.5' }),
    cancore_intent_status: (s) => s.intentStatus('int_1'),
    cancore_list_intents: (s) => s.listIntents(),
    cancore_get_balances: (s) => s.getBalances(),
  };

  test('the list is the whole contract but connect_wallet', () => {
    const contract = JSON.parse(readFileSync(join(__dirname, '..', 'contract', 'agent-tools.contract.json'), 'utf8')) as { name: string }[];
    expect([...Object.keys(tools), 'cancore_connect_wallet'].sort()).toEqual(contract.map((t) => t.name).sort());
  });

  test.each(Object.entries(tools))('%s with no grant sends nothing and says how to get one', async (_tool, run) => {
    const { fetchImpl, calls } = recordingFetch({ status: 200, body: {} });

    const result = await run(session(tempPath(), fetchImpl));

    expect(result.error).toMatch(/cancore_connect_wallet/);
    expect(calls).toHaveLength(0);
  });

  test.each(Object.entries(tools))('%s with a grant sends one request, the grant as its bearer', async (_tool, run) => {
    const path = tempPath();
    saveGrant(path, API, { token: 'tok', scopes: ['agent:propose'], appName: 'Claude' });
    const { fetchImpl, calls } = recordingFetch({ status: 200, body: { id: 'int_1', status: 'pending' } });

    await run(session(path, fetchImpl));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.startsWith(`${API}/`)).toBe(true);
    expect(calls[0]?.headers.authorization).toBe('Bearer tok');
  });
});

// BUG-1618: the consent link comes from the gateway. A link off the wallet's origin would send the
// owner to a look-alike page asking for the same approval.
describe('the consent link (BUG-1618)', () => {
  function connect(verificationUri: string, appBaseUrl = APP) {
    const opened: string[] = [];
    const { fetchImpl, calls } = routingFetch({
      'POST /auth/device/authorize': { status: 200, body: { ...DEVICE_START.body, verificationUri } },
      'POST /auth/device/token': { status: 200, body: { status: 'pending' } },
    });
    let clock = 0;
    const started = new CancoreSession(
      { apiBaseUrl: API, appBaseUrl, appName: 'Claude', grantPath: tempPath() },
      {
        fetchImpl,
        openBrowser: async (url) => (opened.push(url), true),
        sleep: async (ms) => void (clock += ms),
        now: () => clock,
      },
    );
    return { started, result: started.connectWallet({ waitSeconds: 5 }), opened, calls };
  }

  test('BUG-1634 resumes without reopening and force starts a new request', async () => {
    const { started, result, opened } = connect('/wallet/authorize');
    expect(started.connectWallet({ waitSeconds: 1 })).toBe(result);
    await result;
    const first = started.connectWallet({ waitSeconds: 1 });
    expect(started.connectWallet({ waitSeconds: 1 })).toBe(first);
    await first;
    expect(await started.connectWallet({ waitSeconds: 1 })).toMatchObject({ resumed: true, opened: false });
    expect(await started.connectWallet({ waitSeconds: 1, force: true })).toMatchObject({ resumed: false, opened: true });
    expect(opened).toHaveLength(2);
  });

  test('the path the gateway sends opens on the wallet origin', async () => {
    const { result, opened } = connect('/wallet/authorize?code=ABCD-EFGH');

    expect((await result).page).toBe(`${APP}/wallet/authorize?code=ABCD-EFGH`);
    expect(opened).toEqual([`${APP}/wallet/authorize?code=ABCD-EFGH`]);
  });

  test('a trailing slash on the wallet URL does not double the slash or refuse the link', async () => {
    const { result } = connect('/wallet/authorize?code=ABCD-EFGH', `${APP}/`);

    expect((await result).page).toBe(`${APP}/wallet/authorize?code=ABCD-EFGH`);
  });

  // Without the wallet's origin there is nothing to check the gateway's link against.
  test('with no wallet URL nothing is started, shown or opened', async () => {
    const { result, opened, calls } = connect('https://evil.example/wallet/authorize', '');

    const out = await result;

    expect(out.error).toMatch(/CANCORE_APP_URL is not set/);
    expect(out).not.toHaveProperty('page');
    expect(opened).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a link without a leading slash stays a path on the wallet origin', async () => {
    const { result, opened } = connect('@evil.example/connect');

    await result;

    expect(opened.map((url) => new URL(url).origin)).toEqual([APP]);
  });

  test.each([
    ['user info in front of a foreign host', 'https://app-dev.cancore.app@evil.example/wallet/authorize'],
    ['a foreign origin', 'https://evil.example/wallet/authorize'],
    ['a protocol-relative host', '//evil.example/wallet/authorize'],
    ['a user name on the wallet host', 'https://owner@app-dev.cancore.app/wallet/authorize'],
    ['a password on the wallet host', 'https://:secret@app-dev.cancore.app/wallet/authorize'],
  ])('%s is refused: not opened, not shown, not polled', async (_case, verificationUri) => {
    const { result, opened, calls } = connect(verificationUri);

    const out = await result;

    expect(out.error).toMatch(/is not on https:\/\/app-dev\.cancore\.app/);
    expect(out).not.toHaveProperty('page');
    expect(opened).toEqual([]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/auth/device/authorize']);
  });

  test('a refused link is forgotten, so a retry starts a new request', async () => {
    const { started, result, calls } = connect('https://evil.example/wallet/authorize');
    await result;

    await started.connectWallet({ waitSeconds: 5 });

    expect(calls.filter((c) => c.url.endsWith('/auth/device/authorize'))).toHaveLength(2);
  });

  test('a CANCORE_APP_URL that is not a URL refuses instead of opening a guess', async () => {
    const { result, opened } = connect('/wallet/authorize?code=ABCD-EFGH', 'app-dev.cancore.app');

    expect((await result).error).toMatch(/is not on app-dev\.cancore\.app/);
    expect(opened).toEqual([]);
  });
});
