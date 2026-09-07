import { awaitGrant, startAuthorization, type DeviceStart } from './device';

const API = 'https://api-dev.cancore.app';

function jsonFetch(replies: unknown[]): typeof globalThis.fetch {
  let call = 0;
  return (async () => {
    const body = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const START: DeviceStart = {
  deviceCode: 'dc',
  userCode: 'ABCD-1234',
  verificationUri: '/agent/approve?code=ABCD-1234',
  expiresIn: 600,
  interval: 1,
};

test('an authorization request without codes is not a request', async () => {
  const fetchImpl = jsonFetch([{ userCode: 'ABCD' }]);
  await expect(startAuthorization(fetchImpl, API, 'Claude')).rejects.toThrow(/started no request/);
});

test('a missing poll interval falls back to five seconds', async () => {
  const started = await startAuthorization(jsonFetch([{ deviceCode: 'dc', userCode: 'u', interval: 0 }]), API, 'Claude');
  expect(started.interval).toBe(5);
});

// A budget that runs out is not an error: the request stays live, and the code
// already on the owner's screen has to keep working.
test('an unanswered request comes back pending, not failed', async () => {
  // A clock the sleeps actually move: a frozen `now` against a loop that waits
  // for the deadline is an infinite loop, not a test.
  let clock = 0;
  const sleep = jest.fn(async (ms: number) => {
    clock += ms;
  });

  const outcome = await awaitGrant(jsonFetch([{ status: 'pending' }]), API, START, {
    budgetMs: 3500,
    sleep,
    now: () => clock,
  });

  expect(outcome.status).toBe('pending');
  expect(outcome.token).toBeUndefined();
  // 1s interval inside a 3.5s budget: it polls at 0s, 1s, 2s and 3s, and stops
  // there rather than sleeping past the budget it was given.
  expect(sleep).toHaveBeenCalledTimes(3);
});

test('approval ends the wait and carries the token', async () => {
  const outcome = await awaitGrant(jsonFetch([{ status: 'pending' }, { status: 'granted', token: 'tok' }]), API, START, {
    budgetMs: 60_000,
    sleep: async () => {},
  });

  expect(outcome).toEqual({ status: 'granted', token: 'tok' });
});

test('a refusal ends the wait too', async () => {
  const outcome = await awaitGrant(jsonFetch([{ status: 'denied' }]), API, START, { budgetMs: 60_000, sleep: async () => {} });
  expect(outcome.status).toBe('denied');
});
