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
});
