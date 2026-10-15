import { createDispatcher, type Deps } from '../daemon';
import { initialState } from '../state';
import { check } from '../riskgate';
import { JSONRPC_VERSION, type Method, type RpcRequest } from '../protocol/index';
import type { BotState, Limits } from '../types';
import { gridPrice } from './grid';

const LIMITS: Limits = {
  allowedPairs: ['CC/USDCx'],
  maxOrderAmount: { CC: '100' },
  maxOrderNotional: { USDCx: '100' },
  maxDailyVolume: { CC: '10000' },
  maxPosition: { CC: '10000' },
  maxOpenOrders: 10,
  maxPriceDeviationBps: 2000,
  maxCommandsPerMinute: 600,
};

/** Fake engine, fake clock, a ticker the test drives; state survives `restart()` like the file would. */
function world(limits: Limits = LIMITS, ordersPerHour = 60) {
  let state: BotState = initialState();
  let clock = 1_000_000;
  let seq = 0;
  const made: { orderId: string; side: string; price: string }[] = [];
  const cancelled: string[] = [];
  const statuses: Record<string, string> = {};
  let ticker: (() => void) | undefined;
  const audited: { method: string; decision: string; reason?: string }[] = [];
  let hooks: Parameters<Deps['createEngine']>[1] | undefined;
  const crash = { make: false, found: undefined as string | undefined };
  const deps = (): Deps => ({
    keystore: { init: jest.fn(), initSeed: jest.fn(), unlock: async () => ({ destroy: () => undefined }) as never, lock: () => undefined, isLocked: () => false, publicKey: async () => 'ab' },
    audit: {
      append: async (e) => (audited.push(e as never), e as never),
      verify: async () => ({ ok: true as const, entries: 0 }),
      tail: async () => [],
      close: async () => undefined,
    },
    state: { load: async () => state, save: async (s) => void (state = s), recordAudit: async () => undefined },
    limits: { load: async () => limits, save: jest.fn() },
    riskgate: check,
    createEngine: (_signer, h) => {
      hooks = h;
      return {
        make: async (p) => {
          const orderId = `o${++seq}`;
          // The API created the order, the answer never reached the daemon.
          if (crash.make) throw new Error('socket hang up');
          made.push({ orderId, side: p.side, price: p.price });
          return { orderId };
        },
        take: jest.fn(),
        cancel: async (id) => void cancelled.push(id),
        order: async (id) => ({ orderId: id, status: statuses[id] ?? 'open', source: 'CC', sourceAmount: '1', target: 'USDCx', targetAmount: '1' }),
        balances: jest.fn(),
        referencePrices: async () => ({ 'CC/USDCx': '0.15' }),
        withdraw: jest.fn(),
        findIntent: async () => crash.found,
        quote: jest.fn(),
        register: async () => 'bot::1220',
        onboard: async () => 'bot::1220',
        start: () => undefined,
        stop: async () => undefined,
      };
    },
    now: () => clock,
    ordersPerHour,
    every: (fn) => ((ticker = fn), () => (ticker = undefined)),
  });
  let d = createDispatcher(deps());
  const call = (method: Method, params: unknown = {}, owner = true) =>
    d.handle({ jsonrpc: JSONRPC_VERSION, id: 1, method, params: params as never } as RpcRequest, { owner });
  // The tick runs on the dispatcher's background chain; a macrotask lets it finish.
  const tick = async () => {
    ticker!();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    crash,
    call,
    tick,
    made,
    cancelled,
    audited,
    statuses,
    state: () => state,
    advance: (ms: number) => void (clock += ms),
    fill: async (orderId: string) => {
      hooks!.onSettled(orderId);
      await new Promise((r) => setTimeout(r, 0));
    },
    unlock: () => call('unlock', { passphrase: 'x' }),
    restart: async () => {
      await d.lock();
      d = createDispatcher(deps());
    },
  };
}

const grid = { kind: 'grid', base: 'CC', quote: 'USDCx', config: { side: 'buy', levels: 3, amountPerLevel: '10', lowerPrice: '0.14', upperPrice: '0.16' } };
const strategyOf = (w: ReturnType<typeof world>) => w.state().strategies![0]!;

