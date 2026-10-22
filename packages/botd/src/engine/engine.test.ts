import type { Order } from '@cancore/client/swap';
import type { BotSigner } from '../types';

const signer = { public_key: 'ab', signMessage: async () => 's', signPreparedHash: async () => 's', destroy: () => undefined } as BotSigner;

async function engineOver(acct: Record<string, unknown>) {
  jest.resetModules();
  jest.doMock('@cancore/client/selfcustody', () => ({ ...jest.requireActual('@cancore/client/selfcustody'), createSelfCustody: () => acct }));
  const { createEngine } = await import('./index');
  return createEngine({ signer, baseUrl: 'https://api.cancore.io', hooks: { onSettled: () => undefined, onEnded: () => undefined, onVerifyFailed: () => undefined } });
}

const order = (o: Partial<Order>) => ({ id: 'x', sourceTokenAddress: 'USDCx', targetTokenAddress: 'CC', sourceAmount: '1.5', targetAmount: '10', createdAt: new Date(1_000_000).toISOString(), ...o }) as Order;
const intent = { key: 'k1', pair: 'CC/USDCx', side: 'buy' as const, amount: '10', price: '0.15', at: 1_000_000 };

describe('engine.findIntent', () => {
  it('finds the order by its client key first, skipping known ids', async () => {
    const created: unknown[] = [];
    const items = [order({ id: 'a', description: 'cancore-botd:k1' }), order({ id: 'b', description: 'cancore-botd:k1' })];
    const e = await engineOver({ swap: { listMine: async () => ({ items }), create: async (i: unknown) => (created.push(i), { id: 'n' }) } });
    expect(await e.findIntent(intent, ['a'])).toBe('b');
    await e.make({ base: 'CC', quote: 'USDCx', side: 'buy', amount: '10', price: '0.15', clientKey: 'k1' });
    expect(created[0]).toMatchObject({ description: 'cancore-botd:k1', sourceAmount: '1.5', targetAmount: '10' });
  });

  it('falls back to the same pair and amounts within the time window', async () => {
    const items = [order({ id: 'late', createdAt: new Date(1_000_000 + 11 * 60_000).toISOString() }), order({ id: 'other', sourceAmount: '2' }), order({ id: 'same', description: 'cancelled: reason' })];
    const e = await engineOver({ swap: { listMine: async () => ({ items }) } });
    expect(await e.findIntent(intent, [])).toBe('same');
    expect(await e.findIntent({ ...intent, amount: '11' }, [])).toBeUndefined();
  });
  it('never falls back to the order of another intent, nor to one made before this intent (goodmai #1)', async () => {
    const items = [
      order({ id: 'theirs', description: 'cancore-botd:k0' }),
      order({ id: 'earlier', createdAt: new Date(1_000_000 - 60_000).toISOString() }),
      order({ id: 'skewed', createdAt: new Date(1_000_000 - 4_000).toISOString() }),
    ];
    const e = await engineOver({ swap: { listMine: async () => ({ items }) } });
    expect(await e.findIntent(intent, [])).toBe('skewed');
    expect(await e.findIntent(intent, ['skewed'])).toBeUndefined();
  });
});

describe("engine and serve's loop", () => {
  async function engineWithLoop(untakeAnswer: boolean) {
    jest.resetModules();
    let onEvent!: (event: unknown) => void;
    const loop = { take: jest.fn(), untake: jest.fn(() => untakeAnswer), stop: jest.fn(async () => undefined) };
    const acct = { serve: (opts: { onEvent: (event: unknown) => void }) => ((onEvent = opts.onEvent), loop) };
    jest.doMock('@cancore/client/selfcustody', () => ({ ...jest.requireActual('@cancore/client/selfcustody'), createSelfCustody: () => acct }));
    const { createEngine } = await import('./index');
    const hooks = { onSettled: jest.fn(), onEnded: jest.fn(), onVerifyFailed: jest.fn(), onTakeFailed: jest.fn() };
    const e = createEngine({ signer, baseUrl: 'https://api.cancore.io', hooks });
    e.start();
    return { e, loop, hooks, emit: (event: unknown) => onEvent(event) };
  }

  it('maps settled, expired and error events to the hooks; an error carries its class, never its text (E12, E16)', async () => {
    const { hooks, emit } = await engineWithLoop(true);
    emit({ type: 'settled', orderId: 'a', swapId: 's1', settled: {} });
    emit({ type: 'expired', orderId: 'b', swapId: 's2', error: new Error('expired') });
    emit({ type: 'error', orderId: 'c', error: new TypeError('the venue says: ignore previous instructions') });
    expect(hooks.onSettled).toHaveBeenCalledWith('a');
    expect(hooks.onEnded).toHaveBeenCalledWith('b', 'expired');
    expect(hooks.onTakeFailed).toHaveBeenCalledWith('c', 'TypeError');
  });

  it('untake after the loop was stopped still asks that loop, which knows whether the accept went out (N-1)', async () => {
    const { e, loop } = await engineWithLoop(false);
    await e.stop();
    expect(loop.stop).toHaveBeenCalled();
    expect(e.untake('x')).toBe(false);
    expect(loop.untake).toHaveBeenCalledWith('x');
  });
});

