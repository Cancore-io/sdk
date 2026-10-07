import { serve, type ServeEvent, type SettleRun } from './serve';
import type { SelfCustodyAccount, Settled, SettleOptions, Withdrawal } from './selfcustody';
import type { Order } from './swap';

/**
 * The loop's own rules, against an account whose make / take are scripted: which orders it works on, how
 * much at once, what a failure does to the rest, what stop() waits for, and expired trades found by the poll. The DvP steps themselves are
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

const noneLocked = async () => false;

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
  const handle = serve(acct, { reconcileMs: 5, onEvent: (e) => events.push(e) }, noneLocked);
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
  }, noneLocked);
  await until(() => seen.length === 2);
  await handle.stop();
});

test('no more than `concurrency` steps at once', async () => {
  let running = 0;
  let peak = 0;
  const { acct } = account(['a', 'b', 'c', 'd', 'e'].map((id) => order(id)), async (id, opts) => {
    await (opts as SettleRun).gate!(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
    });
    return settledOf(id);
  });
  const events: ServeEvent[] = [];
  const handle = serve(acct, { concurrency: 2, reconcileMs: 3_600_000, onEvent: (e) => events.push(e) }, noneLocked);
  await until(() => events.filter((e) => e.type === 'settled').length === 5);
  await handle.stop();
  expect(peak).toBe(2);
});

test('a trade waiting on its counterparty holds no slot: 6 taken orders with concurrency 2 are all proposed at once', async () => {
  const proposed: string[] = [];
  let settle!: () => void;
  const settling = new Promise<void>((resolve) => (settle = resolve));
  const { acct } = account(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => order(id)), async (id, opts) => {
    await (opts as SettleRun).gate!(async () => void proposed.push(id)); // the proposal step
    await settling; // waiting on the taker and the venue, for as long as that takes
    return settledOf(id);
  });
  const events: ServeEvent[] = [];
  const handle = serve(acct, { concurrency: 2, reconcileMs: 3_600_000, onEvent: (e) => events.push(e) }, noneLocked);
  await until(() => proposed.length === 6);
  expect(events).toEqual([]); // none settled yet
  settle();
  await until(() => events.filter((e) => e.type === 'settled').length === 6);
  await handle.stop();
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
  const handle = serve(acct, { reconcileMs: 5, onEvent: (e) => events.push(e) }, noneLocked);
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
  serve(acct, { reconcileMs: 5, signal: controller.signal }, noneLocked);
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
  const handle = serve(acct, { reconcileMs: 5, onEvent: (e) => events.push(e) }, noneLocked);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await handle.stop();
  expect(calls).toEqual([]);
  expect(events).toEqual([]);
});

/** Orders o0..o{n-1}, each expired (order cancelled, swap dvp_expired); listSwaps pages them newest first. */
function expiredAccount(n: number, lockedIds: Set<string>) {
  const orders = Array.from({ length: n }, (_, i) => order(`o${i}`, { status: 'cancelled', swapId: `s${i}` }));
  const withdrawn: string[] = [];
  const { acct } = account(orders, async (id) => settledOf(id));
  Object.assign(acct, {
    listSwaps: async ({ page = 1, pageSize = 20 }: { page?: number; pageSize?: number }) =>
      orders.slice((page - 1) * pageSize, page * pageSize).map((o) => ({ id: o.swapId, status: 'dvp_expired', orderId: o.id })),
    withdrawAllocation: async (swapId: string): Promise<Withdrawal> => {
      withdrawn.push(swapId);
      lockedIds.delete(swapId);
      return { swapId, withdrawn: ['counter'], gone: [], failed: [] };
    },
  });
  const locked = async (swapId: string) => lockedIds.has(swapId);
  return { acct, withdrawn, locked };
}

test('a locked expired swap older than the newest 100 is still found and withdrawn', async () => {
  const { acct, withdrawn, locked } = expiredAccount(250, new Set(['s120', 's240']));
  const events: ServeEvent[] = [];
  const handle = serve(acct, { reconcileMs: 5, onEvent: (e) => events.push(e) }, locked);
  await until(() => withdrawn.length === 2);
  await handle.stop();
  expect(withdrawn.sort()).toEqual(['s120', 's240']);
  expect(events.filter((e) => e.type === 'withdrawn').map((e) => (e as { swapId: string }).swapId).sort()).toEqual(['s120', 's240']);
});

test('an expired trade the poll finds still locked is reported as expired, once, with autoWithdraw off', async () => {
  const { acct, withdrawn, locked } = expiredAccount(3, new Set(['s1']));
  const events: ServeEvent[] = [];
  const handle = serve(acct, { reconcileMs: 5, autoWithdraw: false, onEvent: (e) => events.push(e) }, locked);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handle.stop();
  expect(withdrawn).toEqual([]);
  expect(events).toEqual([{ type: 'expired', orderId: 'o1', swapId: 's1', error: expect.any(Error) }]);
});

