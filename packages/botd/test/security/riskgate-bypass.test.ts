import { check, checkTake } from '../../src/riskgate';
import { parseLimits } from '../../src/limits';
import { parseRequest } from '../../src/protocol/index';
import type { BotState, Command } from '../../src/types';
import { agent, LIMITS, make, outcome, owner, req, rig, type Rig } from './rig';

const NOW = 1_700_000_000_000;
const limits = parseLimits(LIMITS);
const state = (s: Partial<BotState> = {}): BotState => ({
  locked: false, paused: false, openOrders: [], positions: {}, dailyVolume: {}, recentCommands: [], referencePrices: { 'CC/USDCx': '0.15' }, usdPrices: { CC: '0.15', USDCx: '1' }, ...s,
});
const order = (amount: string, price = '0.15'): Command => ({ method: 'order.make', params: { base: 'CC', quote: 'USDCx', side: 'buy', amount, price } }) as Command;

describe('security: decimal tricks never reach the gate as numbers', () => {
  it.each(['1e3', '0x10', ' 1', '1 ', '+1', '-0', '-1', '1.', '.5', '1,5', '١', 'Infinity', 'NaN', '1_000', '0b1', '1\n'])('%j is refused by the wire schema', (amount) => {
    expect(parseRequest({ jsonrpc: '2.0', id: 1, method: 'order.make', params: { base: 'CC', quote: 'USDCx', side: 'buy', amount, price: '0.15' } }).ok).toBe(false);
    expect(parseRequest({ jsonrpc: '2.0', id: 1, method: 'order.take', params: { orderId: 'x', amount } }).ok).toBe(false);
  });

  it.each([
    ['11 decimals', '1.00000000001'],
    ['21 integer digits', '1'.repeat(21)],
    ['10k digits', '9'.repeat(10_000)],
    ['zero', '0'],
    ['zero with decimals', '0.0000000000'],
  ])('%s passes the schema but the gate denies', (_, amount) => {
    expect(check(order(amount), state(), limits, NOW)).toMatchObject({ allow: false });
    expect(check(order('1', amount), state(), limits, NOW)).toMatchObject({ allow: false });
  });

  it('notional is exact: no float overflow or rounding lets a huge order through', () => {
    const wide = { ...limits, maxOrderAmount: { CC: '999999999999999' }, maxDailyVolume: { CC: '999999999999999' }, maxPosition: { CC: '999999999999999' } };
    // 20-digit amount x price: bigint, never Infinity.
    expect(check(order('99999999999999999999', '0.15'), state(), wide, NOW)).toMatchObject({ allow: false });
    // Just over the 20 USDCx notional cap by one 1e-10 unit.
    expect(check(order('100', '0.2000000001'), state({ referencePrices: { 'CC/USDCx': '0.2' } }), { ...wide, maxOrderNotional: { USDCx: '20' } }, NOW)).toEqual({ allow: false, reason: 'notional_exceeded' });
  });

  it('a limit cap that is not a plain decimal is refused when the owner sets it', () => {
    for (const cap of ['1e9', 'Infinity', '-1', '0', '1'.repeat(16)]) expect(() => parseLimits({ ...LIMITS, maxOrderAmount: { CC: cap } })).toThrow();
    // A key like __proto__ in a cap map never becomes a cap for a real instrument.
    expect(check(order('50'), state(), parseLimits({ ...LIMITS, maxOrderAmount: JSON.parse('{"__proto__":"1000"}') }), NOW)).toEqual({ allow: false, reason: 'order_size_exceeded' });
  });
});

