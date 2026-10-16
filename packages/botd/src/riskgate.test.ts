import { METHODS, RISK_CLASS, type Method } from './protocol/index';
import { emptyLimits } from './limits';
import { check, checkTake } from './riskgate';
import type { BotState, Command, Limits } from './types';

const NOW = 1_800_000_000_000;

const limits: Limits = {
  allowedPairs: ['CC/USDCx'],
  maxOrderAmount: { CC: '100' },
  maxOrderNotional: { USDCx: '15' },
  maxDailyVolume: { CC: '1000' },
  maxPosition: { CC: '500' },
  maxOpenOrders: 3,
  maxPriceDeviationBps: 100,
  maxCommandsPerMinute: 5,
  perOrderUsd: '1000',
  perDayUsd: '100000',
  usdCapsOptOut: false,
};

const state = (s: Partial<BotState> = {}): BotState => ({
  locked: false,
  paused: false,
  openOrders: [],
  positions: {},
  dailyVolume: {},
  recentCommands: [],
  referencePrices: { 'CC/USDCx': '0.15' },
  usdPrices: { CC: '0.15' },
  ...s,
});

const make = (p: Partial<{ base: string; quote: string; side: 'buy' | 'sell'; amount: string; price: string }> = {}): Command =>
  ({ method: 'order.make', params: { base: 'CC', quote: 'USDCx', side: 'buy', amount: '10', price: '0.15', ...p } }) as Command;

const order = (amount: string, side: 'buy' | 'sell' = 'buy') => ({ orderId: 'o', pair: 'CC/USDCx', side, amount, price: '0.15' });

describe('check: class routing', () => {
  const byClass = (c: string) => METHODS.filter((m) => RISK_CLASS[m] === c);
  it.each(byClass('read'))('allows read %s even locked and paused', (m) =>
    expect(check({ method: m, params: {} } as Command, state({ locked: true, paused: true }), emptyLimits(), NOW)).toEqual({ allow: true }));
  it.each(byClass('reduce'))('allows reduce %s even locked and paused', (m) =>
    expect(check({ method: m, params: {} } as Command, state({ locked: true, paused: true }), emptyLimits(), NOW)).toEqual({ allow: true }));
  it.each(byClass('owner'))('denies owner %s', (m) =>
    expect(check({ method: m, params: {} } as Command, state(), limits, NOW)).toEqual({ allow: false, reason: 'no_rule' }));
  it('denies an unknown method', () =>
    expect(check({ method: 'withdraw' as Method, params: {} } as Command, state(), limits, NOW)).toEqual({ allow: false, reason: 'no_rule' }));
  it('denies a bare order.take (needs checkTake)', () =>
    expect(check({ method: 'order.take', params: { orderId: 'x', amount: '1' } } as Command, state(), limits, NOW)).toEqual({ allow: false, reason: 'no_rule' }));
});