describe('grid', () => {
  it('places one order per level, spaced from lower to upper', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', grid, false);
    for (let i = 0; i < 5; i++) await w.tick();
    expect(w.made.map((m) => [m.side, m.price])).toEqual([['buy', '0.14'], ['buy', '0.15'], ['buy', '0.16']]);
    expect(w.state().openOrders.map((o) => o.strategy?.slot)).toEqual(['0:buy', '1:buy', '2:buy']);
    // Every strategy order went through the gate and the audit log like an agent's.
    expect(w.audited.filter((a) => a.method === 'order.make' && a.decision === 'allow')).toHaveLength(3);
  });

  it('never has more open orders than maxOpenOrders', async () => {
    const w = world({ ...LIMITS, maxOpenOrders: 3 });
    await w.unlock();
    await w.call('strategy.start', grid, false);
    await w.tick();
    // An agent's order takes a slot the grid would have used.
    await w.call('order.make', { base: 'CC', quote: 'USDCx', side: 'buy', amount: '1', price: '0.15' }, false);
    for (let i = 0; i < 5; i++) await w.tick();
    expect(w.state().openOrders).toHaveLength(3);
    expect(strategyOf(w).status).toBe('running');
  });

  it('a filled buy is sold one level up; a filled sell bought back one level down', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', grid, false);
    for (let i = 0; i < 3; i++) await w.tick();
    await w.fill('o1');
    await w.tick();
    expect(w.made.at(-1)).toMatchObject({ side: 'sell', price: '0.15' });
    await w.fill('o4');
    await w.tick();
    expect(w.made.at(-1)).toMatchObject({ side: 'buy', price: '0.14' });
    expect(strategyOf(w).fills).toBe(2);
  });

  it('a deny stops placing and records the reason; the daemon carries on', async () => {
    const w = world({ ...LIMITS, maxPriceDeviationBps: 500 });
    await w.unlock();
    await w.call('strategy.start', { ...grid, config: { ...grid.config, lowerPrice: '0.15', upperPrice: '0.15' } }, false);
    // The started config passed the gate; a level outside the deviation band (as after a price move) is refused.
    strategyOf(w).config = { ...grid.config, lowerPrice: '0.10', upperPrice: '0.10' };
    await w.tick();
    await w.tick();
    expect(w.made).toHaveLength(0);
    expect(strategyOf(w)).toMatchObject({ status: 'denied', reason: 'price_deviation_exceeded' });
    expect(w.audited.filter((a) => a.method === 'order.make')).toEqual([expect.objectContaining({ decision: 'deny', reason: 'price_deviation_exceeded' })]);
    expect(await w.call('status')).toMatchObject({ result: { strategies: [{ running: false, status: 'denied' }] } });
  });

  it('resumes after a restart without placing a level twice', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', grid, false);
    await w.tick();
    await w.tick();
    await w.restart();
    await w.unlock();
    for (let i = 0; i < 5; i++) await w.tick();
    expect(w.made.map((m) => m.price)).toEqual(['0.14', '0.15', '0.16']);
  });

  it('a fill while the daemon was down is refilled after the restart', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', grid, false);
    for (let i = 0; i < 3; i++) await w.tick();
    await w.restart();
    w.statuses.o2 = 'completed';
    await w.unlock();
    await w.tick();
    expect(w.made.at(-1)).toMatchObject({ side: 'sell', price: '0.16' });
  });

  it('strategy.stop cancels its open orders and places no more', async () => {
    const w = world();
    await w.unlock();
    const { result } = (await w.call('strategy.start', grid, false)) as { result: { strategyId: string } };
    await w.tick();
    await w.tick();
    await w.call('strategy.stop', { strategyId: result.strategyId }, false);
    await w.tick();
    expect(w.cancelled).toEqual(['o1', 'o2']);
    expect(w.state().openOrders).toEqual([]);
    expect(w.made).toHaveLength(2);
    expect(strategyOf(w).status).toBe('stopped');
  });

  it('pause stops the loop and cancels its orders', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', grid, false);
    await w.tick();
    await w.call('pause', {}, true);
    await w.tick();
    expect(w.cancelled).toEqual(['o1']);
    expect(w.made).toHaveLength(1);
    expect(strategyOf(w)).toMatchObject({ status: 'stopped', reason: 'paused' });
  });

  it('waits as rate_limited once its hourly budget is spent', async () => {
    const w = world(LIMITS, 2);
    await w.unlock();
    await w.call('strategy.start', grid, false);
    for (let i = 0; i < 4; i++) await w.tick();
    expect(w.made).toHaveLength(2);
    expect(strategyOf(w)).toMatchObject({ status: 'rate_limited', reason: 'rate_limited' });
    w.advance(3_600_001);
    await w.tick();
    expect(w.made).toHaveLength(3);
    expect(strategyOf(w).status).toBe('running');
  });

  it('gridPrice spaces levels exactly', () => {
    expect(gridPrice({ side: 'buy', levels: 4, amountPerLevel: '1', lowerPrice: '1', upperPrice: '2' }, 1)).toBe('1.3333333333');
  });
});

describe('dca', () => {
  const dca = { kind: 'dca', base: 'CC', quote: 'USDCx', config: { side: 'buy', amountPerOrder: '10', intervalSeconds: 600, maxOrders: 3 } };

  it('one order per interval at the reference price, up to maxOrders', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', dca, false);
    await w.tick();
    await w.tick();
    expect(w.made).toHaveLength(1);
    w.advance(599_000);
    await w.tick();
    expect(w.made).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      w.advance(600_000);
      await w.tick();
    }
    expect(w.made.map((m) => m.price)).toEqual(['0.15', '0.15', '0.15']);
    expect(w.state().openOrders.map((o) => o.strategy?.slot)).toEqual(['0', '1', '2']);
    expect(strategyOf(w).status).toBe('done');
  });

  it('resumes its seq after a restart', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', dca, false);
    await w.tick();
    await w.restart();
    await w.unlock();
    await w.tick();
    expect(w.made).toHaveLength(1);
    w.advance(600_000);
    await w.tick();
    expect(w.state().openOrders.map((o) => o.strategy?.slot)).toEqual(['0', '1']);
  });
});

