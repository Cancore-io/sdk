import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ed25519 } from '@noble/curves/ed25519';
import { cantonFingerprint } from '@cancore/wallet';
import { selfSendLeg } from '../../client/src/dvp-prepared.fixture';
import { DEFAULT_INSTRUMENT_ADMINS } from '../../client/src/dvp-admins';
import { createDispatcher, defaultDeps, start } from './daemon';
import { connect, RpcCallError } from './ipc/client';
import { DEFAULTS, paths, type BotConfig } from './config';
import { createKeystore } from './keystore';
import { recomputeHash } from './verify';
import { ERROR, JSONRPC_VERSION, type RpcRequest } from './protocol/index';
import type { BotState } from './types';

/**
 * The daemon end to end: real keystore, audit log, state file, risk gate, engine and verifying
 * signer, over both sockets, against a fake API that answers the routes the SDK calls.
 */
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const OWNER = 'owner::1220aa';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// devnet pins no USDCx admin: the configs below add this one.
const USDCX_ADMIN = 'usdcx-admin::1220ab';

function fakeApi() {
  let party = '';
  let publicKey = '';
  const orders = new Map<string, Record<string, unknown>>();
  const pending = new Map<string, { hash: string; bytes: string }>();
  const api = {
    created: [] as Record<string, unknown>[],
    cancelled: [] as string[],
    /** Hashes the API received signed, each checked against the bot's key. */
    signed: [] as { hash: string; bytes: string }[],
    tamper: false,
    /** POST accept of someone else's order: the answer is lost (fetch throws). */
    dropAccept: false,
    /** Whether the venue applied that accept before the answer was lost. */
    applyAccept: true,
    /** When set, decides each POST accept by attempt number (1-based) instead of dropAccept/applyAccept. */
    acceptScript: undefined as undefined | ((attempt: number) => 'lost-unapplied' | 'applied-then-400' | 'refused' | 'fee-holding'),
    accepts: 0,
    /** When set, a POST accept reports itself and waits here before the venue answers. */
    acceptHold: undefined as Promise<void> | undefined,
    atAccept: undefined as undefined | (() => void),
    /** When set, GET /orders/<id> lets `skip` reads pass, then waits on `gate`. */
    readHold: undefined as undefined | { id: string; skip: number; gate: Promise<void> },
    /** GET /orders/<id> per order: a reconcile is observable by its lookup. */
    reads: {} as Record<string, number>,
    orders,
    async fetch(url: string, init: RequestInit): Promise<Response> {
      const { pathname } = new URL(url);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const route = `${init.method} ${pathname}`;
      if (route === 'POST /auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-10-15 sig:1', expiresAt: Date.now() + 300_000 });
      if (route === 'POST /auth/login-signature') {
        publicKey = body.publicKey;
        party = `bot::${cantonFingerprint(publicKey)}`;
        return json({ token: `h.${Buffer.from(JSON.stringify({ sub: 'bot', exp: 4e9 })).toString('base64url')}.s`, user: { id: 'bot' } });
      }
      if (route === 'GET /auth/me') return json({ id: 'bot', partyId: party, publicKey, roles: ['user'], status: 'ACTIVE' });
      if (route === 'GET /auto-trader/pairs') return json([{ id: 'p1', sourceToken: 'CC', targetToken: 'USDCx', marketRate: '0.15', sourcePriceUsd: '0.15' }]);
      if (route === 'POST /orders') {
        const order = { ...body, id: `o${orders.size + 1}`, status: 'open' };
        orders.set(order.id, order);
        api.created.push(body);
        return json(order, 201);
      }
      const accepting = /^\/orders\/(x\d+)\/accept$/.exec(pathname);
      if (init.method === 'POST' && accepting && orders.has(accepting[1]!)) {
        api.accepts++;
        api.atAccept?.();
        await api.acceptHold;
        const step = api.acceptScript?.(api.accepts);
        if (step === 'lost-unapplied') throw new TypeError('fetch failed: the server was still in its handler');
        if (step === 'refused') return json({ statusCode: 400, message: 'Insufficient balance' }, 400);
        // Raised before the venue claims the order: the bot must hold its fee apart, and it cannot split USDCx.
        // A fee within the default 1.5 % ceiling of a 0.15 order, so the take gets as far as the split.
        if (step === 'fee-holding') return json({ statusCode: 409, message: 'refused', errorCode: 'DVP_FEE_HOLDING_REQUIRED', code: 'DVP_FEE_HOLDING_REQUIRED', payerPartyId: party, feeAmount: '0.002' }, 409);
        if (step === 'applied-then-400') {
          // The earlier attempt commits now; this one sees the order no longer open.
          Object.assign(orders.get(accepting[1]!)!, { status: 'accepted', opponentUserId: 'bot' });
          return json({ statusCode: 400, message: 'Order is not open' }, 400);
        }
        if (api.applyAccept) Object.assign(orders.get(accepting[1]!)!, { status: 'accepted', opponentUserId: 'bot' });
        if (api.dropAccept) throw new TypeError('fetch failed: the response was lost');
        return json(orders.get(accepting[1]!));
      }
      const order = /^\/orders\/([ox]\d+)(\/cancel)?$/.exec(pathname);
      if (order && orders.has(order[1]!)) {
        if (!order[2]) api.reads[order[1]!] = (api.reads[order[1]!] ?? 0) + 1;
        const hold = api.readHold;
        if (!order[2] && hold && hold.id === order[1] && hold.skip-- <= 0) await hold.gate;
        if (order[2]) {
          api.cancelled.push(order[1]!);
          orders.get(order[1]!)!.status = 'cancelled';
        }
        return json(orders.get(order[1]!));
      }
      if (route === 'GET /orders/my') return json({ items: [], page: 1, pageSize: 100, total: 0 });
      if (route === 'GET /htlc/swaps') return json([]);
      // A take reads the pair from the stand before it accepts (CAN-2979).
      if (route === 'GET /htlc/dvp/instruments') return json([{ id: 'CC', admin: DEFAULT_INSTRUMENT_ADMINS.devnet.Amulet![0] }, { id: 'USDCx', admin: USDCX_ADMIN }]);
      if (pathname.startsWith('/tokens/balance/')) return json({ balance: 42.5 });
      if (route === 'POST /wallet/operations/prepare' && body.type === 'tokens.send') {
        const { receiverPartyId: to, amount } = body.params;
        const honest = await selfSendLeg({ party, kind: 'transfer', receiver: to, input: '100', ids: 'a', outputs: [{ owner: to, amount }, { owner: party, amount: (100 - Number(amount)).toFixed(10) }] });
        const leg = { legId: 'l1', kind: 'transfer', preparedTransaction: honest.preparedTransaction, hash: honest.preparedTransactionHash };
        // A hostile API: the hash of a different transaction, paying someone else, next to honest bytes.
        if (api.tamper) {
          leg.hash = (await selfSendLeg({ party, kind: 'transfer', receiver: 'thief::1220', input: '100', ids: 'a', outputs: [{ owner: 'thief::1220', amount }] })).preparedTransactionHash;
        }
        pending.set('op1', { hash: leg.hash, bytes: leg.preparedTransaction });
        return json({ operationId: 'op1', legs: [leg], meta: {} });
      }
      if (route === 'POST /wallet/operations/submit') {
        const op = pending.get(body.operationId)!;
        const ok = ed25519.verify(Buffer.from(body.signatures[0].signature, 'base64'), Buffer.from(op.hash, 'base64'), Buffer.from(publicKey, 'hex'));
        if (!ok) return json({ message: 'bad signature' }, 400);
        api.signed.push(op);
        return json({ updateId: 'u1', outcome: 'committed' });
      }
      return json({ message: `no route ${route}` }, 404);
    },
  };
  return api;
}