describe('security: risk gate bypass attempts', () => {
  it('price far from reference, either way', () => {
    expect(check(order('10', '0.1'), state(), limits, NOW)).toEqual({ allow: false, reason: 'price_deviation_exceeded' });
    expect(check(order('10', '10'), state(), limits, NOW)).toEqual({ allow: false, reason: 'price_deviation_exceeded' });
  });

  it('a take is held to the price the taker really pays, not the reference', () => {
    const o = { base: 'CC', quote: 'USDCx', side: 'buy' as const };
    // Buying 10 CC for 100 USDCx (price 10) is far from the 0.15 reference.
    expect(checkTake({ orderId: 'x', amount: '10' }, { ...o, price: '10' }, state(), limits, NOW)).toEqual({ allow: false, reason: 'price_deviation_exceeded' });
    expect(checkTake({ orderId: 'x', amount: '10' }, { ...o, price: '0.15' }, state(), limits, NOW)).toEqual({ allow: true });
  });

  it('a strategy whose 24h worst case exceeds the limits is refused', () => {
    const grid = (c: Record<string, unknown>): Command =>
      ({ method: 'strategy.start', params: { kind: 'grid', base: 'CC', quote: 'USDCx', config: { side: 'buy', levels: 4, amountPerLevel: '50', lowerPrice: '0.149', upperPrice: '0.151', ...c } } }) as Command;
    const dca = (c: Record<string, unknown>): Command =>
      ({ method: 'strategy.start', params: { kind: 'dca', base: 'CC', quote: 'USDCx', config: { side: 'buy', amountPerOrder: '10', intervalSeconds: 3600, maxOrders: 5, ...c } } }) as Command;
    const wide = { ...limits, maxOpenOrders: 100, maxCommandsPerMinute: 600 };
    expect(check(grid({}), state(), wide, NOW)).toEqual({ allow: true });
    expect(check(grid({ levels: 7 }), state(), wide, NOW)).toEqual({ allow: false, reason: 'daily_volume_exceeded' });
    expect(check(grid({ amountPerLevel: '101' }), state(), wide, NOW)).toEqual({ allow: false, reason: 'order_size_exceeded' });
    expect(check(grid({ upperPrice: '0.2' }), state(), wide, NOW)).toEqual({ allow: false, reason: 'price_deviation_exceeded' });
    expect(check(grid({ levels: 101 }), state(), wide, NOW)).toMatchObject({ allow: false });
    expect(check(grid({ extra: 1 }), state(), wide, NOW)).toMatchObject({ allow: false });
    // 60s interval: 1440 orders a day of 10 CC.
    expect(check(dca({ intervalSeconds: 60, maxOrders: 10_000 }), state(), wide, NOW)).toMatchObject({ allow: false });
    expect(check(dca({ intervalSeconds: 59 }), state(), wide, NOW)).toMatchObject({ allow: false });
  });

  it('many open orders that each fit cannot together exceed the daily volume', () => {
    // 3 open buys of 100 + 3 sells of 100 keep the position near 0 but would trade 600 > 300 in a day.
    const open = Array.from({ length: 3 }, (_, i) => ({ orderId: `o${i}`, pair: 'CC/USDCx', side: (i % 2 ? 'sell' : 'buy') as 'buy' | 'sell', amount: '100', price: '0.15' }));
    expect(check(order('100'), state({ openOrders: open }), { ...limits, maxOrderNotional: { USDCx: '100' } }, NOW)).toEqual({ allow: false, reason: 'daily_volume_exceeded' });
  });
});

