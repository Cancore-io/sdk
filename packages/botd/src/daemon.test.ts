import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDispatcher, start, type Deps } from './daemon';
import { connect } from './ipc/client';
import { DEFAULTS } from './config';
import { ERROR, JSONRPC_VERSION, type Method, type RpcRequest } from './protocol/index';
import type { BotState, Limits } from './types';

function fakeDeps(log: string[]) {
  let state: BotState = { partyId: 'bot::1220', locked: true, paused: false, openOrders: [], positions: {}, dailyVolume: {}, recentCommands: [], referencePrices: {} };
  const limits = { allowedPairs: ['CC/USDCx'] } as Limits;
  const audited: Record<string, unknown>[] = [];
  const deps: Deps = {
    keystore: {
      init: jest.fn(),
      initSeed: jest.fn(),
      unlock: jest.fn(async (pass: string) => {
        if (pass !== 'right') throw new Error('bad');
        return { destroy: jest.fn() } as never;
      }),
      lock: jest.fn(),
      isLocked: () => state.locked,
      publicKey: async () => 'ab',
    },
    audit: {
      append: jest.fn(async (e) => {
        log.push(`audit:${e.method}:${e.decision}`);
        audited.push(e);
        return e as never;
      }),
      verify: jest.fn(async () => ({ ok: true as const, entries: 0 })),
      tail: jest.fn(async () => []),
      close: jest.fn(async () => undefined),
    },
    state: { load: async () => state, save: async (s) => void (state = s), recordAudit: async () => undefined },
    limits: { load: async () => limits, save: jest.fn() },
    riskgate: jest.fn((cmd) => {
      log.push('riskgate');
      return (cmd.params as { amount: string }).amount === '1' ? { allow: true } : { allow: false, reason: 'order_size_exceeded' };
    }),
    createEngine: () => ({
      make: async () => (log.push('engine:make'), { orderId: 'o1' }),
      take: jest.fn(),
      cancel: jest.fn(async () => void log.push('engine:cancel')),
      order: jest.fn(),
      balances: jest.fn(),
      referencePrices: async () => ({}),
      withdraw: jest.fn(),
      findIntent: async () => undefined,
      quote: jest.fn(),
      register: async () => 'bot::1220',
      onboard: async () => 'bot::1220',
      start: jest.fn(),
      stop: jest.fn(async () => undefined),
    }),
    now: () => 1_000_000,
  };
  return { deps, audited, getState: () => state };
}

const req = <M extends Method>(method: M, params: unknown = {}): RpcRequest => ({ jsonrpc: JSONRPC_VERSION, id: 1, method, params: params as never });
const order = (amount: string) => req('order.make', { base: 'CC', quote: 'USDCx', side: 'buy', amount, price: '0.15' });

describe('dispatcher', () => {
  it('audits, then gates, then calls the engine', async () => {
    const log: string[] = [];
    const { deps } = fakeDeps(log);
    const d = createDispatcher(deps);
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    log.length = 0;
    const res = await d.handle(order('1'), { owner: false });
    expect(res).toMatchObject({ result: { order: { orderId: 'o1', status: 'open' } } });
    expect(log).toEqual(['riskgate', 'audit:order.make:allow', 'engine:make']);
  });

  it('denies a gated trade with the reason and never reaches the engine', async () => {
    const log: string[] = [];
    const { deps } = fakeDeps(log);
    const d = createDispatcher(deps);
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    log.length = 0;
    await expect(d.handle(order('5'), { owner: false })).rejects.toMatchObject({ code: ERROR.DENIED, data: { reason: 'order_size_exceeded' } });
    expect(log).toEqual(['riskgate', 'audit:order.make:deny']);
  });

  it('refuses trade while locked or paused', async () => {
    const log: string[] = [];
    const { deps } = fakeDeps(log);
    const d = createDispatcher(deps);
    await expect(d.handle(order('1'), { owner: false })).rejects.toMatchObject({ code: ERROR.LOCKED });
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    await d.handle(req('pause', { reason: 'x' }), { owner: false });
    await expect(d.handle(order('1'), { owner: false })).rejects.toMatchObject({ code: ERROR.PAUSED });
    expect(log).not.toContain('engine:make');
  });

  it('forbids owner methods from the agent side, and audits the attempt', async () => {
    const log: string[] = [];
    const { deps } = fakeDeps(log);
    const d = createDispatcher(deps);
    for (const m of ['unlock', 'lock', 'resume', 'limits.set'] as const) {
      const params = m === 'unlock' ? { passphrase: 'right' } : m === 'limits.set' ? { limits: {} } : {};
      await expect(d.handle(req(m, params), { owner: false })).rejects.toMatchObject({ code: ERROR.FORBIDDEN });
    }
    expect(deps.keystore.unlock).not.toHaveBeenCalled();
    expect(log).toEqual(['audit:unlock:deny', 'audit:lock:deny', 'audit:resume:deny', 'audit:limits.set:deny']);
  });

  it('never writes the passphrase to the audit log', async () => {
    const { deps, audited } = fakeDeps([]);
    const d = createDispatcher(deps);
    await expect(d.handle(req('unlock', { passphrase: 'wrong' }), { owner: true })).rejects.toMatchObject({ code: ERROR.LOCKED });
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    expect(JSON.stringify(audited)).not.toMatch(/right|wrong/);
    expect(audited.map((e) => e.decision)).toEqual(['allow', 'error', 'allow']);
  });
  it('a second unlock while unlocked does not start a second engine', async () => {
    const { deps } = fakeDeps([]);
    const create = jest.spyOn(deps, 'createEngine');
    const d = createDispatcher(deps);
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(deps.keystore.unlock).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the previous one is still running', async () => {
    const { deps } = fakeDeps([]);
    let fire: () => void = () => undefined;
    deps.every = (fn) => ((fire = fn), () => undefined);
    const d = createDispatcher(deps);
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const load = jest.fn(async () => (await gate, { allowedPairs: [] } as unknown as Limits));
    deps.limits.load = load;
    fire();
    fire();
    fire();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('start', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'botd-d-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves owner methods only on the owner socket', async () => {
    const { deps } = fakeDeps([]);
    const config = { ...DEFAULTS, clientsGroup: undefined as never, agentSocket: join(dir, 'bot.sock'), ownerSocket: join(dir, 'owner.sock') };
    const stop = await start(config, deps);
    try {
      const agent = await connect(config.agentSocket);
      await expect(agent.call('unlock', { passphrase: 'right' })).rejects.toMatchObject({ error: { code: ERROR.FORBIDDEN } });
      await expect(agent.call('status', {})).resolves.toMatchObject({ locked: true });
      agent.close();
      const owner = await connect(config.ownerSocket);
      await expect(owner.call('unlock', { passphrase: 'right' })).resolves.toEqual({ locked: false });
      owner.close();
    } finally {
      await stop();
    }
    expect(deps.keystore.lock).toHaveBeenCalled();
  });
});