const LIMITS = {
  allowedPairs: ['CC/USDCx'],
  maxOrderAmount: { CC: '100' },
  maxOrderNotional: { USDCx: '20' },
  maxDailyVolume: { CC: '1000' },
  maxPosition: { CC: '1000' },
  maxOpenOrders: 5,
  maxPriceDeviationBps: 500,
  maxCommandsPerMinute: 60,
  // Wide USD caps: these tests are about the other limits.
  perOrderUsd: '1000000',
  perDayUsd: '1000000',
};

describe('cancore-botd end to end', () => {
  let dir: string;
  let config: BotConfig;
  const api = fakeApi();
  const boot = async () => start(config, await defaultDeps(config, { fetchImpl: (u, i) => api.fetch(u, i), pollMs: 10, reconcileMs: 3_600_000 }));
  const call = async <T>(socket: string, method: string, params: unknown = {}): Promise<T> => {
    const c = await connect(socket);
    try {
      return (await c.call(method as never, params as never)) as T;
    } finally {
      c.close();
    }
  };
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: RpcCallError) => e.error);
  const owner = <T = unknown>(m: string, p?: unknown) => call<T>(config.ownerSocket, m, p);
  const agent = <T = unknown>(m: string, p?: unknown) => call<T>(config.agentSocket, m, p);
  const audit = () => readFileSync(paths(config).audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const state = () => JSON.parse(readFileSync(paths(config).state, 'utf8')) as BotState;
  const make = (amount: string) => agent('order.make', { base: 'CC', quote: 'USDCx', side: 'buy', amount, price: '0.15' });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'botd-e2e-'));
    config = {
      ...DEFAULTS, stateDir: dir, ownerSocket: join(dir, 'owner.sock'), agentSocket: join(dir, 'bot.sock'),
      baseUrl: 'https://api-dev.cancore.app', network: 'devnet', instrumentAdmins: { USDCx: [USDCX_ADMIN] }, ownerParty: OWNER, maxFee: '1',
    };
    delete (config as Partial<BotConfig>).clientsGroup;
    await createKeystore(paths(config).keystore).init(PHRASE, 'bot-pass-2026');
    writeFileSync(paths(config).limits, JSON.stringify(LIMITS), { mode: 0o600 });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('trades within limits, refuses past them, and signs only verified hashes', async () => {
    const stop = await boot();
    try {
      expect(await refusal(make('1'))).toMatchObject({ code: ERROR.LOCKED });
      await owner('unlock', { passphrase: 'bot-pass-2026' });

      const made = await make('10');
      expect(made).toMatchObject({ order: { orderId: 'o1', status: 'open' } });
      // buy 10 CC at 0.15: the bot gives 1.5 USDCx for 10 CC, through DvP.
      expect(api.created[0]).toMatchObject({ sourceTokenAddress: 'USDCx', sourceAmount: '1.5', targetTokenAddress: 'CC', targetAmount: '10', dvp: true });
      expect(audit()).toContainEqual(expect.objectContaining({ method: 'order.make', decision: 'allow' }));

      expect(await refusal(make('500'))).toMatchObject({ code: ERROR.DENIED, data: { reason: 'order_size_exceeded' } });
      expect(api.created).toHaveLength(1);

      expect(await agent('balances')).toEqual({ balances: [{ instrument: 'CC', amount: '42.5' }, { instrument: 'USDCx', amount: '42.5' }] });

      // Owner methods never pass the agent socket, and withdraw goes only to the pinned owner party.
      expect(await refusal(agent('withdraw', { to: OWNER, instrument: 'CC', amount: '1' }))).toMatchObject({ code: ERROR.FORBIDDEN });
      expect(await refusal(owner('withdraw', { to: 'thief::1220', instrument: 'CC', amount: '1' }))).toMatchObject({ code: ERROR.FORBIDDEN });

      expect(await owner('withdraw', { to: OWNER, instrument: 'CC', amount: '1' })).toEqual({ to: OWNER, instrument: 'CC', amount: '1' });
      expect(api.signed).toHaveLength(1);
      expect(recomputeHash(api.signed[0]!.bytes)).toBe(api.signed[0]!.hash);

      api.tamper = true;
      expect(await refusal(owner('withdraw', { to: OWNER, instrument: 'CC', amount: '1' }))).toBeDefined();
      api.tamper = false;
      expect(api.signed).toHaveLength(1);
    } finally {
      await stop();
    }
    expect(audit()).toContainEqual(expect.objectContaining({ method: 'settle', decision: 'deny', reason: 'verify_failed' }));
    expect(state().openOrders.map((o) => o.orderId)).toEqual(['o1']);
  });

  it('reconciles on restart: an order that filled while down moves into the position', async () => {
    api.orders.get('o1')!.status = 'completed';
    const stop = await boot();
    try {
      expect(await owner('status')).toMatchObject({ locked: true, paused: false });
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      // Unlock reconciles in the background.
      for (let i = 0; i < 100 && state().openOrders.length > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(state()).toMatchObject({ openOrders: [], positions: { CC: '10' }, dailyVolume: { CC: '10' } });
    } finally {
      await stop();
    }
  });

  it('pause cancels the resting orders and refuses trades', async () => {
    const stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await make('5');
      await agent('pause', { reason: 'test' });
      expect(api.cancelled).toEqual(['o2']);
      expect(state().openOrders).toEqual([]);
      expect(await refusal(make('5'))).toMatchObject({ code: ERROR.PAUSED });
      await owner('resume');
    } finally {
      await stop();
    }
  });

  it('a truncated audit log starts the daemon locked and paused', async () => {
    const lines = readFileSync(paths(config).audit, 'utf8').split('\n');
    writeFileSync(paths(config).audit, `${lines.slice(0, 3).join('\n')}\n`);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stop = await boot();
    try {
      expect(await owner('status')).toMatchObject({ locked: true, paused: true, pauseReason: 'audit log truncated or broken' });
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      expect(await refusal(make('1'))).toMatchObject({ code: ERROR.PAUSED });
    } finally {
      await stop();
      stderr.mockRestore();
    }
  });

  it('refuses a limits.set whose limits are not an object before the daemon handles it, and keeps the limits', async () => {
    const stored = readFileSync(paths(config).limits, 'utf8');
    const stop = await boot();
    try {
      const prior = await owner('limits.get');
      for (const limits of ['unlimited', 42, true, null, [1, 2]]) {
        expect(await refusal(owner('limits.set', { limits }))).toMatchObject({ code: ERROR.INVALID_PARAMS });
      }
      expect(await owner('limits.get')).toEqual(prior);
      expect(readFileSync(paths(config).limits, 'utf8')).toBe(stored);
      const handled = async () => (await owner<{ entries: { method: string }[] }>('audit.tail', { n: 1000 })).entries.filter((e) => e.method === 'limits.set');
      expect(await handled()).toEqual([]);
      // Control: a valid limits.set does reach the handler and is audited, so the empty list above means something.
      await owner('limits.set', { limits: LIMITS });
      expect(await handled()).toEqual([expect.objectContaining({ decision: 'allow' })]);
    } finally {
      await stop();
    }
  });
});