describe('check: order.make', () => {
  const recent = (n: number, at = NOW - 1000) => Array.from({ length: n }, () => at);
  it.each<[string, Command, Partial<BotState>, Partial<Limits>, string | null]>([
    ['baseline', make(), {}, {}, null],
    ['locked', make(), { locked: true }, {}, 'locked'],
    ['paused', make(), { paused: true }, {}, 'paused'],
    ['pair not allowed', make({ quote: 'USDT' }), {}, {}, 'instrument_not_allowed'],
    ['reversed pair', make({ base: 'USDCx', quote: 'CC' }), {}, {}, 'instrument_not_allowed'],
    ['no reference price', make(), { referencePrices: {} }, {}, 'price_deviation_exceeded'],
    // amount: 100 at 0.15 = 15 notional; widen the notional cap to isolate size
    ['amount == cap', make({ amount: '100' }), {}, {}, null],
    ['amount cap + 1 unit', make({ amount: '100.0000000001' }), {}, { maxOrderNotional: { USDCx: '100' } }, 'order_size_exceeded'],
    ['no amount cap for base', make(), {}, { maxOrderAmount: {} }, 'order_size_exceeded'],
    ['notional == cap', make({ amount: '100', price: '0.15' }), {}, {}, null],
    ['notional cap + 1 unit', make({ amount: '100', price: '0.1500000001' }), {}, {}, 'notional_exceeded'],
    ['no notional cap for quote', make(), {}, { maxOrderNotional: {} }, 'notional_exceeded'],
    ['daily == cap', make({ amount: '10' }), { dailyVolume: { CC: '990' } }, {}, null],
    ['daily cap + 1 unit', make({ amount: '10' }), { dailyVolume: { CC: '990.0000000001' } }, {}, 'daily_volume_exceeded'],
    ['no daily cap', make(), {}, { maxDailyVolume: {} }, 'daily_volume_exceeded'],
    ['position == cap', make({ amount: '10' }), { positions: { CC: '490' } }, {}, null],
    ['position cap + 1 unit', make({ amount: '10' }), { positions: { CC: '490.0000000001' } }, {}, 'position_exceeded'],
    ['short position cap', make({ amount: '10', side: 'sell' }), { positions: { CC: '-490.0000000001' } }, {}, 'position_exceeded'],
    ['sell reduces long', make({ amount: '10', side: 'sell' }), { positions: { CC: '500' } }, {}, null],
    ['open orders count toward position', make({ amount: '10' }), { positions: { CC: '400' }, openOrders: [order('90.0000000001')] }, {}, 'position_exceeded'],
    // Opposite open orders do not net out: if only the buys fill, the long is 0 + 490 + 10 + 1e-10.
    ['an open sell does not offset open buys', make({ amount: '10' }), { openOrders: [order('490.0000000001'), order('490', 'sell')] }, {}, 'position_exceeded'],
    ['no position cap', make(), {}, { maxPosition: {} }, 'position_exceeded'],
    ['open orders below cap', make(), { openOrders: [order('1'), order('1')] }, {}, null],
    ['open orders at cap', make(), { openOrders: [order('1'), order('1'), order('1')] }, {}, 'open_orders_exceeded'],
    ['deviation == cap', make({ price: '0.1515' }), {}, { maxOrderNotional: { USDCx: '100' } }, null],
    ['deviation cap + 1 unit up', make({ price: '0.1515000001' }), {}, { maxOrderNotional: { USDCx: '100' } }, 'price_deviation_exceeded'],
    ['deviation cap + 1 unit down', make({ price: '0.1484999999' }), {}, {}, 'price_deviation_exceeded'],
    ['rate below cap', make(), { recentCommands: recent(4) }, {}, null],
    ['rate at cap', make(), { recentCommands: recent(5) }, {}, 'rate_limited'],
    ['old commands drop out', make(), { recentCommands: recent(5, NOW - 60_000) }, {}, null],
    ['zero amount', make({ amount: '0' }), {}, {}, 'no_rule'],
    ['malformed state decimal', make(), { positions: { CC: '1e3' } }, {}, 'no_rule'],
  ])('%s', (_, cmd, s, l, reason) => {
    expect(check(cmd, state(s), { ...limits, ...l }, NOW)).toEqual(reason ? { allow: false, reason } : { allow: true });
  });
});

describe('checkTake', () => {
  const o = { base: 'CC', quote: 'USDCx', side: 'buy' as const, price: '0.15' };
  it('prices at the maker price, held to reference', () => expect(checkTake({ orderId: 'x', amount: '100' }, o, state(), limits, NOW)).toEqual({ allow: true }));
  it('notional cap + 1 unit', () =>
    expect(checkTake({ orderId: 'x', amount: '100.0000000001' }, o, state(), { ...limits, maxOrderAmount: { CC: '200' } }, NOW)).toEqual({ allow: false, reason: 'notional_exceeded' }));
  it('no reference price', () =>
    expect(checkTake({ orderId: 'x', amount: '1' }, o, state({ referencePrices: {} }), limits, NOW)).toEqual({ allow: false, reason: 'price_deviation_exceeded' }));
});