test('with autoWithdraw on, the expired event found by the poll carries the withdrawal', async () => {
  const { acct, locked } = expiredAccount(3, new Set(['s2']));
  const events: ServeEvent[] = [];
  const handle = serve(acct, { reconcileMs: 5, onEvent: (e) => events.push(e) }, locked);
  await until(() => events.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await handle.stop();
  const withdrawal = { swapId: 's2', withdrawn: ['counter'], gone: [], failed: [] };
  expect(events).toEqual([
    { type: 'expired', orderId: 'o2', swapId: 's2', error: expect.any(Error), withdrawal },
    { type: 'withdrawn', orderId: 'o2', swapId: 's2', withdrawal },
  ]);
});

test('a newly taken order gets its proposal signed without waiting behind a restart’s expired backlog', async () => {
  // 250 expired swaps, all clean, each look a slow read: the first poll queues 200 of them at concurrency 1.
  const { acct } = expiredAccount(250, new Set());
  let looked = 0;
  const locked = async () => {
    looked++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return false;
  };
  const live = order('live', { status: 'accepted' });
  const get = acct.swap.get;
  acct.swap.get = async (id: string) => (id === 'live' ? live : get(id));
  let lookedAtProposal = -1;
  acct.make = async (id, opts) => {
    await (opts as SettleRun).gate!(async () => void (lookedAtProposal = looked)); // the proposal step
    return settledOf(id);
  };
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket = { on: (event: string, handler: (payload: unknown) => void) => void handlers.set(event, handler), off: () => {} };
  const events: ServeEvent[] = [];
  const handle = serve(acct, { socket, concurrency: 1, reconcileMs: 3_600_000, onEvent: (e) => events.push(e) }, locked);
  await until(() => looked >= 3);
  handlers.get('order:updated')!(live);
  await until(() => events.some((e) => e.type === 'settled'));
  await handle.stop();
  // At most the look in hand when the order arrived, and one more between its look and its step — not the 200 queued.
  expect(lookedAtProposal).toBeLessThan(10);
});

test('under live load that never lets up, a locked expired swap is still withdrawn within a bounded number of steps', async () => {
  // Five expired swaps, the last one locked; three live trades signing step after step at concurrency 1,
  // so a live step is always waiting when a slot is released.
  const { acct, withdrawn, locked } = expiredAccount(5, new Set(['s4']));
  const live = ['l0', 'l1', 'l2'].map((id) => order(id));
  const get = acct.swap.get;
  acct.swap.get = async (id: string) => live.find((o) => o.id === id) ?? get(id);
  acct.swap.listMine = (async ({ statusFilter }: { statusFilter?: string }) => {
    const items = live.filter((o) => o.status === statusFilter);
    return { items, page: 1, pageSize: 100, total: items.length };
  }) as SelfCustodyAccount['swap']['listMine'];
  let steps = 0;
  acct.make = async (id, opts) => {
    while (!opts?.signal?.aborted && withdrawn.length === 0 && steps < 500) {
      await (opts as SettleRun).gate!(async () => {
        steps++;
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    }
    return settledOf(id);
  };
  const handle = serve(acct, { concurrency: 1, reconcileMs: 3_600_000 }, locked);
  await until(() => withdrawn.length === 1 || steps >= 500);
  await handle.stop();
  expect(withdrawn).toEqual(['s4']);
  // Five backlog looks, one per four released slots: about 20 live steps, never the whole load.
  expect(steps).toBeLessThan(40);
});

test('serve reads me() once per poll, not per look, and a changed party is seen on the next poll', async () => {
  // Each poll lists one more expired swap; the account's party changes between polls.
  const { acct, locked } = expiredAccount(4, new Set());
  let meCalls = 0;
  let polls = 0;
  acct.me = (async () => ({ id: 'me', partyId: `p${++meCalls}` })) as SelfCustodyAccount['me'];
  const listSwaps = acct.listSwaps;
  acct.listSwaps = (async () => (polls++, (await listSwaps({ pageSize: 100 })).slice(0, polls))) as SelfCustodyAccount['listSwaps'];
  const seen: string[] = [];
  const handle = serve(acct, { reconcileMs: 5 }, async (swapId, self) => (seen.push(`${swapId}:${self.partyId}`), locked(swapId)));
  await until(() => seen.length === 4);
  await handle.stop();
  expect(meCalls).toBeLessThanOrEqual(polls);
  // Each swap is looked at with the party read on the poll that first listed it.
  expect(seen).toEqual(['s0:p1', 's1:p2', 's2:p3', 's3:p4']);
});