describe('cancore-botd end to end: an accept whose answer was lost (F128-LOST-ACCEPT-1)', () => {
  let dir: string;
  let config: BotConfig;
  const api = fakeApi();
  const boot = async () => start(config, await defaultDeps(config, { fetchImpl: (u, i) => api.fetch(u, i), pollMs: 10, reconcileMs: 3_600_000 }));
  const call = async <T>(socket: string, method: string, params: unknown = {}): Promise<T> => {
    const c = await connect(socket);
    try {
      return (await c.call(method as never, params as never)) as T;
    } finally {
      c.close();
    }
  };
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: RpcCallError) => e.error);
  const owner = <T = unknown>(m: string, p?: unknown) => call<T>(config.ownerSocket, m, p);
  const agent = <T = unknown>(m: string, p?: unknown) => call<T>(config.agentSocket, m, p);
  const state = () => JSON.parse(readFileSync(paths(config).state, 'utf8')) as BotState;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 250 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };
  const audit = () => readFileSync(paths(config).audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { params?: { orderId?: string; event?: string } });
  // Observable: the daemon audits the failed take step once serve's catch has run.
  const takeFailed = (orderId: string) => audit().some((e) => e.params?.event === 'take_failed' && e.params.orderId === orderId);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'botd-e2e-lost-'));
    config = {
      ...DEFAULTS, stateDir: dir, ownerSocket: join(dir, 'owner.sock'), agentSocket: join(dir, 'bot.sock'),
      baseUrl: 'https://api-dev.cancore.app', network: 'devnet', instrumentAdmins: { USDCx: [USDCX_ADMIN] }, ownerParty: OWNER, maxFee: '1',
    };
    delete (config as Partial<BotConfig>).clientsGroup;
    await createKeystore(paths(config).keystore).init(PHRASE, 'bot-pass-2026');
    // One take of 10 CC at 0.15 USD is 1.5 of the 2 USD day.
    writeFileSync(paths(config).limits, JSON.stringify({ ...LIMITS, perOrderUsd: '100', perDayUsd: '2' }), { mode: 0o600 });
    api.orders.set('x1', {
      id: 'x1', status: 'open', sourceNetwork: 'canton', targetNetwork: 'canton', dvp: true,
      initiatorUserId: 'someone', opponentUserId: null, swapId: null,
      sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: '10', targetTokenAddress: 'USDCx', targetTokenName: 'USDCx', targetAmount: '1.5',
      expiresAt: '', createdAt: '', updatedAt: '',
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the take booked through the uncertainty and counts the trade exactly once', async () => {
    let stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      api.dropAccept = true;
      expect(await agent('order.take', { orderId: 'x1', amount: '10' })).toMatchObject({ orderId: 'x1' });
      // The venue applied the accept; the bot only saw a network error.
      await until(() => api.accepts === 1 && takeFailed('x1'));
      // Paused before any reconcile: the take may be a trade, so its booking must survive.
      await owner('pause', { reason: 'owner stop' });
      expect(state().openOrders.map((o) => o.orderId)).toEqual(['x1']);
    } finally {
      await stop();
    }

    // The venue reports the trade done; the daemon reconciles it on the next unlock, twice over.
    api.orders.get('x1')!.status = 'completed';
    for (let round = 0; round < 2; round++) {
      stop = await boot();
      try {
        await owner('unlock', { passphrase: 'bot-pass-2026' });
        await until(() => state().openOrders.length === 0 && (state().fills ?? []).length === 1);
      } finally {
        await stop();
      }
    }
    const fills = state().fills ?? [];
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ instrument: 'CC', amount: '10', usdValue: '1.5' });
    expect(state().positions).toMatchObject({ CC: '10' });

    stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await owner('resume');
      // 1.5 USD already spent today: another 1.5 USD order passes the 2 USD day.
      expect(await refusal(agent('order.make', { base: 'CC', quote: 'USDCx', side: 'buy', amount: '10', price: '0.15' })))
        .toMatchObject({ code: ERROR.DENIED, data: { reason: 'usd_daily_exceeded' } });
    } finally {
      await stop();
    }
  });
  it('an accept that the venue never applied, then someone else completes the order, books no fill', async () => {
    // 2 CC (0.3 USD) fits what is left of the 2 USD day.
    api.orders.set('x2', { ...api.orders.get('x1')!, id: 'x2', status: 'open', opponentUserId: null, sourceAmount: '2', targetAmount: '0.3' });
    api.dropAccept = true;
    api.applyAccept = false;
    let stop = await boot();
    let before: { fills: number; positions: BotState['positions'] };
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await owner('resume').catch(() => undefined);
      before = { fills: (state().fills ?? []).length, positions: state().positions };
      expect(await agent('order.take', { orderId: 'x2', amount: '2' })).toMatchObject({ orderId: 'x2' });
      await until(() => takeFailed('x2'));
      // Ambiguous answer: the booking stays until the venue shows who took it.
      await owner('pause', { reason: 'owner stop' });
      expect(state().openOrders.map((o) => o.orderId)).toEqual(['x2']);
    } finally {
      await stop();
    }
    // Another account took and completed it: not our trade.
    Object.assign(api.orders.get('x2')!, { status: 'completed', opponentUserId: 'other' });
    stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await until(() => state().openOrders.length === 0);
    } finally {
      await stop();
    }
    expect((state().fills ?? []).length).toBe(before.fills);
    expect(state().positions).toEqual(before.positions);
  });
});

