import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDispatcher, defaultDeps, type Deps } from '../../src/daemon';
import { DEFAULTS, paths, type BotConfig } from '../../src/config';
import { JSONRPC_VERSION, type Method, type RpcRequest } from '../../src/protocol/index';
import type { AuditEntry, BotSigner, BotState, Engine, EngineHooks, OrderInfo } from '../../src/types';

/** Shared attacker rig: the real audit log, state file, limits file and risk gate in a private temp dir; a fake engine. */

export const LIMITS = {
  allowedPairs: ['CC/USDCx'],
  maxOrderAmount: { CC: '100' },
  maxOrderNotional: { USDCx: '20' },
  maxDailyVolume: { CC: '300' },
  maxPosition: { CC: '1000' },
  maxOpenOrders: 5,
  maxPriceDeviationBps: 500,
  maxCommandsPerMinute: 60,
  // Wide USD caps: these tests are about the other limits.
  perOrderUsd: '1000000',
  perDayUsd: '1000000',
};

export const fakeSigner = (): BotSigner => ({ public_key: 'ab', signMessage: async () => 's', signPreparedHash: async () => 's', destroy: () => undefined });

export interface FakeEngine extends Engine {
  made: unknown[];
  taken: unknown[];
  orders: Map<string, OrderInfo>;
  /** Delay of each make, to widen race windows. */
  makeDelayMs: number;
  /** When set, every make waits for it: a test decides exactly when the API answers. */
  makeHold?: Promise<void>;
  /** Called when a make reaches the API, before it waits. */
  onMakeStart?: () => void;
}

export function fakeEngine(): FakeEngine {
  let n = 0;
  const e: FakeEngine = {
    made: [], taken: [], orders: new Map(), makeDelayMs: 0,
    async make(p) {
      e.onMakeStart?.();
      await new Promise((r) => setTimeout(r, e.makeDelayMs));
      await e.makeHold;
      e.made.push(p);
      return { orderId: `o${++n}` };
    },
    async take(p) {
      e.taken.push(p);
      return { orderId: p.orderId, filled: '0' };
    },
    async cancel() {},
    async order(id) {
      const o = e.orders.get(id);
      if (!o) throw new Error('404');
      return o;
    },
    async balances() { return []; },
    async referencePrices() { return { 'CC/USDCx': '0.15', 'USDCx/CC': '6.6666666666' }; },
    usdPrices: async () => ({ CC: '0.15', USDCx: '1' }),
    async withdraw() {},
    async findIntent() { return undefined; },
    async quote(p) { return { ...p, price: '0.15', total: '0', expiresInSec: 30 }; },
    async register() { return 'bot::1220'; },
    async onboard() { return 'bot::1220'; },
    start() {},
    async stop() {},
  };
  return e;
}

export interface Rig {
  dir: string;
  config: BotConfig;
  deps: Deps;
  engine: FakeEngine;
  dispatcher: ReturnType<typeof createDispatcher>;
  audit(): AuditEntry[];
  state(): BotState;
  unlock(): Promise<void>;
  cleanup(): Promise<void>;
  /** The hooks the daemon gave the engine: a test fires settlements through them. */
  hooks(): EngineHooks;
}

export async function rig(limits: unknown = LIMITS, keystore?: Deps['keystore']): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'botd-sec-'));
  const config: BotConfig = { ...DEFAULTS, stateDir: dir, ownerSocket: join(dir, 'owner.sock'), agentSocket: join(dir, 'bot.sock'), ownerParty: 'owner::1220aa' };
  delete (config as Partial<BotConfig>).clientsGroup;
  writeFileSync(paths(config).limits, JSON.stringify(limits), { mode: 0o600 });
  const engine = fakeEngine();
  let hooks: EngineHooks | undefined;
  const real = await defaultDeps(config);
  const deps: Deps = {
    ...real,
    keystore: keystore ?? {
      init: async () => undefined,
      initSeed: async () => undefined,
      unlock: async (p) => {
        if (p !== 'right') throw new Error('bad');
        return fakeSigner();
      },
      lock: () => undefined,
      isLocked: () => false,
      publicKey: async () => 'ab',
    },
    createEngine: (_signer, h) => ((hooks = h), engine),
  };
  const dispatcher = createDispatcher(deps);
  return {
    dir, config, deps, engine, dispatcher,
    hooks: () => hooks!,
    audit: () => readFileSync(paths(config).audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry),
    state: () => JSON.parse(readFileSync(paths(config).state, 'utf8')) as BotState,
    unlock: async () => void (await dispatcher.handle(req('unlock', { passphrase: 'right' }), { owner: true })),
    // Lock first: it drains the unlock's background work (reconcile, onboard), which still writes into dir.
    cleanup: async () => {
      await dispatcher.lock().catch(() => undefined);
      await deps.audit.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

let ids = 0;
export const req = (method: Method, params: unknown = {}): RpcRequest => ({ jsonrpc: JSONRPC_VERSION, id: ++ids, method, params: params as never });
export const make = (amount: string, price = '0.15', side: 'buy' | 'sell' = 'buy') => req('order.make', { base: 'CC', quote: 'USDCx', side, amount, price });
export const agent = { owner: false };
export const owner = { owner: true };
/** The RpcFault code a refused call threw, or 'ok'. */
export const outcome = (p: Promise<unknown>) => p.then(() => 'ok' as const, (e: { code?: number; data?: { reason?: string } }) => e.data?.reason ?? e.code);

/**
 * Writes raw bytes to a unix socket and collects newline-delimited replies until `want` arrived,
 * the peer closed, or `ms` passed.
 */
export function raw(path: string, chunks: (string | Buffer)[], want = 1, ms = 2000): Promise<{ lines: string[]; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    let buf = '';
    const lines: string[] = [];
    let closed = false;
    const done = () => {
      clearTimeout(t);
      s.destroy();
      resolve({ lines, closed });
    };
    const t = setTimeout(done, ms);
    s.on('error', (e) => (lines.length ? done() : reject(e)));
    s.on('close', () => {
      closed = true;
      done();
    });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (lines.length >= want) done();
    });
    s.on('connect', async () => {
      for (const c of chunks) {
        s.write(c);
        await new Promise((r) => setImmediate(r));
      }
    });
  });
}
