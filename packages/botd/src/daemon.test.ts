import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDispatcher, defaultDeps, start, type Deps } from './daemon';
import { connect } from './ipc/client';
import { DEFAULTS, loadConfig } from './config';
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
    createEngine: () => {
      // A cancelled order reads cancelled; the rest read open.
      const gone = new Set<string>();
      return {
      make: async () => (log.push('engine:make'), { orderId: 'o1' }),
      take: jest.fn(),
      untake: jest.fn(() => true),
      mayBeTrade: () => false,
      cancel: jest.fn(async (id: string) => void (log.push('engine:cancel'), gone.add(id))),
      // Our resting orders read open, so a pause or cancel takes them off the book.
      order: jest.fn(async (id: string) => ({ orderId: id, status: gone.has(id) ? 'cancelled' : 'open', source: 'CC', sourceAmount: '1', target: 'USDCx', targetAmount: '1' })),
      balances: jest.fn(),
      referencePrices: async () => ({}),
      usdPrices: async () => ({}),
      withdraw: jest.fn(),
      findIntent: async () => undefined,
      quote: jest.fn(),
      register: async () => 'bot::1220',
      onboard: async () => 'bot::1220',
      start: jest.fn(),
      stop: jest.fn(async () => undefined),
      };
    },
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

  it('two concurrent unlocks start one engine and check the passphrase once', async () => {
    const { deps } = fakeDeps([]);
    const create = jest.spyOn(deps, 'createEngine');
    const d = createDispatcher(deps);
    await Promise.all([d.handle(req('unlock', { passphrase: 'right' }), { owner: true }), d.handle(req('unlock', { passphrase: 'right' }), { owner: true })]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(deps.keystore.unlock).toHaveBeenCalledTimes(1);
  });

  it('a lock sent during an unlock wins: the daemon ends locked', async () => {
    const { deps } = fakeDeps([]);
    const d = createDispatcher(deps);
    const create = jest.spyOn(deps, 'createEngine');
    await Promise.all([d.handle(req('unlock', { passphrase: 'right' }), { owner: true }), d.handle(req('lock', {}), { owner: true })]);
    expect((await deps.state.load()).locked).toBe(true);
    // The key is gone too, not just the flag: the keystore was locked and the engine stopped.
    expect(deps.keystore.lock).toHaveBeenCalled();
    expect(create.mock.results[0]!.value.stop).toHaveBeenCalled();
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

describe('the strategy timer', () => {
  it('a lock stops it, so after lock and unlock exactly one runs (K11)', async () => {
    const { deps } = fakeDeps([]);
    const live = new Set<() => void>();
    deps.every = (fn) => (live.add(fn), () => void live.delete(fn));
    const d = createDispatcher(deps);
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    expect(live.size).toBe(1);
    await d.handle(req('lock', {}), { owner: true });
    expect(live.size).toBe(0);
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    expect(live.size).toBe(1);
  });
});

describe('the state directory', () => {
  it('is refused when another user owns it, even with mode 0700 (X5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botd-owner-'));
    const uid = jest.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    try {
      await expect(defaultDeps({ ...DEFAULTS, stateDir: dir })).rejects.toThrow(/owned by this user/);
    } finally {
      uid.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('pause against an in-flight order.make', () => {
  const held = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
  };
  async function unlockedWith(engineOverrides: Record<string, unknown>) {
    const { deps, getState, audited } = fakeDeps([]);
    const base = deps.createEngine;
    // The venue applies the cancel, so the order reads cancelled afterwards.
    const gone = new Set<string>();
    const cancel = jest.fn(async (id: string) => void gone.add(id));
    const order = async (id: string) => ({ orderId: id, status: gone.has(id) ? 'cancelled' : 'open', source: 'CC', sourceAmount: '1', target: 'USDCx', targetAmount: '1' });
    deps.createEngine = ((...a: Parameters<typeof base>) => ({ ...base(...a), cancel, order, ...engineOverrides })) as never;
    const d = createDispatcher(deps);
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    return { d, getState, cancel, deps, audited };
  }

  it('a lock while the gate loads its limits answers LOCKED, not an internal error (round-32 X-1)', async () => {
    const h = held();
    const make = jest.fn(async () => ({ orderId: 'o1' }));
    const { d, deps, getState, audited } = await unlockedWith({ make });
    const load = deps.limits.load;
    let reached!: () => void;
    const atLoad = new Promise<void>((r) => (reached = r));
    deps.limits.load = async () => (reached(), await h.gate, load());
    const commands = (getState().recentCommands ?? []).length;
    const sent = d.handle(order('1'), { owner: false });
    await atLoad;
    const locking = d.handle(req('lock', {}), { owner: true });
    await new Promise((r) => setImmediate(r));
    h.release();
    await locking;
    await expect(sent).rejects.toMatchObject({ code: ERROR.LOCKED });
    // The gate itself refused: nothing allowed, nothing counted, nothing sent.
    const makes = audited.filter((e) => e.method === 'order.make');
    expect(makes.map((e) => e.decision)).toEqual(['deny']);
    expect((getState().recentCommands ?? []).length).toBe(commands);
    expect(make).not.toHaveBeenCalled();
  });

  it('a lock while the make records its intent sends nothing to the API and leaves no intent (round-32 X-2)', async () => {
    const make = jest.fn(async () => ({ orderId: 'o1' }));
    const { d, deps, getState } = await unlockedWith({ make });
    const h = held();
    const save = deps.state.save;
    let reached!: () => void;
    const atWrite = new Promise<void>((r) => (reached = r));
    let armed = true;
    // Hold the first state write that carries the new intent: that is the make's unlessPaused write.
    deps.state.save = async (s) => {
      if (armed && (s.intents ?? []).length > 0) {
        armed = false;
        reached();
        await h.gate;
      }
      return save(s);
    };
    const sent = d.handle(order('1'), { owner: false });
    await atWrite;
    const locking = d.handle(req('lock', {}), { owner: true });
    await new Promise((r) => setImmediate(r));
    h.release();
    await locking;
    await expect(sent).rejects.toMatchObject({ code: ERROR.LOCKED });
    expect(make).not.toHaveBeenCalled();
    expect(getState().intents ?? []).toEqual([]);
    expect(getState().orderTimes ?? []).toEqual([]);
  });

  it('a make whose reference prices arrive after pause returned places nothing', async () => {
    const h = held();
    const make = jest.fn(async () => ({ orderId: 'o1' }));
    const { d, getState } = await unlockedWith({ referencePrices: async () => (await h.gate, {}), make });
    const sent = d.handle(order('1'), { owner: false });
    await expect(d.handle(req('pause', {}), { owner: true })).resolves.toMatchObject({ result: { paused: true } });
    h.release();
    await expect(sent).rejects.toMatchObject({ code: ERROR.PAUSED });
    expect(make).not.toHaveBeenCalled();
    expect(getState().openOrders).toEqual([]);
  });

  it.each([
    ['cancellable', true],
    ['not cancellable', false],
  ])('a make whose orderId arrives after an owner lock is treated as late (%s) (F-11)', async (_name, cancellable) => {
    const h = held();
    let sentToApi!: () => void;
    const reached = new Promise<void>((r) => (sentToApi = r));
    const { d, getState, cancel, deps } = await unlockedWith({
      make: async () => (sentToApi(), await h.gate, { orderId: 'late' }),
      ...(!cancellable && { cancel: jest.fn(async () => Promise.reject(new Error('ECONNRESET'))) }),
    });
    const sent = d.handle(order('1'), { owner: false });
    await reached;
    const locking = d.handle(req('lock', {}), { owner: true });
    // The key is wiped at once, before the held make answers.
    await new Promise((r) => setImmediate(r));
    expect(deps.keystore.lock).toHaveBeenCalled();
    h.release();
    await locking;
    // The lock waited for the trade queue: when it returns, the late make is already resolved.
    expect(getState().intents ?? []).toEqual([]);
    if (cancellable) {
      await expect(sent).rejects.toMatchObject({ code: ERROR.LOCKED });
      expect(cancel).toHaveBeenCalledWith('late');
      expect(getState().openOrders).toEqual([]);
    } else {
      // Not cancelled: a real order is never dropped, it stays booked as a trade.
      await sent.catch(() => undefined);
      expect(getState().openOrders.map((o) => o.orderId)).toEqual(['late']);
    }
    expect(getState().intents ?? []).toEqual([]);
    expect(getState().locked).toBe(true);
  });

  it('a make whose orderId arrives after pause returned is cancelled at once', async () => {
    const h = held();
    let sentToApi!: () => void;
    const reached = new Promise<void>((r) => (sentToApi = r));
    const { d, getState, cancel } = await unlockedWith({ make: async () => (sentToApi(), await h.gate, { orderId: 'late' }) });
    const sent = d.handle(order('1'), { owner: false });
    await reached;
    await d.handle(req('pause', {}), { owner: true });
    h.release();
    await expect(sent).rejects.toMatchObject({ code: ERROR.PAUSED });
    expect(cancel).toHaveBeenCalledWith('late');
    expect(getState().openOrders).toEqual([]);
    expect(getState().intents ?? []).toEqual([]);
  });

  it('an order booked after pause read its state but before pause wrote is still cancelled', async () => {
    const h = held();
    let sentToApi!: () => void;
    const reached = new Promise<void>((r) => (sentToApi = r));
    const { d, getState, cancel, deps } = await unlockedWith({ make: async () => (sentToApi(), await h.gate, { orderId: 'mid' }) });
    const sent = d.handle(order('1'), { owner: false });
    await reached;
    // Pause's first load is held with the snapshot taken before the make lands.
    const realLoad = deps.state.load;
    const snap = held();
    let first = true;
    deps.state.load = async () => {
      if (!first) return realLoad();
      first = false;
      const before = await realLoad();
      await snap.gate;
      return before;
    };
    const paused = d.handle(req('pause', {}), { owner: true });
    h.release();
    await sent;
    expect(getState().openOrders.map((o) => o.orderId)).toEqual(['mid']);
    snap.release();
    await paused;
    expect(cancel).toHaveBeenCalledWith('mid');
    expect(getState().openOrders).toEqual([]);
  });
});

describe('owner lock when the audit write fails', () => {
  it.each(['append', 'recordAudit'] as const)('drops the key and stops the engine first (%s fails)', async (which) => {
    const { deps } = fakeDeps([]);
    const signerDestroy = jest.fn();
    (deps.keystore.unlock as jest.Mock).mockImplementation(async () => ({ destroy: signerDestroy }));
    const create = jest.spyOn(deps, 'createEngine');
    const d = createDispatcher(deps);
    await d.handle(req('unlock', { passphrase: 'right' }), { owner: true });
    if (which === 'append') (deps.audit.append as jest.Mock).mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    else deps.state.recordAudit = async () => Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    await expect(d.handle(req('lock', {}), { owner: true })).rejects.toThrow(/locked.*audit/);
    expect(signerDestroy).toHaveBeenCalled();
    expect(deps.keystore.lock).toHaveBeenCalled();
    expect(create.mock.results[0]!.value.stop).toHaveBeenCalled();
  });
});

describe('the network comes from the API host (CAN-2979)', () => {
  it('refuses plain http to the dev host before any engine or API call', async () => {
    const fetchImpl = jest.fn();
    await expect(defaultDeps({ ...DEFAULTS, baseUrl: 'http://api-dev.cancore.app', stateDir: '/nonexistent-botd' }, { fetchImpl })).rejects.toThrow(/must be an https URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [{ baseUrl: 'https://unknown.example', network: undefined }],
    [{ baseUrl: 'https://unknown.example', network: 'mainnet' as const }],
    [{ baseUrl: 'https://api.cancore.io.example', network: undefined }],
  ])('refuses %j, a host that is not a Cancore API, before any engine or API call', async (over) => {
    const fetchImpl = jest.fn();
    // stateDir does not exist: the refusal must come first, before anything is opened.
    await expect(defaultDeps({ ...DEFAULTS, stateDir: '/nonexistent-botd', ...over }, { fetchImpl })).rejects.toThrow(/not a Cancore API host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [{ network: 'testnet' as const }],
    [{ network: 'mainnet' as const }],
    [{ baseUrl: 'https://api.cancore.io', network: 'devnet' as const }],
    [{ baseUrl: 'https://api-testnet.cancore.app', network: 'mainnet' as const }],
  ])('refuses %j: a network label that is not the host\'s', async (over) => {
    const fetchImpl = jest.fn();
    await expect(defaultDeps({ ...DEFAULTS, stateDir: '/nonexistent-botd', ...over }, { fetchImpl })).rejects.toThrow(/does not match/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['https://api-dev.cancore.app', undefined],
    ['https://api-testnet.cancore.app', undefined],
    ['https://api.cancore.io', undefined],
    ['https://api.cancore.io', 'mainnet' as const],
    ['https://api-testnet.cancore.app', 'testnet' as const],
  ])('starts on %s (network %s) without calling the API', async (baseUrl, network) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'botd-net-'));
    try {
      const fetchImpl = jest.fn();
      const deps = await defaultDeps({ ...DEFAULTS, stateDir, baseUrl, ...(network && { network }) }, { fetchImpl });
      expect(deps.createEngine).toEqual(expect.any(Function));
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('hands the config\'s extra pins to the engine, and nothing when the config sets none', async () => {
    const seen: Record<string, unknown>[] = [];
    jest.resetModules();
    jest.doMock('./engine/index', () => ({ ...jest.requireActual('./engine/index'), createEngine: (o: Record<string, unknown>) => (seen.push(o), {}) }));
    const { defaultDeps: withFakeEngine } = await import('./daemon');
    const stateDir = mkdtempSync(join(tmpdir(), 'botd-pins-'));
    try {
      const pins = { network: 'testnet' as const, instrumentAdmins: { Amulet: ['DSO::1220aa'] }, networkFeeRecipients: ['op::1220bb'] };
      (await withFakeEngine({ ...DEFAULTS, stateDir, baseUrl: 'https://api-testnet.cancore.app', ...pins })).createEngine({} as never, {} as never);
      (await withFakeEngine({ ...DEFAULTS, stateDir, baseUrl: 'https://api.cancore.io' })).createEngine({} as never, {} as never);
      expect(seen[0]).toMatchObject({ baseUrl: 'https://api-testnet.cancore.app', ...pins });
      expect(seen[1]).toMatchObject({ baseUrl: 'https://api.cancore.io' });
      expect(seen[1]).not.toHaveProperty('instrumentAdmins');
      expect(seen[1]).not.toHaveProperty('networkFeeRecipients');
    } finally {
      jest.dontMock('./engine/index');
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    [{ baseUrl: 'https://api.cancore.io', network: 'devnet' }],
    [{ baseUrl: 'https://api-dev.cancore.app', network: 'mainnet' }],
  ])('refuses a loaded config %j: the host decides, a label cannot move it', async (file) => {
    const d = mkdtempSync(join(tmpdir(), 'botd-cfg-'));
    try {
      const path = join(d, 'config.json');
      writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
      const fetchImpl = jest.fn();
      await expect(defaultDeps({ ...loadConfig(path), stateDir: '/nonexistent-botd' }, { fetchImpl })).rejects.toThrow(/does not match/);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses a state dir owned by another user, even with mode 0700 (X5, CAN-2833)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'botd-uid-'));
    const uid = jest.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    try {
      await expect(defaultDeps({ ...DEFAULTS, stateDir: d })).rejects.toThrow(/owned by this user/);
    } finally {
      uid.mockRestore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('defaults to the dev API: mainnet, with real funds, only by an explicit baseUrl', () => {
    expect(DEFAULTS).toMatchObject({ baseUrl: 'https://api-dev.cancore.app' });
    expect(DEFAULTS).not.toHaveProperty('network');
  });
});