describe('cancore-botd end to end: a 400 after a lost accept answer (F128-ACCEPT-400-1)', () => {
  let dir: string;
  let config: BotConfig;
  const api = fakeApi();
  // A short reconcile, so serve retries the take after the first lost answer.
  const boot = async (reconcileMs = 20) => start(config, await defaultDeps(config, { fetchImpl: (u, i) => api.fetch(u, i), pollMs: 10, reconcileMs }));
  const call = async <T>(socket: string, method: string, params: unknown = {}): Promise<T> => {
    const c = await connect(socket);
    try {
      return (await c.call(method as never, params as never)) as T;
    } finally {
      c.close();
    }
  };
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: RpcCallError) => e.error);
  const owner = <T = unknown>(m: string, p?: unknown) => call<T>(config.ownerSocket, m, p);
  const agent = <T = unknown>(m: string, p?: unknown) => call<T>(config.agentSocket, m, p);
  const state = () => JSON.parse(readFileSync(paths(config).state, 'utf8')) as BotState;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 250 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };
  const audit = () => readFileSync(paths(config).audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { params?: { orderId?: string; event?: string } });
  const takeFailures = (orderId: string) => audit().filter((e) => e.params?.event === 'take_failed' && e.params.orderId === orderId).length;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'botd-e2e-400-'));
    config = {
      ...DEFAULTS, stateDir: dir, ownerSocket: join(dir, 'owner.sock'), agentSocket: join(dir, 'bot.sock'),
      baseUrl: 'https://api-dev.cancore.app', network: 'devnet', instrumentAdmins: { USDCx: [USDCX_ADMIN] }, ownerParty: OWNER, maxFee: '1',
    };
    delete (config as Partial<BotConfig>).clientsGroup;
    await createKeystore(paths(config).keystore).init(PHRASE, 'bot-pass-2026');
    writeFileSync(paths(config).limits, JSON.stringify({ ...LIMITS, perOrderUsd: '100', perDayUsd: '2' }), { mode: 0o600 });
    api.orders.set('x3', {
      id: 'x3', status: 'open', sourceNetwork: 'canton', targetNetwork: 'canton', dvp: true,
      initiatorUserId: 'someone', opponentUserId: null, swapId: null,
      sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: '10', targetTokenAddress: 'USDCx', targetTokenName: 'USDCx', targetAmount: '1.5',
      expiresAt: '', createdAt: '', updatedAt: '',
    });
    api.acceptScript = (attempt) => (attempt === 1 ? 'lost-unapplied' : 'applied-then-400');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the booking through the refusal and counts the trade exactly once', async () => {
    let stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      expect(await agent('order.take', { orderId: 'x3', amount: '10' })).toMatchObject({ orderId: 'x3' });
      // First answer lost, the order still read open, the retry got 400 while the first attempt landed.
      await until(() => api.accepts >= 2 && takeFailures('x3') >= 2);
      await owner('pause', { reason: 'owner stop' });
      expect(state().openOrders.map((o) => o.orderId)).toEqual(['x3']);
    } finally {
      await stop();
    }

    api.orders.get('x3')!.status = 'completed';
    for (let round = 0; round < 2; round++) {
      stop = await boot(3_600_000);
      try {
        await owner('unlock', { passphrase: 'bot-pass-2026' });
        await until(() => state().openOrders.length === 0 && (state().fills ?? []).length === 1);
      } finally {
        await stop();
      }
    }
    expect(state().fills).toEqual([expect.objectContaining({ instrument: 'CC', amount: '10', usdValue: '1.5' })]);
    expect(state().positions).toMatchObject({ CC: '10' });

    stop = await boot(3_600_000);
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await owner('resume');
      expect(await refusal(agent('order.make', { base: 'CC', quote: 'USDCx', side: 'buy', amount: '10', price: '0.15' })))
        .toMatchObject({ code: ERROR.DENIED, data: { reason: 'usd_daily_exceeded' } });
    } finally {
      await stop();
    }
  });
});

