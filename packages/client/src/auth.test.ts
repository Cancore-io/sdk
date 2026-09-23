import { GrantDeniedError, GrantExpiredError, requestGrant, type RequestGrantOptions } from './auth';
import { CancoreApiError } from './http';

const PAIR = '0b7c3f1e-4a2d-4c8e-9f10-2a6b5d3e7c91';
const LIMITS = { maxOrderUsd: 250, windowUsd: 1000, windowSeconds: 86400 };
const START = { deviceCode: 'dc_secret', userCode: 'ABCDEFGH', verificationUri: '/wallet/authorize?code=ABCDEFGH', expiresIn: 600, interval: 5 };

/** The device routes, scripted: the authorize answer, then one reply per poll (the last one repeats). */
function fakeApi(polls: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  let i = 0;
  const request = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(String(init.body)) });
    const reply = path === '/auth/device/authorize' ? { body: START } : (polls[Math.min(i++, polls.length - 1)] ?? { body: {} });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  const options = (extra: Partial<RequestGrantOptions> = {}): RequestGrantOptions => ({
    baseUrl: 'https://api.example',
    appName: 'Rebalancer',
    scopes: ['orders:write', 'orders:read'],
    limits: LIMITS,
    request,
    ...extra,
  });
  return { calls, slept, sleep, options };
}

const pending = { body: { status: 'pending' } };

test('starts the flow with the API field names and keeps the device code to itself', async () => {
  const api = fakeApi([pending]);
  const grant = await requestGrant(api.options({ appUrl: 'https://wallet.example/' }));

  expect(api.calls).toEqual([
    { path: '/auth/device/authorize', body: { appName: 'Rebalancer', scopes: ['orders:write', 'orders:read'], limits: LIMITS } },
  ]);
  expect(grant.userCode).toBe('ABCDEFGH');
  expect(grant.verificationUri).toBe('https://wallet.example/wallet/authorize?code=ABCDEFGH');
  expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now() + 590_000);
  expect(JSON.stringify(grant)).not.toContain('dc_secret');
});

test('without appUrl the consent page is the path the API returned, and a read-only grant sends no limits', async () => {
  const api = fakeApi([pending]);
  const grant = await requestGrant(api.options({ scopes: ['orders:read'], limits: undefined }));
  expect(grant.verificationUri).toBe('/wallet/authorize?code=ABCDEFGH');
  expect(api.calls[0]?.body).toEqual({ appName: 'Rebalancer', scopes: ['orders:read'] });
});

test('approve: polls at the API interval and resolves to the token', async () => {
  const api = fakeApi([pending, pending, { body: { status: 'granted', token: 'cs_token' } }]);
  const grant = await requestGrant(api.options());

  await expect(grant.wait({ sleep: api.sleep })).resolves.toBe('cs_token');
  expect(api.slept).toEqual([5000, 5000]);
  expect(api.calls.slice(1).map((c) => c.body)).toEqual(Array(3).fill({ deviceCode: 'dc_secret' }));
});

test('deny: rejects with GrantDeniedError', async () => {
  const api = fakeApi([pending, { body: { status: 'denied' } }]);
  const grant = await requestGrant(api.options());
  await expect(grant.wait({ sleep: api.sleep })).rejects.toBeInstanceOf(GrantDeniedError);
});

test('expire: the 404 for an unknown or expired code rejects with GrantExpiredError', async () => {
  const api = fakeApi([pending, { status: 404, body: { statusCode: 404, message: 'Unknown or expired device code' } }]);
  const grant = await requestGrant(api.options());
  await expect(grant.wait({ sleep: api.sleep })).rejects.toBeInstanceOf(GrantExpiredError);
});