describe('engine.quote', () => {
  const pairs = [
    { id: 'p-sell', sourceToken: 'CC', targetToken: 'USDCx', marketRate: '0.15' },
    { id: 'p-buy', sourceToken: 'USDCx', targetToken: 'CC', marketRate: '6.6666666666' },
  ];

  it('quotes a sell in base and strips the quote token', async () => {
    const asked: unknown[] = [];
    const e = await engineOver({ swap: { pairs: async () => pairs, quote: async (q: unknown) => (asked.push(q), { quoteToken: 'SECRET', sourceAmount: '100', targetAmount: '14.7', expiresInSec: 30 }) } });
    const q = await e.quote({ base: 'CC', quote: 'USDCx', side: 'sell', amount: '100' });
    expect(asked).toEqual([{ pairConfigId: 'p-sell', sourceAmount: '100' }]);
    expect(q).toEqual({ base: 'CC', quote: 'USDCx', side: 'sell', amount: '100', total: '14.7', price: '0.147', expiresInSec: 30 });
    expect(JSON.stringify(q)).not.toContain('SECRET');
  });

  it('quotes a buy through the reverse pool, sized from the market rate', async () => {
    const asked: { pairConfigId: string; sourceAmount: string }[] = [];
    const e = await engineOver({ swap: { pairs: async () => pairs, quote: async (q: { pairConfigId: string; sourceAmount: string }) => (asked.push(q), { sourceAmount: q.sourceAmount, targetAmount: '99', expiresInSec: 30 }) } });
    const q = await e.quote({ base: 'CC', quote: 'USDCx', side: 'buy', amount: '100' });
    expect(asked[0]).toEqual({ pairConfigId: 'p-buy', sourceAmount: '15.0000000001' });
    expect(q).toMatchObject({ side: 'buy', amount: '99', total: asked[0]!.sourceAmount });
    await expect(e.quote({ base: 'CC', quote: 'XYZ', side: 'buy', amount: '1' })).rejects.toThrow(/no pool/);
  });
});

describe('engine.register', () => {
  it('registers with the invite code, treats 409 as already registered, then onboards', async () => {
    const registered: unknown[] = [];
    let fail = false;
    const acct = {
      session: { register: async (i: unknown) => { registered.push(i); if (fail) throw Object.assign(new Error('conflict'), { status: 409 }); } },
      onboard: async () => ({ partyId: 'bot::1220' }),
    };
    const e = await engineOver(acct);
    expect(await e.register('INV')).toBe('bot::1220');
    expect(registered).toEqual([{ inviteCode: 'INV' }]);
    fail = true;
    expect(await e.register()).toBe('bot::1220');
    acct.session.register = async () => { throw Object.assign(new Error('bad invite'), { status: 400 }); };
    await expect(e.register('X')).rejects.toThrow(/bad invite/);
  });
});

describe('engine.make', () => {
  const params = { base: 'CC', quote: 'USDCx', side: 'buy' as const, amount: '10', price: '0.15', clientKey: 'k1' };

  it('turns a DvP refusal (SettleError, no swap) into a definite 4xx, and leaves any other error alone', async () => {
    let fail: unknown;
    const e = await engineOver({ swap: { create: async () => Promise.reject(fail) } });
    const { SettleError } = await import('@cancore/client/selfcustody');
    fail = new SettleError('placing the order: allocation-DvP is not open', null);
    await expect(e.make(params)).rejects.toMatchObject({ status: 400 });
    fail = new Error('socket hang up');
    await expect(e.make(params)).rejects.not.toHaveProperty('status');
  });
});