describe('cancore-botd end to end: an ambiguous take stays booked until the venue shows its outcome (F128-AMBIG-OPEN-1, F128-RELEASE-RISK-1)', () => {
  let dir: string;
  let config: BotConfig;
  const api = fakeApi();
  const boot = async () => start(config, await defaultDeps(config, { fetchImpl: (u, i) => api.fetch(u, i), pollMs: 10, reconcileMs: 3_600_000 }));
  const call = async <T>(socket: string, method: string, params: unknown = {}): Promise<T> => {
    const c = await connect(socket);
    try {
      return (await c.call(method as never, params as never)) as T;
    } finally {
      c.close();
    }
  };
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: RpcCallError) => e.error);
  const owner = <T = unknown>(m: string, p?: unknown) => call<T>(config.ownerSocket, m, p);
  const agent = <T = unknown>(m: string, p?: unknown) => call<T>(config.agentSocket, m, p);
  const state = () => JSON.parse(readFileSync(paths(config).state, 'utf8')) as BotState;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 250 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };
  const audit = () => readFileSync(paths(config).audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { params?: { orderId?: string; event?: string } });
  const event = (orderId: string, name: string) => audit().some((e) => e.params?.event === name && e.params.orderId === orderId);
  const order = (id: string) => ({
    id, status: 'open', sourceNetwork: 'canton', targetNetwork: 'canton', dvp: true,
    initiatorUserId: 'someone', opponentUserId: null, swapId: null,
    sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: '1', targetTokenAddress: 'USDCx', targetTokenName: 'USDCx', targetAmount: '0.15',
    expiresAt: '', createdAt: '', updatedAt: '',
  });
  const setup = async (prefix: string, limits: object) => {
    dir = mkdtempSync(join(tmpdir(), prefix));
    config = {
      ...DEFAULTS, stateDir: dir, ownerSocket: join(dir, 'owner.sock'), agentSocket: join(dir, 'bot.sock'),
      baseUrl: 'https://api-dev.cancore.app', network: 'devnet', instrumentAdmins: { USDCx: [USDCX_ADMIN] }, ownerParty: OWNER, maxFee: '1',
    };
    delete (config as Partial<BotConfig>).clientsGroup;
    await createKeystore(paths(config).keystore).init(PHRASE, 'bot-pass-2026');
    writeFileSync(paths(config).limits, JSON.stringify({ ...LIMITS, ...limits }), { mode: 0o600 });
  };
  /** One daemon run that reconciles the book once (unlock does) and has looked `id` up. */
  const reconcileOnce = async (id: string) => {
    const before = api.reads[id] ?? 0;
    const stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await until(() => (api.reads[id] ?? 0) > before);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await stop();
    }
  };
  /** A take whose accept answer is lost and which the venue never applied, then a pause. */
  const lostTake = async (id: string) => {
    api.dropAccept = true;
    api.applyAccept = false;
    const stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      expect(await agent('order.take', { orderId: id, amount: '1' })).toMatchObject({ orderId: id });
      await until(() => event(id, 'take_failed'));
      await owner('pause', { reason: 'owner stop' });
    } finally {
      await stop();
    }
    api.dropAccept = false;
    api.applyAccept = true;
  };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stays booked while the order reads open with no taker, and comes off with no fill once another account took it', async () => {
    await setup('botd-e2e-open-', { maxOpenOrders: 1, perOrderUsd: '100', perDayUsd: '100' });
    api.orders.set('x4', order('x4'));
    api.orders.set('x5', order('x5'));
    await lostTake('x4');
    // Reconciled twice, as long apart as it likes: open with no taker is not an outcome.
    await reconcileOnce('x4');
    await reconcileOnce('x4');
    expect(state().openOrders.map((o) => o.orderId)).toEqual(['x4']);
    // Another account takes it: off the book, nothing booked as ours.
    Object.assign(api.orders.get('x4')!, { status: 'accepted', opponentUserId: 'other' });
    await reconcileOnce('x4');
    expect(state().openOrders).toEqual([]);
    expect(event('x4', 'taken_by_other')).toBe(true);
    expect(state().fills ?? []).toEqual([]);
    expect(state().positions ?? {}).toEqual({});
    // The slot is free again.
    const stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await owner('resume');
      expect(await agent('order.take', { orderId: 'x5', amount: '1' })).toMatchObject({ orderId: 'x5' });
    } finally {
      await stop();
    }
  });

  it('keeps its full reservation until the outcome: a second take past the day is refused, the late trade is booked once', async () => {
    // 1 CC at 0.15 USD each: two of them pass the 0.2 USD day.
    await setup('botd-e2e-risk-', { perOrderUsd: '100', perDayUsd: '0.2' });
    api.orders.set('x6', order('x6'));
    api.orders.set('x7', order('x7'));
    await lostTake('x6');
    await reconcileOnce('x6');
    // A is still unresolved: B must not pass on budget A may yet spend.
    let stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await owner('resume');
      expect(await refusal(agent('order.take', { orderId: 'x7', amount: '1' }))).toMatchObject({ code: ERROR.DENIED, data: { reason: 'usd_daily_exceeded' } });
    } finally {
      await stop();
    }
    // The accept the venue was holding lands late and the trade completes: booked once, over two reconciles.
    Object.assign(api.orders.get('x6')!, { status: 'completed', opponentUserId: 'bot' });
    await reconcileOnce('x6');
    stop = await boot();
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await new Promise((r) => setTimeout(r, 100));
      expect(state().fills).toEqual([expect.objectContaining({ instrument: 'CC', amount: '1', usdValue: '0.15' })]);
      expect(state().positions).toMatchObject({ CC: '1' });
      expect(state().openOrders).toEqual([]);
      expect(await refusal(agent('order.make', { base: 'CC', quote: 'USDCx', side: 'buy', amount: '1', price: '0.15' })))
        .toMatchObject({ code: ERROR.DENIED, data: { reason: 'usd_daily_exceeded' } });
    } finally {
      await stop();
    }
  });
});

