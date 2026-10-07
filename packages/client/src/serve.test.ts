import { serve, type ServeEvent } from './serve';
import type { SelfCustodyAccount, Settled, SettleOptions } from './selfcustody';
import type { Order } from './swap';

/**
 * The loop's own rules, against an account whose make / take are scripted: which orders it works on, how
 * many at once, what a failure does to the rest, and what stop() waits for. The DvP steps themselves are
 * the real account's, driven end to end in selfcustody.test.ts.
 */
const order = (id: string, over: Partial<Order> = {}): Order => ({
  id, status: 'accepted', sourceNetwork: 'canton', targetNetwork: 'canton', dvp: true,
  initiatorUserId: 'me', opponentUserId: 'them', swapId: null,
  sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '1', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '1',
  expiresAt: '', createdAt: '', updatedAt: '', ...over,
});

const settledOf = (orderId: string): Settled => ({ swap: { id: `swap-${orderId}`, status: 'dvp_settled' } as Settled['swap'], delivery: 'direct', flow: 'dvp' });

function account(orders: Order[], make: (orderId: string, opts: SettleOptions) => Promise<Settled>) {
  const calls: string[] = [];
  const acct = {
    me: async () => ({ id: 'me' }),
    swap: {
      get: async (id: string) => orders.find((o) => o.id === id)!,
      listMine: async ({ statusFilter }: { statusFilter?: string }) => {
        const items = orders.filter((o) => o.status === statusFilter);
        return { items, page: 1, pageSize: 100, total: items.length };
      },
    },
    listSwaps: async () => [],
    make: (orderId: string, opts: SettleOptions) => (calls.push(orderId), make(orderId, opts)),
    take: (orderId: string, opts: SettleOptions) => (calls.push(orderId), make(orderId, opts)),
  } as unknown as SelfCustodyAccount;
  return { acct, calls };
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('one order that fails does not stop the others, and is tried again on the next poll', async () => {
  let failures = 0;
  const { acct, calls } = account([order('bad'), order('good')], async (id) => {
    if (id === 'bad' && failures++ < 2) throw new Error('venue unavailable');
    return settledOf(id);
  });
  const events: ServeEvent[] = [];
  const handle = serve(acct, { reconcileMs: 5, onEvent: (e) => events.push(e) });
  await until(() => events.filter((e) => e.type === 'settled').length === 2);
  await handle.stop();
  expect(events.filter((e) => e.type === 'error')).toEqual([
    { type: 'error', orderId: 'bad', error: new Error('venue unavailable') },
    { type: 'error', orderId: 'bad', error: new Error('venue unavailable') },
  ]);
  expect(events.filter((e) => e.type === 'settled').map((e) => (e as { orderId: string }).orderId).sort()).toEqual(['bad', 'good']);
  // A settled order is never worked on again, however many polls follow.
  expect(calls.filter((id) => id === 'good')).toEqual(['good']);
});

test('a listener that throws does not stop the loop', async () => {
  const { acct } = account([order('a'), order('b')], async (id) => settledOf(id));
  const seen: string[] = [];
  const handle = serve(acct, {
    reconcileMs: 5,
    onEvent: (e) => {
      if (e.type === 'settled') seen.push(e.orderId);
      throw new Error('listener bug');
    },
  });
  await until(() => seen.length === 2);
  await handle.stop();
});

test('no more than `concurrency` orders at once', async () => {
  let running = 0;
  let peak = 0;
  const { acct } = account(['a', 'b', 'c', 'd', 'e'].map((id) => order(id)), async (id) => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running--;
    return settledOf(id);
  });
  const events: ServeEvent[] = [];
  const handle = serve(acct, { concurrency: 2, reconcileMs: 3_600_000, onEvent: (e) => events.push(e) });
  await until(() => events.filter((e) => e.type === 'settled').length === 5);
  await handle.stop();
  expect(peak).toBe(2);
});

test('stop() waits for the steps in flight, aborts their waits, and starts nothing new', async () => {
  let release!: () => void;
  const stepping = new Promise<void>((resolve) => (release = resolve));
  let signal: AbortSignal | undefined;
  let finished = false;
  const { acct, calls } = account([order('a')], async (_id, opts) => {
    signal = opts.signal;
    await stepping; // a step being signed
    finished = true;
    throw new Error('aborted while waiting for the taker'); // what make throws at its next wait
  });
  const events: ServeEvent[] = [];
  const handle = serve(acct, { reconcileMs: 5, onEvent: (e) => events.push(e) });
  await until(() => calls.length === 1);

  let stopped = false;
  const stopping = handle.stop().then(() => (stopped = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(signal?.aborted).toBe(true);
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(finished).toBe(true);
  // The abort is not an error to report, and no poll ran after stop.
  expect(events).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toEqual(['a']);
});

test('the caller’s AbortSignal stops the loop like stop()', async () => {
  const { acct, calls } = account([order('a', { status: 'open' })], async (id) => settledOf(id));
  const controller = new AbortController();
  serve(acct, { reconcileMs: 5, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The maker's open order is waited on, never handed to make.
  expect(calls).toEqual([]);
});

test('orders serve does not drive are left alone: not DvP, an EVM leg, taken by another account', async () => {
  const { acct, calls } = account([
    order('htlc', { dvp: false }),
    order('evm', { targetNetwork: 'sepolia' }),
    order('theirs', { initiatorUserId: 'x', opponentUserId: 'y' }),
  ], async (id) => settledOf(id));
  const events: ServeEvent[] = [];
  const handle = serve(acct, { reconcileMs: 5, onEvent: (e) => events.push(e) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await handle.stop();
  expect(calls).toEqual([]);
  expect(events).toEqual([]);
});