describe('check: strategy.start', () => {
  const wide: Limits = { ...limits, maxOpenOrders: 10, maxOrderNotional: { USDCx: '1000' } };
  const grid = (c: Record<string, unknown> = {}): Command =>
    ({ method: 'strategy.start', params: { kind: 'grid', base: 'CC', quote: 'USDCx', config: { side: 'buy', levels: 10, amountPerLevel: '50', lowerPrice: '0.1485', upperPrice: '0.1515', ...c } } }) as Command;
  const dca = (c: Record<string, unknown> = {}): Command =>
    ({ method: 'strategy.start', params: { kind: 'dca', base: 'CC', quote: 'USDCx', config: { side: 'buy', amountPerOrder: '10', intervalSeconds: 3600, maxOrders: 24, ...c } } }) as Command;

  it.each<[string, Command, Partial<Limits>, string | null]>([
    ['grid fits: 10 x 50 = 500 position', grid(), {}, null],
    ['grid position + 1 unit', grid({ amountPerLevel: '50.0000000001' }), {}, 'position_exceeded'],
    ['grid daily volume', grid(), { maxDailyVolume: { CC: '499.9999999999' } }, 'daily_volume_exceeded'],
    ['grid levels over open orders', grid({ levels: 11, amountPerLevel: '1' }), {}, 'open_orders_exceeded'],
    ['grid level over order size', grid({ levels: 1, amountPerLevel: '100.0000000001' }), { maxPosition: { CC: '1000' } }, 'order_size_exceeded'],
    ['grid upper over notional', grid({ levels: 2 }), { maxOrderNotional: { USDCx: '7.5' } }, 'notional_exceeded'],
    ['grid band outside deviation', grid({ upperPrice: '0.1515000001' }), {}, 'price_deviation_exceeded'],
    ['grid inverted band', grid({ lowerPrice: '0.16', upperPrice: '0.15' }), {}, 'no_rule'],
    ['grid unknown config key', grid({ x: 1 }), {}, 'no_rule'],
    ['grid too many levels', grid({ levels: 101 }), {}, 'no_rule'],
    ['dca fits: 24 x 10 per day', dca(), { maxOpenOrders: 24 }, null],
    ['dca daily worst case', dca(), { maxOpenOrders: 24, maxDailyVolume: { CC: '239.9999999999' } }, 'daily_volume_exceeded'],
    ['dca capped by maxOrders', dca({ intervalSeconds: 60, maxOrders: 2 }), {}, null],
    ['dca interval too short', dca({ intervalSeconds: 59 }), {}, 'no_rule'],
    ['unknown kind config', { method: 'strategy.start', params: { kind: 'grid', base: 'CC', quote: 'USDCx', config: {} } } as Command, {}, 'no_rule'],
  ])('%s', (_, cmd, l, reason) => {
    expect(check(cmd, state(), { ...wide, ...l }, NOW)).toEqual(reason ? { allow: false, reason } : { allow: true });
  });
});

describe('property: emptyLimits allows no trade', () => {
  // Deterministic LCG so a failure reproduces.
  let seed = 42;
  const rnd = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) % n);
  const pick = <T>(xs: T[]) => xs[rnd(xs.length)]!;
  const num = () => `${rnd(1_000_000)}${rnd(2) ? `.${rnd(10_000)}` : ''}`;

  it('10k random trade commands are all denied', () => {
    for (let i = 0; i < 10_000; i++) {
      const base = pick(['CC', 'USDCx', 'CBTC']);
      const quote = pick(['CC', 'USDCx', 'CBTC']);
      const cmd = pick<Command>([
        make({ base, quote, side: pick(['buy', 'sell']), amount: num(), price: num() }),
        { method: 'order.take', params: { orderId: 'x', amount: num() } } as Command,
        { method: 'strategy.start', params: { kind: 'grid', base, quote, config: { side: 'buy', levels: 1 + rnd(100), amountPerLevel: num(), lowerPrice: num(), upperPrice: num() } } } as Command,
        { method: 'strategy.start', params: { kind: 'dca', base, quote, config: { side: 'sell', amountPerOrder: num(), intervalSeconds: 60 + rnd(10_000), maxOrders: 1 + rnd(100) } } } as Command,
      ]);
      const s = state({ referencePrices: { [`${base}/${quote}`]: num() } });
      expect(check(cmd, s, emptyLimits(), NOW).allow).toBe(false);
      expect(checkTake({ orderId: 'x', amount: num() }, { base, quote, side: 'buy', price: num() }, s, emptyLimits(), NOW).allow).toBe(false);
    }
  });
});

