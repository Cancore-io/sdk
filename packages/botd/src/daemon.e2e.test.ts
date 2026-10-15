import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ed25519 } from '@noble/curves/ed25519';
import { cantonFingerprint } from '@cancore/wallet';
import { selfSendLeg } from '../../client/src/dvp-prepared.fixture';
import { defaultDeps, start } from './daemon';
import { connect, RpcCallError } from './ipc/client';
import { DEFAULTS, paths, type BotConfig } from './config';
import { createKeystore } from './keystore';
import { recomputeHash } from './verify';
import { ERROR } from './protocol/index';
import type { BotState } from './types';

/**
 * The daemon end to end: real keystore, audit log, state file, risk gate, engine and verifying
 * signer, over both sockets, against a fake API that answers the routes the SDK calls.
 */
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const OWNER = 'owner::1220aa';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

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
      if (route === 'GET /auto-trader/pairs') return json([{ id: 'p1', sourceToken: 'CC', targetToken: 'USDCx', marketRate: '0.15' }]);
      if (route === 'POST /orders') {
        const order = { ...body, id: `o${orders.size + 1}`, status: 'open' };
        orders.set(order.id, order);
        api.created.push(body);
        return json(order, 201);
      }
      const order = /^\/orders\/(o\d+)(\/cancel)?$/.exec(pathname);
      if (order && orders.has(order[1]!)) {
        if (order[2]) {
          api.cancelled.push(order[1]!);
          orders.get(order[1]!)!.status = 'cancelled';
        }
        return json(orders.get(order[1]!));
      }
      if (route === 'GET /orders/my') return json({ items: [], page: 1, pageSize: 100, total: 0 });
      if (route === 'GET /htlc/swaps') return json([]);
      if (pathname.startsWith('/tokens/balance/')) return json({ balance: '42.5' });
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
      baseUrl: 'http://api.test', network: 'devnet', ownerParty: OWNER, maxFee: '1',
    };
    delete (config as Partial<BotConfig>).clientsGroup;
    await createKeystore(paths(config).keystore).init(PHRASE, 'pass');
    writeFileSync(paths(config).limits, JSON.stringify(LIMITS), { mode: 0o600 });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('trades within limits, refuses past them, and signs only verified hashes', async () => {
    const stop = await boot();
    try {
      expect(await refusal(make('1'))).toMatchObject({ code: ERROR.LOCKED });
      await owner('unlock', { passphrase: 'pass' });

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
      await owner('unlock', { passphrase: 'pass' });
      expect(state()).toMatchObject({ openOrders: [], positions: { CC: '10' }, dailyVolume: { CC: '10' } });
    } finally {
      await stop();
    }
  });

  it('pause cancels the resting orders and refuses trades', async () => {
    const stop = await boot();
    try {
      await owner('unlock', { passphrase: 'pass' });
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
      await owner('unlock', { passphrase: 'pass' });
      expect(await refusal(make('1'))).toMatchObject({ code: ERROR.PAUSED });
    } finally {
      await stop();
      stderr.mockRestore();
    }
  });
});