describe('security: through the dispatcher', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig({ ...LIMITS, maxOrderNotional: { USDCx: '100' }, maxDailyVolume: { CC: '10000' } });
    await r.unlock();
  });
  afterEach(() => r.cleanup());

  it('splitting one big order into many small ones hits the rate limit', async () => {
    r = await rig({ ...LIMITS, maxCommandsPerMinute: 3, maxOpenOrders: 100, maxDailyVolume: { CC: '10000' } });
    await r.unlock();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await outcome(r.dispatcher.handle(make('10'), agent)));
    expect(results).toEqual(['ok', 'ok', 'ok', 'rate_limited', 'rate_limited', 'rate_limited']);
    expect(r.engine.made).toHaveLength(3);
  });

  it('parallel makes that each fit alone cannot together exceed open orders (gate + book are atomic)', async () => {
    r.engine.makeDelayMs = 20;
    const results = await Promise.all(Array.from({ length: 12 }, () => outcome(r.dispatcher.handle(make('10'), agent))));
    expect(results.filter((x) => x === 'ok')).toHaveLength(LIMITS.maxOpenOrders);
    expect(r.engine.made).toHaveLength(LIMITS.maxOpenOrders);
    expect(r.state().openOrders).toHaveLength(LIMITS.maxOpenOrders);
  });

  it('parallel makes cannot together exceed the position cap', async () => {
    r = await rig({ ...LIMITS, maxOpenOrders: 100, maxPosition: { CC: '250' }, maxOrderNotional: { USDCx: '100' }, maxDailyVolume: { CC: '10000' } });
    await r.unlock();
    r.engine.makeDelayMs = 20;
    await Promise.all(Array.from({ length: 10 }, () => outcome(r.dispatcher.handle(make('100'), agent))));
    expect(r.engine.made).toHaveLength(2);
  });

  it('an order made while a pause lands does not un-pause trading', async () => {
    // Deterministic: the make is held at the API until the pause has returned.
    let release!: () => void;
    r.engine.makeHold = new Promise((res) => (release = res));
    const started = new Promise<void>((res) => (r.engine.onMakeStart = res));
    const pending = r.dispatcher.handle(make('10'), agent);
    await started;
    await r.dispatcher.handle(req('pause', { reason: 'owner stop' }), owner);
    release();
    // It landed after the pause: refused as paused, and the order it placed is cancelled, not left resting.
    expect(await outcome(pending)).toBe(-32003);
    expect(r.state()).toMatchObject({ paused: true, openOrders: [] });
    expect(await outcome(r.dispatcher.handle(make('10'), agent))).toBe(-32003);
  });

  it.each([
    ['order.take', () => req('order.take', { orderId: 'held', amount: '10' })],
    ['strategy.start', () => req('strategy.start', { kind: 'grid', base: 'CC', quote: 'USDCx', config: { side: 'buy', levels: 2, amountPerLevel: '10', lowerPrice: '0.149', upperPrice: '0.151' } })],
  ])('%s held in the gate while a pause returns is refused and acts on nothing', async (_m, request) => {
    r.engine.orders.set('held', { orderId: 'held', status: 'open', source: 'CC', sourceAmount: '10', target: 'USDCx', targetAmount: '1.5' });
    let release!: () => void;
    r.engine.gateHold = new Promise((res) => (release = res));
    const held = new Promise<void>((res) => (r.engine.onGateHold = res));
    const pending = outcome(r.dispatcher.handle(request(), agent));
    await held;
    r.engine.gateHold = undefined;
    await r.dispatcher.handle(req('pause', { reason: 'owner stop' }), owner);
    release();
    expect(await pending).toBe(-32003);
    expect(r.engine.taken).toEqual([]);
    expect(r.state()).toMatchObject({ paused: true, openOrders: [] });
    expect(r.state().strategies ?? []).toEqual([]);
  });

  it('a pause drops a queued take whose accept has not been sent, and keeps one already accepted', async () => {
    r.engine.orders.set('queued', { orderId: 'queued', status: 'open', source: 'CC', sourceAmount: '10', target: 'USDCx', targetAmount: '1.5' });
    r.engine.orders.set('sent', { orderId: 'sent', status: 'open', source: 'CC', sourceAmount: '10', target: 'USDCx', targetAmount: '1.5' });
    expect(await outcome(r.dispatcher.handle(req('order.take', { orderId: 'queued', amount: '10' }), agent))).toBe('ok');
    expect(await outcome(r.dispatcher.handle(req('order.take', { orderId: 'sent', amount: '10' }), agent))).toBe('ok');
    // 'sent' already went out to the API: untake reports it cannot be stopped.
    r.engine.untake = (id: string) => (r.engine.untaken.push(id), id !== 'sent');
    await r.dispatcher.handle(req('pause', { reason: 'owner stop' }), owner);
    // The called-off take once more in the final write: a take of it queued again since would be called off too.
    expect(r.engine.untaken.sort()).toEqual(['queued', 'queued', 'sent']);
    expect(r.state().openOrders.map((o) => o.orderId)).toEqual(['sent']);
  });

  it('a pause written between the take gate and its booking drops the queued take', async () => {
    r.engine.orders.set('late', { orderId: 'late', status: 'open', source: 'CC', sourceAmount: '10', target: 'USDCx', targetAmount: '1.5' });
    let release!: () => void;
    r.engine.takeHold = new Promise((res) => (release = res));
    const started = new Promise<void>((res) => (r.engine.onTakeStart = res));
    const pending = outcome(r.dispatcher.handle(req('order.take', { orderId: 'late', amount: '10' }), agent));
    await started;
    // The pause reads a book without this take: only the booking write can still stop it.
    await r.dispatcher.handle(req('pause', { reason: 'owner stop' }), owner);
    release();
    expect(await pending).toBe(-32003);
    expect(r.engine.untaken).toContain('late');
    expect(r.state().openOrders).toEqual([]);
  });

  it('a take larger than the limits, or at a hostile price, is refused', async () => {
    r.engine.orders.set('big', { orderId: 'big', status: 'open', source: 'CC', sourceAmount: '500', target: 'USDCx', targetAmount: '75' });
    expect(await outcome(r.dispatcher.handle(req('order.take', { orderId: 'big', amount: '500' }), agent))).toBe('order_size_exceeded');
    // 10 CC for 100 USDCx: price 10 against a 0.15 reference.
    r.engine.orders.set('rip', { orderId: 'rip', status: 'open', source: 'CC', sourceAmount: '10', target: 'USDCx', targetAmount: '100' });
    expect(await outcome(r.dispatcher.handle(req('order.take', { orderId: 'rip', amount: '10' }), agent))).toBe('price_deviation_exceeded');
    // A partial take of a big order is no way around the size cap.
    expect(await outcome(r.dispatcher.handle(req('order.take', { orderId: 'big', amount: '50' }), agent))).toBe('no_rule');
    expect(r.engine.taken).toEqual([]);
  });

  it('a take of an order whose API amounts do not parse is denied and audited, not an internal error', async () => {
    r.engine.orders.set('bad', { orderId: 'bad', status: 'open', source: 'CC', sourceAmount: '1e3', target: 'USDCx', targetAmount: '0' });
    r.engine.orders.set('long', { orderId: 'long', status: 'open', source: 'CC', sourceAmount: '1.00000000001', target: 'USDCx', targetAmount: '0.15' });
    expect(await outcome(r.dispatcher.handle(req('order.take', { orderId: 'bad', amount: '1' }), agent))).toBe('no_rule');
    expect(await outcome(r.dispatcher.handle(req('order.take', { orderId: 'long', amount: '1.00000000001' }), agent))).toBe('no_rule');
    expect(r.audit().filter((e) => e.method === 'order.take').map((e) => e.decision)).toEqual(['deny', 'deny']);
  });
});