describe('USD caps', () => {
  const usd = (l: Partial<Limits>) => ({ ...limits, maxOrderAmount: { CC: '100000' }, maxOrderNotional: { USDCx: '100000' }, maxDailyVolume: { CC: '1000000' }, maxPosition: { CC: '1000000' }, ...l });
  const grid = (amountPerLevel: string, levels = 2): Command =>
    ({ method: 'strategy.start', params: { kind: 'grid', base: 'CC', quote: 'USDCx', config: { side: 'buy', levels, amountPerLevel, lowerPrice: '0.15', upperPrice: '0.15' } } }) as Command;

  it('denies a single order over perOrderUsd', () => {
    // 100 CC at $0.15 = $15 > $10
    expect(check(make({ amount: '100' }), state(), usd({ perOrderUsd: '10' }), NOW)).toEqual({ allow: false, reason: 'usd_order_exceeded' });
    expect(check(make({ amount: '60' }), state(), usd({ perOrderUsd: '10' }), NOW)).toEqual({ allow: true });
  });

  it('denies when fills of the last 24h + open orders + intents + this order exceed perDayUsd', () => {
    const s = state({
      fills: [{ at: NOW - 1000, instrument: 'CC', amount: '100' }, { at: NOW - 90_000_000, instrument: 'CC', amount: '10000' }],
      openOrders: [order('100')],
      intents: [{ key: 'k', pair: 'CC/USDCx', side: 'buy', amount: '100', price: '0.15', at: NOW }],
    });
    // fills $15 (old fill outside 24h ignored) + open $15 + intent $15 = $45; +$6 (40 CC) > $50
    expect(check(make({ amount: '40' }), s, usd({ perDayUsd: '50' }), NOW)).toEqual({ allow: false, reason: 'usd_daily_exceeded' });
    expect(check(make({ amount: '30' }), s, usd({ perDayUsd: '50' }), NOW)).toEqual({ allow: true });
  });

  it('counts an intent the daemon already merged into openOrders once', () => {
    const s = state({
      openOrders: [{ ...order('100'), orderId: 'intent:k' }],
      intents: [{ key: 'k', pair: 'CC/USDCx', side: 'buy', amount: '100', price: '0.15', at: NOW }],
    });
    // $15 reserved + $6 = $21 <= $25
    expect(check(make({ amount: '40' }), s, usd({ perDayUsd: '25' }), NOW)).toEqual({ allow: true });
  });

  it('denies without a USD price for the base instrument, or for an instrument already in use', () => {
    expect(check(make(), state({ usdPrices: {} }), usd({}), NOW)).toEqual({ allow: false, reason: 'usd_price_missing' });
    const s = state({ fills: [{ at: NOW - 1000, instrument: 'ETH', amount: '1' }] });
    expect(check(make(), s, usd({}), NOW)).toEqual({ allow: false, reason: 'usd_price_missing' });
  });

  it('denies when a USD cap is missing unless the owner opted out', () => {
    expect(check(make(), state(), usd({ perOrderUsd: undefined }), NOW)).toEqual({ allow: false, reason: 'usd_cap_missing' });
    expect(check(make(), state(), usd({ perDayUsd: undefined }), NOW)).toEqual({ allow: false, reason: 'usd_cap_missing' });
    expect(check(make(), state({ usdPrices: {} }), usd({ perOrderUsd: undefined, perDayUsd: undefined, usdCapsOptOut: true }), NOW)).toEqual({ allow: true });
  });

  it('checks strategy.start and order.take the same way', () => {
    expect(check(grid('100'), state(), usd({ perOrderUsd: '10' }), NOW)).toEqual({ allow: false, reason: 'usd_order_exceeded' });
    // two levels of 50 CC = $15 > $10 per day
    expect(check(grid('50'), state(), usd({ perDayUsd: '10' }), NOW)).toEqual({ allow: false, reason: 'usd_daily_exceeded' });
    expect(check(grid('10'), state({ usdPrices: {} }), usd({}), NOW)).toEqual({ allow: false, reason: 'usd_price_missing' });
    expect(checkTake({ orderId: 'x', amount: '100' }, { base: 'CC', quote: 'USDCx', side: 'buy', price: '0.15' }, state(), usd({ perOrderUsd: '10' }), NOW)).toEqual({ allow: false, reason: 'usd_order_exceeded' });
  });
});