test('slow down: a 429 adds five seconds to the interval for good, and honours a longer retryAfter', async () => {
  const tooMany = (retryAfter?: number) => ({ status: 429, body: { statusCode: 429, message: 'Rate limit exceeded', retryAfter } });
  const api = fakeApi([tooMany(), pending, tooMany(60), pending, { body: { status: 'granted', token: 'cs_token' } }]);
  const grant = await requestGrant(api.options());

  await expect(grant.wait({ sleep: api.sleep })).resolves.toBe('cs_token');
  expect(api.slept).toEqual([10_000, 10_000, 60_000, 15_000]);
});

test('abort: rejects with the signal reason, and stops polling', async () => {
  const api = fakeApi([pending]);
  const grant = await requestGrant(api.options());
  const controller = new AbortController();
  const reason = new Error('budget spent');

  const waiting = grant.wait({ signal: controller.signal, sleep: () => new Promise(() => {}) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(reason);

  await expect(waiting).rejects.toBe(reason);
  expect(api.calls).toHaveLength(2); // authorize + one poll
  await expect(grant.wait({ signal: controller.signal })).rejects.toBe(reason);
  expect(api.calls).toHaveLength(2);
});

test('abort cuts the default sleep short instead of holding the process for the interval', async () => {
  const api = fakeApi([pending]);
  const grant = await requestGrant(api.options());
  const signal = AbortSignal.timeout(20);
  const started = Date.now();
  await expect(grant.wait({ signal })).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(Date.now() - started).toBeLessThan(1000);
});

test('any other API error surfaces as it is', async () => {
  const api = fakeApi([{ status: 502, body: 'bad gateway' }]);
  const grant = await requestGrant(api.options());
  await expect(grant.wait({ sleep: api.sleep })).rejects.toBeInstanceOf(CancoreApiError);
});

test.each<[string, Partial<RequestGrantOptions>, RegExp]>([
  ['a spending scope without limits', { limits: undefined }, /must declare limits/],
  ['limits without a spending scope', { scopes: ['orders:read'] }, /without a scope that spends/],
  ['a zero per-order cap', { limits: { ...LIMITS, maxOrderUsd: 0 } }, /maxOrderUsd/],
  ['a negative window budget', { limits: { ...LIMITS, windowUsd: -5 } }, /windowUsd must be a number above 0/],
  ['a fractional window', { limits: { ...LIMITS, windowSeconds: 1.5 } }, /windowSeconds/],
  ['a window budget under the per-order cap', { limits: { ...LIMITS, windowUsd: 100 } }, /at least limits.maxOrderUsd/],
  ['an empty pair list', { limits: { ...LIMITS, pairIds: [] } }, /non-empty/],
  ['a pair named by symbol', { limits: { ...LIMITS, pairIds: [PAIR, 'CC/USDCx'] } }, /not: CC\/USDCx/],
  ['a per-order cap above the ceiling', { limits: { ...LIMITS, maxOrderUsd: 100_001, windowUsd: 200_000 } }, /at most 100000/],
  ['a window budget above the ceiling', { limits: { ...LIMITS, windowUsd: 1_000_001 } }, /at most 1000000/],
  ['a window under a minute', { limits: { ...LIMITS, windowSeconds: 59 } }, /between 60 and 2592000/],
  ['a window over thirty days', { limits: { ...LIMITS, windowSeconds: 2_592_001 } }, /between 60 and 2592000/],
  ['more than fifty pairs', { limits: { ...LIMITS, pairIds: Array(51).fill(PAIR) } }, /at most 50 pairs/],
  ['no app name', { appName: '  ' }, /appName/],
])('refuses %s before any request', async (_, extra, message) => {
  const api = fakeApi([pending]);
  await expect(requestGrant(api.options(extra))).rejects.toThrow(message);
  expect(api.calls).toEqual([]);
});

test('a pair allow-list and pool:trade alone pass', async () => {
  const api = fakeApi([pending]);
  await requestGrant(api.options({ scopes: ['pool:trade'], limits: { ...LIMITS, pairIds: [PAIR] } }));
  expect(api.calls).toHaveLength(1);
});