describe('cancore-botd end to end: a lock between a take and its booking (N-1)', () => {
  let dir: string;
  let config: BotConfig;
  const api = fakeApi();
  const state = () => JSON.parse(readFileSync(paths(config).state, 'utf8')) as BotState;
  const req = (method: string, params: unknown): RpcRequest => ({ jsonrpc: JSONRPC_VERSION, id: 1, method: method as never, params: params as never });
  const held = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
  };
  /** The real engine over the fake API; only the step from its take to the daemon's booking write is held. */
  async function dispatcher() {
    const deps = await defaultDeps(config, { fetchImpl: (u, i) => api.fetch(u, i), pollMs: 10, reconcileMs: 3_600_000 });
    const booking = held();
    let queued!: () => void;
    const taken = new Promise<void>((r) => (queued = r));
    const real = deps.createEngine;
    deps.createEngine = (signer, hooks) => {
      const e = real(signer, hooks);
      return { ...e, take: async (p) => { const r = await e.take(p); queued(); await booking.gate; return r; } };
    };
    const d = createDispatcher(deps);
    await d.handle(req('unlock', { passphrase: 'bot-pass-2026' }), { owner: true });
    return { d, deps, booking, taken };
  }
  const order = (id: string, amount: string, total: string) => ({
    id, status: 'open', sourceNetwork: 'canton', targetNetwork: 'canton', dvp: true,
    initiatorUserId: 'someone', opponentUserId: null, swapId: null,
    sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: amount, targetTokenAddress: 'USDCx', targetTokenName: 'USDCx', targetAmount: total,
    expiresAt: '', createdAt: '', updatedAt: '',
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'botd-e2e-n1-'));
    config = {
      ...DEFAULTS, stateDir: dir, ownerSocket: join(dir, 'owner.sock'), agentSocket: join(dir, 'bot.sock'),
      baseUrl: 'https://api-dev.cancore.app', network: 'devnet', instrumentAdmins: { USDCx: [USDCX_ADMIN] }, ownerParty: OWNER, maxFee: '1',
    };
    delete (config as Partial<BotConfig>).clientsGroup;
    await createKeystore(paths(config).keystore).init(PHRASE, 'bot-pass-2026');
    writeFileSync(paths(config).limits, JSON.stringify(LIMITS), { mode: 0o600 });
    api.orders.set('x1', order('x1', '10', '1.5'));
    api.orders.set('x2', order('x2', '2', '0.3'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('an accept already sent when the lock lands keeps the take booked as a trade, not dropped', async () => {
    const { d, deps, booking, taken } = await dispatcher();
    const accept = held();
    const atAccept = new Promise<void>((r) => (api.atAccept = r));
    api.acceptHold = accept.gate;
    try {
      const taking = d.handle(req('order.take', { orderId: 'x1', amount: '10' }), { owner: false });
      await taken;
      // serve's POST accept is out; the daemon has not booked the take yet.
      await atAccept;
      const locking = d.handle(req('lock', {}), { owner: true });
      await new Promise((r) => setImmediate(r));
      booking.release();
      await expect(taking).resolves.toMatchObject({ result: { orderId: 'x1' } });
      expect(state().openOrders.map((o) => o.orderId)).toEqual(['x1']);
      accept.release();
      await locking;
      expect(api.accepts).toBe(1);
    } finally {
      api.acceptHold = undefined;
      api.atAccept = undefined;
      await deps.audit.close();
    }
  });

  it('a take whose accept has not started when the lock lands is called off: LOCKED, and no accept goes out', async () => {
    const { d, deps, booking, taken } = await dispatcher();
    const read = held();
    // The gate's read of x2 passes; serve's first look at it waits, so its accept cannot have started.
    api.readHold = { id: 'x2', skip: 1, gate: read.gate };
    const accepts = api.accepts;
    try {
      const taking = d.handle(req('order.take', { orderId: 'x2', amount: '2' }), { owner: false });
      await taken;
      const locking = d.handle(req('lock', {}), { owner: true });
      await new Promise((r) => setImmediate(r));
      booking.release();
      await expect(taking).rejects.toMatchObject({ code: ERROR.LOCKED });
      read.release();
      await locking;
      expect(api.accepts).toBe(accepts);
      expect(state().openOrders.map((o) => o.orderId)).not.toContain('x2');
    } finally {
      api.readHold = undefined;
      await deps.audit.close();
    }
  });
});

describe('cancore-botd end to end: owner release of a booked take (CAN-2836, F128-RELEASE-AMBIGUOUS-1)', () => {
  let dir: string;
  let config: BotConfig;
  const api = fakeApi();
  const boot = async () => start(config, await defaultDeps(config, { fetchImpl: (u, i) => api.fetch(u, i), pollMs: 10, reconcileMs: 3_600_000 }));
  const call = async <T>(socket: string, method: string, params: unknown = {}): Promise<T> => {
    const c = await connect(socket);
    try {
      return (await c.call(method as never, params as never)) as T;
    } finally {
      c.close();
    }
  };
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: RpcCallError) => e.error);
  const owner = <T = unknown>(m: string, p?: unknown) => call<T>(config.ownerSocket, m, p);
  const agent = <T = unknown>(m: string, p?: unknown) => call<T>(config.agentSocket, m, p);
  const state = () => JSON.parse(readFileSync(paths(config).state, 'utf8')) as BotState;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 250 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };
  const audit = () => readFileSync(paths(config).audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { reason?: string; params?: { orderId?: string; event?: string } });
  const event = (orderId: string, name: string) => audit().some((e) => e.params?.event === name && e.params.orderId === orderId);
  const order = (id: string) => ({
    id, status: 'open', sourceNetwork: 'canton', targetNetwork: 'canton', dvp: true,
    initiatorUserId: 'someone', opponentUserId: null, swapId: null,
    sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: '1', targetTokenAddress: 'USDCx', targetTokenName: 'USDCx', targetAmount: '0.15',
    expiresAt: '', createdAt: '', updatedAt: '',
  });
  const mayBeTrade = { code: ERROR.INVALID_PARAMS, data: { reason: 'may_be_trade' } };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'botd-e2e-release-'));
    config = {
      ...DEFAULTS, stateDir: dir, ownerSocket: join(dir, 'owner.sock'), agentSocket: join(dir, 'bot.sock'),
      baseUrl: 'https://api-dev.cancore.app', network: 'devnet', instrumentAdmins: { USDCx: [USDCX_ADMIN] }, ownerParty: OWNER, maxFee: '1',
    };
    delete (config as Partial<BotConfig>).clientsGroup;
    await createKeystore(paths(config).keystore).init(PHRASE, 'bot-pass-2026');
    // Each order is 0.15 USD: one booked take leaves no room for a second in the 0.2 USD day.
    writeFileSync(paths(config).limits, JSON.stringify({ ...LIMITS, perOrderUsd: '100', perDayUsd: '0.2' }), { mode: 0o600 });
    for (const id of ['x1', 'x2', 'x3', 'x4']) api.orders.set(id, order(id));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a take whose accept the venue refused is released: no accept of ours is left that could land', async () => {
    const stop = await boot();
    api.acceptScript = () => 'refused';
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      expect(await agent('order.take', { orderId: 'x3', amount: '1' })).toMatchObject({ orderId: 'x3' });
      await until(() => event('x3', 'take_failed'));
      expect(await owner('order.release', { orderId: 'x3' })).toMatchObject({ orderId: 'x3', released: true });
      expect(state().openOrders).toEqual([]);
      expect(event('x3', 'released')).toBe(true);
    } finally {
      api.acceptScript = undefined;
      await stop();
    }
  });

  it('a take refused for a fee holding it cannot split is released: that refusal comes before the venue claims the order', async () => {
    const stop = await boot();
    api.acceptScript = () => 'fee-holding';
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      expect(await agent('order.take', { orderId: 'x4', amount: '1' })).toMatchObject({ orderId: 'x4' });
      await until(() => event('x4', 'take_failed'));
      expect(await owner('order.release', { orderId: 'x4' })).toMatchObject({ orderId: 'x4', released: true });
      expect(state().openOrders).toEqual([]);
    } finally {
      api.acceptScript = undefined;
      await stop();
    }
  });

  it('an accept whose answer was lost and that the venue applies only later: refused before and after its handler ends, and the reservation stops the next take', async () => {
    const stop = await boot();
    let answer!: () => void;
    api.acceptHold = new Promise<void>((r) => (answer = r));
    const sent = new Promise<void>((r) => (api.atAccept = r));
    // The answer is lost while the venue is still in its handler: the client sees an error, the venue has not claimed the order yet.
    api.acceptScript = () => 'lost-unapplied';
    const accepts = api.accepts;
    try {
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      expect(await agent('order.take', { orderId: 'x1', amount: '1' })).toMatchObject({ orderId: 'x1' });
      await sent;
      expect(await refusal(owner('order.release', { orderId: 'x1' }))).toMatchObject(mayBeTrade);
      answer();
      await until(() => event('x1', 'take_failed'));
      // The handler is over and the order still reads open with no taker: that accept can still claim it.
      expect(api.orders.get('x1')).toMatchObject({ status: 'open', opponentUserId: null });
      expect(await refusal(owner('order.release', { orderId: 'x1' }))).toMatchObject(mayBeTrade);
      expect(state().openOrders.map((o) => o.orderId)).toEqual(['x1']);
      // Still reserved: a second 0.15 USD take does not fit the 0.2 USD day.
      expect(await refusal(agent('order.take', { orderId: 'x2', amount: '1' }))).toMatchObject({ code: ERROR.DENIED, data: { reason: 'usd_daily_exceeded' } });

      // The venue claims the order for that first accept now, and the trade completes.
      Object.assign(api.orders.get('x1')!, { status: 'completed', opponentUserId: 'bot' });
      await owner('lock');
      await owner('unlock', { passphrase: 'bot-pass-2026' });
      await until(() => state().openOrders.length === 0 && (state().fills ?? []).length === 1);
      expect(state().fills).toEqual([expect.objectContaining({ instrument: 'CC', amount: '1', usdValue: '0.15' })]);
      expect(state().paused).toBe(false);
      expect(audit().some((e) => e.reason === 'unbooked_fill')).toBe(false);
      expect(api.accepts - accepts).toBe(1);
    } finally {
      api.acceptHold = undefined;
      api.atAccept = undefined;
      api.acceptScript = undefined;
      await stop();
    }
  });
});