describe('one hourly order budget, agent and strategies together', () => {
  const make = { base: 'CC', quote: 'USDCx', side: 'buy', amount: '1', price: '0.15' };

  it('agent orders spend the budget a strategy then waits on, and the agent is refused past it', async () => {
    const w = world(LIMITS, 3);
    await w.unlock();
    await w.call('order.make', make, false);
    await w.call('order.make', make, false);
    await w.call('strategy.start', grid, false);
    for (let i = 0; i < 3; i++) await w.tick();
    expect(w.made).toHaveLength(3);
    expect(strategyOf(w)).toMatchObject({ status: 'rate_limited', reason: 'rate_limited' });
    await expect(w.call('order.make', make, false)).rejects.toMatchObject({ data: { reason: 'rate_limited' } });
    w.advance(3_600_001);
    await w.call('order.make', make, false);
    expect(w.made).toHaveLength(4);
  });
});

describe('a strategy order cancelled by hand', () => {
  it('is not placed again, and status shows the slot', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', grid, false);
    for (let i = 0; i < 3; i++) await w.tick();
    await w.call('order.cancel', { orderId: 'o2' }, false);
    for (let i = 0; i < 3; i++) await w.tick();
    expect(w.made).toHaveLength(3);
    expect(strategyOf(w)).toMatchObject({ status: 'running', cancelled: ['1:buy'] });
    expect(await w.call('status')).toMatchObject({ result: { strategies: [{ cancelledByUser: ['1:buy'] }] } });
  });

  it('nor when it was cancelled outside the daemon', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', grid, false);
    for (let i = 0; i < 3; i++) await w.tick();
    await w.restart();
    w.statuses.o3 = 'cancelled';
    await w.unlock();
    for (let i = 0; i < 3; i++) await w.tick();
    expect(w.made).toHaveLength(3);
    expect(strategyOf(w).cancelled).toEqual(['2:buy']);
  });
});

describe('an order whose answer was lost', () => {
  const make = { base: 'CC', quote: 'USDCx', side: 'buy', amount: '1', price: '0.15' };

  it('is on disk as an intent before the API call, and counts as open for the gate', async () => {
    const w = world({ ...LIMITS, maxOpenOrders: 1 });
    await w.unlock();
    w.crash.make = true;
    await expect(w.call('order.make', make, false)).rejects.toBeDefined();
    expect(w.state().intents).toEqual([expect.objectContaining({ pair: 'CC/USDCx', side: 'buy', amount: '1', price: '0.15' })]);
    w.crash.make = false;
    await expect(w.call('order.make', make, false)).rejects.toMatchObject({ data: { reason: 'open_orders_exceeded' } });
  });

  it('is adopted on the next unlock when the API has it', async () => {
    const w = world();
    await w.unlock();
    w.crash.make = true;
    await expect(w.call('order.make', make, false)).rejects.toBeDefined();
    w.crash.make = false;
    await w.restart();
    w.crash.found = 'o1';
    await w.unlock();
    expect(w.state().intents).toEqual([]);
    expect(w.state().openOrders).toEqual([expect.objectContaining({ orderId: 'o1', pair: 'CC/USDCx' })]);
    expect(w.audited).toContainEqual(expect.objectContaining({ method: 'settle', params: expect.objectContaining({ event: 'intent_adopted', orderId: 'o1' }) }));
  });

  it('is dropped when the API has none, and its strategy placement undone', async () => {
    const w = world();
    await w.unlock();
    await w.call('strategy.start', grid, false);
    w.crash.make = true;
    await w.tick();
    // An error the daemon cannot read stops the strategy; the intent waits for the next unlock.
    expect(strategyOf(w)).toMatchObject({ status: 'failed', placed: [expect.any(Number)] });
    expect(w.state().intents?.[0]?.strategy?.slot).toBe('0:buy');
    w.crash.make = false;
    await w.restart();
    await w.unlock();
    expect(w.state().intents).toEqual([]);
    expect(w.state().openOrders).toEqual([]);
    expect(strategyOf(w).placed).toEqual([]);
  });
});

describe('onboarding', () => {
  it('the first unlock onboards the account and status shows its party', async () => {
    const w = world();
    await w.unlock();
    await w.tick();
    expect(w.state().partyId).toBe('bot::1220');
    expect(await w.call('status')).toMatchObject({ result: { partyId: 'bot::1220' } });
  });

  it('register is owner-only and its invite code is never audited', async () => {
    const w = world();
    await w.unlock();
    await expect(w.call('register', { inviteCode: 'SECRET' }, false)).rejects.toMatchObject({ message: 'forbidden' });
    expect(await w.call('register', { inviteCode: 'SECRET' })).toMatchObject({ result: { partyId: 'bot::1220' } });
    expect(JSON.stringify(w.audited)).not.toContain('SECRET');
  });
});