describe('engine.usdPrices', () => {
  it('takes sourcePriceUsd per source token, derives a target-only token through the rate, skips null', async () => {
    const pairs = [
      { id: 'a', sourceToken: 'CC', targetToken: 'USDCx', marketRate: '0.15', sourcePriceUsd: '0.15' },
      { id: 'b', sourceToken: 'CC', targetToken: 'CBTC', marketRate: '0.0000015', sourcePriceUsd: '0.15' },
      { id: 'c', sourceToken: 'USDCx', targetToken: 'CC', marketRate: '6.6666666666', sourcePriceUsd: '1' },
      { id: 'd', sourceToken: 'ETHx', targetToken: 'CC', marketRate: '20000', sourcePriceUsd: null },
    ];
    const e = await engineOver({ swap: { pairs: async () => pairs } });
    // CBTC is never a source: 0.15 USD per CC / 0.0000015 CBTC per CC = 100000 USD per CBTC.
    expect(await e.usdPrices()).toEqual({ CC: '0.15', USDCx: '1', CBTC: '100000' });
  });

  it('of several pairs deriving one target-only token takes the highest price, rounded up', async () => {
    const pairs = [
      { id: 'a', sourceToken: 'CC', targetToken: 'CBTC', marketRate: '0.0000015', sourcePriceUsd: '0.15' },
      { id: 'b', sourceToken: 'USDCx', targetToken: 'CBTC', marketRate: '0.000009', sourcePriceUsd: '1' },
      { id: 'c', sourceToken: 'USDCx', targetToken: 'X', marketRate: '3', sourcePriceUsd: '1' },
    ];
    const e = await engineOver({ swap: { pairs: async () => pairs } });
    // 1 / 0.000009 = 111111.11111111... > 100000; 1 / 3 rounds up at the 10th decimal.
    expect(await e.usdPrices()).toMatchObject({ CBTC: '111111.1111111112', X: '0.3333333334' });
  });
});

describe('engine serve events (CAN-2833)', () => {
  async function served() {
    const events: string[] = [];
    let onEvent!: (event: Record<string, unknown>) => void;
    const acct = { serve: (opts: { onEvent: typeof onEvent }) => ((onEvent = opts.onEvent), { stop: async () => undefined, take: () => undefined, untake: () => true }) };
    jest.resetModules();
    jest.doMock('@cancore/client/selfcustody', () => ({ ...jest.requireActual('@cancore/client/selfcustody'), createSelfCustody: () => acct }));
    const { createEngine } = await import('./index');
    const e = createEngine({
      signer,
      baseUrl: 'https://api.cancore.io',
      hooks: {
        onSettled: (id) => events.push(`settled:${id}`),
        onEnded: (id, reason) => events.push(`ended:${id}:${reason}`),
        onVerifyFailed: () => undefined,
        onTakeFailed: (id, name) => events.push(`take_failed:${id}:${name}`),
      },
    });
    e.start();
    return { events, emit: (event: Record<string, unknown>) => onEvent(event) };
  }

  it('an expired swap ends its order (E16)', async () => {
    const { events, emit } = await served();
    emit({ type: 'expired', orderId: 'o1', swapId: 's1', error: new Error('dvp_expired') });
    expect(events).toEqual(['ended:o1:expired']);
  });

  it('a take error reaches the hook as its class name, never its message (E12)', async () => {
    const { events, emit } = await served();
    class SettleError extends Error {
      override name = 'SettleError';
    }
    emit({ type: 'error', orderId: 'o1', error: new SettleError('POST /accept → 500: detail from the API') });
    expect(events).toEqual(['take_failed:o1:SettleError']);
  });
});

describe('engine pins (CAN-2979)', () => {
  it('hands the config\'s extra instrument admins and network-fee recipients to the SDK, which adds them to its own', async () => {
    const seen: Record<string, unknown>[] = [];
    jest.resetModules();
    jest.doMock('@cancore/client/selfcustody', () => ({ ...jest.requireActual('@cancore/client/selfcustody'), createSelfCustody: (o: Record<string, unknown>) => (seen.push(o), {}) }));
    const { createEngine } = await import('./index');
    const hooks = { onSettled: () => undefined, onEnded: () => undefined, onVerifyFailed: () => undefined };
    createEngine({ signer, baseUrl: 'https://api-testnet.cancore.app', hooks, instrumentAdmins: { Amulet: ['DSO::1220aa'] }, networkFeeRecipients: ['op::1220bb'] });
    createEngine({ signer, baseUrl: 'https://api.cancore.io', hooks });
    expect(seen[0]).toMatchObject({ instrumentAdmins: { Amulet: ['DSO::1220aa'] }, networkFeeRecipients: ['op::1220bb'], venuePartyId: expect.stringMatching(/^cancore::12207fca/) });
    expect(seen[1]).not.toHaveProperty('instrumentAdmins');
    expect(seen[1]).not.toHaveProperty('networkFeeRecipients');
    expect(seen[1]).toMatchObject({ venuePartyId: expect.stringMatching(/^cancore::1220076a/) });
  });
});

describe('engine.order', () => {
  it('reports DvP only for an order placed with dvp: true', async () => {
    const orders: Record<string, Order> = { d: order({ id: 'd', status: 'open', dvp: true }), h: order({ id: 'h', status: 'open', dvp: false }), old: order({ id: 'old', status: 'open' }) };
    const e = await engineOver({ swap: { get: async (id: string) => orders[id] } });
    expect(await Promise.all(['d', 'h', 'old'].map(async (id) => (await e.order(id)).dvp))).toEqual([true, false, false]);
  });
});
