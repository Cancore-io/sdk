#!/usr/bin/env node
import { statSync, writeFileSync, renameSync } from 'fs';
import { userInfo } from 'os';
import { createKeystore } from './keystore';
import { openAuditLog } from './audit';
import { applyFill, auditIntact, createStateStore, rollDaily, type StateStore } from './state';
import { emptyLimits, loadLimits, parseLimits } from './limits';
import { check, checkTake } from './riskgate';
import { createEngine, type EngineOptions } from './engine/index';
import { dec, fmt, SCALE } from './decimal';
import { listen, RpcFault, type IpcServer } from './ipc/server';
import { flag, loadConfig, paths, type BotConfig } from './config';
import { ERROR, JSONRPC_VERSION, RISK_CLASS, type Method, type RiskClass, type Params, type Result, type RpcRequest, type RpcResponse } from './protocol/index';
import type { AuditEntry, AuditLog, BotSigner, BotState, Decision, Engine, EngineHooks, Keystore, Limits, OrderInfo, RiskGate, StrategyHandle } from './types';

const VERSION = '0.1.0-rc.0';

/** Everything the dispatcher talks to; injected so tests run on fakes. */
export interface Deps {
  keystore: Keystore;
  audit: AuditLog;
  state: StateStore;
  limits: { load(): Promise<Limits>; save(limits: Limits): Promise<void> };
  riskgate: RiskGate;
  /** Called on unlock with the freshly decrypted signer; the engine wraps it in the verifying signer. */
  createEngine(signer: BotSigner, hooks: EngineHooks): Engine;
  now(): number;
  /** The only party `withdraw` may send to (config `ownerParty`); unset disables withdraw. */
  ownerParty?: string;
}

export interface Dispatcher {
  /** `owner` is true only for requests that arrived on the owner socket. */
  handle(request: RpcRequest, from: { owner: boolean }): Promise<RpcResponse>;
  /** Stops strategies and wipes the key. */
  lock(): Promise<void>;
}

/** Params as they may be written to the audit log: secrets dropped. */
const auditable = (request: RpcRequest) => (request.method === 'unlock' ? undefined : request.params);

/** Order statuses after which an order of ours will never fill. */
const ENDED = new Set(['cancelled', 'refunded', 'delivery_failed']);

/** `a / b` in 1e-10 units, as a decimal string. */
const ratio = (a: string, b: string) => fmt((dec(a) * SCALE) / dec(b));

type Entry = { method: Method; riskClass: RiskClass; params: unknown };

type Taken = { base: string; quote: string; side: 'buy' | 'sell'; amount: string; price: string };

/**
 * Someone else's order as a trade of ours on an allowed pair: the taker receives the order's source
 * and gives its target. Undefined when neither orientation is an allowed pair.
 */
export function takeView(order: OrderInfo, allowedPairs: string[]): Taken | undefined {
  if (allowedPairs.includes(`${order.source}/${order.target}`)) {
    return { base: order.source, quote: order.target, side: 'buy', amount: order.sourceAmount, price: ratio(order.targetAmount, order.sourceAmount) };
  }
  if (allowedPairs.includes(`${order.target}/${order.source}`)) {
    return { base: order.target, quote: order.source, side: 'sell', amount: order.targetAmount, price: ratio(order.sourceAmount, order.targetAmount) };
  }
  return undefined;
}

export function createDispatcher(deps: Deps): Dispatcher {
  let signer: BotSigner | undefined;
  let engine: Engine | undefined;
  const strategies = new Map<string, StrategyHandle>();

  // Every state write is a read-modify-write on the latest state, one at a time: a write computed from a
  // state loaded before an await (an engine call) would undo a concurrent pause, fill or new order.
  let stateQueue: Promise<unknown> = Promise.resolve();
  const mutate = (fn: (s: BotState) => BotState): Promise<void> => {
    const p = stateQueue.then(async () => deps.state.save(fn(await deps.state.load())));
    stateQueue = p.catch(() => undefined);
    return p;
  };
  // Trade commands run one at a time from gate to book: two that each fit the limits alone must not both pass.
  let tradeQueue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tradeQueue.then(fn);
    tradeQueue = p.catch(() => undefined);
    return p;
  };

  // Every audit append moves the state's audit pointer, so a truncated log is caught on the next start.
  const append = async (entry: Parameters<AuditLog['append']>[0]): Promise<AuditEntry> => {
    const written = await deps.audit.append(entry);
    await deps.state.recordAudit(written);
    return written;
  };
  /** Background work from the engine's hooks, chained so it is ordered and can be awaited on lock. */
  let background: Promise<unknown> = Promise.resolve();
  const later = (work: () => Promise<unknown>) => {
    background = background.then(work).catch(() => undefined);
  };
  const settleEntry = { method: 'settle' as const, riskClass: 'trade' as const };
  const hooks: EngineHooks = {
    onSettled: (orderId) =>
      later(async () => {
        await mutate((s) => applyFill(s, orderId, deps.now()));
        await append({ ...settleEntry, decision: 'allow', params: { orderId, event: 'settled' } });
      }),
    onEnded: (orderId, reason) =>
      later(async () => {
        await mutate((s) => ({ ...s, openOrders: s.openOrders.filter((o) => o.orderId !== orderId) }));
        await append({ ...settleEntry, decision: 'allow', params: { orderId, event: reason } });
      }),
    onVerifyFailed: (detail) => later(() => append({ ...settleEntry, decision: 'deny', reason: 'verify_failed', params: { detail } })),
  };

  /** Orders that settled or ended while the daemon was down. A failed lookup leaves the order as it was. */
  async function reconcile(e: Engine) {
    for (const o of (await deps.state.load()).openOrders) {
      const info = await e.order(o.orderId).catch(() => undefined);
      if (info?.status === 'completed') hooks.onSettled(o.orderId);
      else if (info && ENDED.has(info.status)) hooks.onEnded(o.orderId, info.status);
    }
    await background;
  }

  const needEngine = () => {
    if (!engine) throw new RpcFault(ERROR.LOCKED, 'keystore is locked');
    return engine;
  };

  async function lock() {
    for (const s of strategies.values()) await s.stop().catch(() => undefined);
    strategies.clear();
    await engine?.stop().catch(() => undefined);
    await background;
    signer?.destroy();
    signer = engine = undefined;
    deps.keystore.lock();
    await mutate((s) => ({ ...s, locked: true }));
  }

  async function execute(method: Method, p: unknown, taken?: Taken): Promise<Result<Method>> {
    const state = await deps.state.load();
    switch (method) {
      case 'status':
        return {
          locked: deps.keystore.isLocked(),
          paused: state.paused,
          ...(state.pauseReason && { pauseReason: state.pauseReason }),
          ...(state.partyId && { partyId: state.partyId }),
          strategies: [...strategies.values()].map((s) => ({ strategyId: s.strategyId, kind: s.kind, running: true })),
          version: VERSION,
        };
      case 'limits.get':
        return { limits: { ...(await deps.limits.load()) } };
      case 'audit.tail':
        return { entries: (await deps.audit.tail((p as Params<'audit.tail'>).n)) as unknown as Record<string, unknown>[] };
      case 'orders.list': {
        const { status } = p as Params<'orders.list'>;
        // shortcut: only the daemon's own open-order book is known here; filled/cancelled history needs an engine query.
        const orders = status === 'open' || status === 'all' ? state.openOrders : [];
        return {
          orders: orders.map((o) => {
            const [base = '', quote = ''] = o.pair.split('/');
            return { orderId: o.orderId, base, quote, side: o.side, amount: o.amount, price: o.price, filled: '0', status: 'open' as const, createdAt: '' };
          }),
        };
      }
      case 'balances': {
        const instruments = [...new Set((await deps.limits.load()).allowedPairs.flatMap((pair) => pair.split('/')))];
        return { balances: await needEngine().balances(instruments) };
      }
      case 'order.cancel': {
        const { orderId } = p as Params<'order.cancel'>;
        await needEngine().cancel(orderId);
        await mutate((s) => ({ ...s, openOrders: s.openOrders.filter((o) => o.orderId !== orderId) }));
        return { orderId, cancelled: true };
      }
      case 'orders.cancelAll': {
        const e = needEngine();
        const cancelled: string[] = [];
        for (const o of state.openOrders) {
          await e.cancel(o.orderId);
          cancelled.push(o.orderId);
        }
        await mutate((s) => ({ ...s, openOrders: s.openOrders.filter((o) => !cancelled.includes(o.orderId)) }));
        return { cancelled };
      }
      case 'pause': {
        const { reason } = p as Params<'pause'>;
        // Paused first, so nothing new passes the gate while the book is being cancelled.
        await mutate((s) => ({ ...s, paused: true, ...(reason !== undefined && { pauseReason: reason }) }));
        for (const s of strategies.values()) await s.stop();
        strategies.clear();
        // Our own resting orders are cancelled; a taken order is already a trade and settles.
        const cancelled: string[] = [];
        if (engine) {
          for (const o of state.openOrders.filter((x) => !x.taken)) {
            if (await engine.cancel(o.orderId).then(() => true, () => false)) cancelled.push(o.orderId);
          }
        }
        await mutate((s) => ({ ...s, openOrders: s.openOrders.filter((o) => !cancelled.includes(o.orderId)) }));
        return { paused: true };
      }
      case 'strategy.stop': {
        const { strategyId } = p as Params<'strategy.stop'>;
        await strategies.get(strategyId)?.stop();
        strategies.delete(strategyId);
        return { strategyId, stopped: true };
      }
      case 'order.make': {
        const params = p as Params<'order.make'>;
        const { orderId } = await needEngine().make(params);
        const pair = `${params.base}/${params.quote}`;
        await mutate((s) => ({ ...s, openOrders: [...s.openOrders, { orderId, pair, side: params.side, amount: params.amount, price: params.price }] }));
        return { order: { orderId, base: params.base, quote: params.quote, side: params.side, amount: params.amount, price: params.price, filled: '0', status: 'open', createdAt: new Date(deps.now()).toISOString() } };
      }
      case 'order.take': {
        const params = p as Params<'order.take'>;
        const result = await needEngine().take(params);
        // On the book until it settles: it counts against open orders and the worst-case position.
        const view = taken!;
        await mutate((s) => ({ ...s, openOrders: [...s.openOrders, { orderId: params.orderId, pair: `${view.base}/${view.quote}`, side: view.side, amount: view.amount, price: view.price, taken: true }] }));
        return result;
      }
      case 'strategy.start': {
        const handle = await needEngine().serve(p as Params<'strategy.start'>);
        strategies.set(handle.strategyId, handle);
        return { strategyId: handle.strategyId };
      }
      case 'unlock': {
        signer = await deps.keystore.unlock((p as Params<'unlock'>).passphrase).catch(() => {
          throw new RpcFault(ERROR.LOCKED, 'unlock failed');
        });
        engine = deps.createEngine(signer, hooks);
        await mutate((s) => ({ ...s, locked: false }));
        engine.start();
        await reconcile(engine);
        return { locked: false };
      }
      case 'lock':
        await lock();
        return { locked: true };
      case 'withdraw': {
        const { to, instrument, amount } = p as Params<'withdraw'>;
        await needEngine().withdraw(to, instrument, amount);
        return { to, instrument, amount };
      }
      case 'resume': {
        await mutate(({ pauseReason: _, ...rest }) => ({ ...rest, paused: false }));
        return { paused: false };
      }
      case 'limits.set': {
        let limits: Limits;
        try {
          limits = parseLimits((p as Params<'limits.set'>).limits);
        } catch (err) {
          throw new RpcFault(ERROR.INVALID_PARAMS, `invalid limits: ${(err as Error).message}`);
        }
        await deps.limits.save(limits);
        return { limits: { ...limits } };
      }
    }
  }

  async function handle(request: RpcRequest, from: { owner: boolean }): Promise<RpcResponse> {
    const riskClass = RISK_CLASS[request.method];
    const entry = { method: request.method, riskClass, params: auditable(request) };
    const deny = async (code: RpcFault['code'], reason: string): Promise<never> => {
      await append({ ...entry, decision: 'deny', reason });
      throw new RpcFault(code, reason, code === ERROR.DENIED ? { reason: reason as never } : undefined);
    };

    if (riskClass === 'owner' && !from.owner) await deny(ERROR.FORBIDDEN, 'forbidden');
    if (request.method === 'withdraw' && (!deps.ownerParty || (request.params as Params<'withdraw'>).to !== deps.ownerParty)) {
      await deny(ERROR.FORBIDDEN, 'withdraw goes only to the owner party pinned in the config');
    }
    if (riskClass === 'trade') return exclusive(() => gated(request, entry, deny));
    await append({ ...entry, decision: 'allow' });
    return executed(request, entry);
  }

  async function gated(request: RpcRequest, entry: Entry, deny: (code: RpcFault['code'], reason: string) => Promise<never>): Promise<RpcResponse> {
    let taken: Taken | undefined;
    if (!engine) await deny(ERROR.LOCKED, 'locked');
    const now = deps.now();
    const [loaded, limits] = await Promise.all([deps.state.load(), deps.limits.load()]);
    if (loaded.paused) await deny(ERROR.PAUSED, 'paused');
    // Fresh prices for every decision: an unreachable price feed leaves none, and the gate then refuses.
    const referencePrices = await engine!.referencePrices().catch(() => ({}));
    const state: BotState = { ...rollDaily(loaded, now), referencePrices };
    let decision: Decision;
    if (request.method === 'order.take') {
      const params = request.params as Params<'order.take'>;
      const info = await engine!.order(params.orderId).catch(() => undefined);
      // The order's amounts are the API's: one that does not parse is a refusal, never an unaudited throw.
      let whole = false;
      try {
        taken = info?.status === 'open' ? takeView(info, limits.allowedPairs) : undefined;
        // Partial takes do not exist: the amount asked must be the whole order, or the agent would get more than it asked for.
        whole = !!taken && dec(taken.amount) === dec(params.amount);
      } catch {
        taken = undefined;
      }
      decision = whole ? checkTake(params, taken!, state, limits, now) : { allow: false, reason: 'no_rule' };
    } else {
      decision = deps.riskgate({ method: request.method, params: request.params as never }, state, limits, now);
    }
    if (!decision.allow) await deny(ERROR.DENIED, decision.reason);
    await mutate((s) => ({ ...rollDaily(s, now), recentCommands: [...s.recentCommands.filter((t) => t > now - 60_000), now] }));
    // The decision is on disk before anything touches the engine or the key.
    await append({ ...entry, decision: 'allow' });
    return executed(request, entry, taken);
  }

  async function executed(request: RpcRequest, entry: Entry, taken?: Taken): Promise<RpcResponse> {
    try {
      return { jsonrpc: JSONRPC_VERSION, id: request.id, result: await execute(request.method, request.params, taken) };
    } catch (err) {
      await append({ ...entry, decision: 'error', reason: err instanceof RpcFault ? err.message : 'internal error' });
      throw err;
    }
  }

  return { handle, lock };
}

function fileLimits(path: string): Deps['limits'] {
  return {
    async load() {
      try {
        // Ownership and mode checked on every read: a limits file someone else can write is refused.
        return await loadLimits(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyLimits();
        throw err;
      }
    },
    async save(limits) {
      writeFileSync(`${path}.tmp`, JSON.stringify(limits, null, 2), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}

/** The real modules. `engine` carries test-only overrides (a fake API's fetch, short poll intervals). */
export async function defaultDeps(config: BotConfig, engine: Partial<Pick<EngineOptions, 'fetchImpl' | 'pollMs' | 'reconcileMs'>> = {}): Promise<Deps> {
  const p = paths(config);
  // Keystore, state, limits and audit are trusted only inside a directory nobody else can enter or swap files in.
  const dir = statSync(config.stateDir);
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || dir.mode & 0o077) {
    throw new Error(`${config.stateDir}: must be a directory owned by this user with mode 0700 (mode ${(dir.mode & 0o777).toString(8)})`);
  }
  return {
    keystore: createKeystore(p.keystore),
    audit: await openAuditLog(p.audit),
    state: createStateStore(p.state),
    limits: fileLimits(p.limits),
    riskgate: check,
    createEngine: (signer, hooks) =>
      createEngine({
        ...engine,
        signer,
        hooks,
        baseUrl: config.baseUrl,
        ...(config.venuePartyId && { venuePartyId: config.venuePartyId }),
        ...(config.maxFeeRate && { maxFeeRate: config.maxFeeRate }),
        ...(config.feeRecipientPartyId && { feeRecipientPartyId: config.feeRecipientPartyId }),
        ...(config.network && { network: config.network }),
        ...(config.maxFee && { maxFee: config.maxFee }),
      }),
    now: Date.now,
    ...(config.ownerParty && { ownerParty: config.ownerParty }),
  };
}

/** Opens both sockets; resolves with a stop function that locks and closes them. */
export async function start(config: BotConfig, deps: Deps): Promise<() => Promise<void>> {
  const dispatcher = createDispatcher(deps);
  await deps.limits.load();
  // The key is never in memory at start. A log that lost entries the state saw: paused until the owner resumes.
  const state = await deps.state.load();
  const intact = await auditIntact(state, deps.audit);
  if (!intact) process.stderr.write('cancore-botd: the audit log is truncated or its chain is broken; starting locked and paused\n');
  const { lastAuditSeq: _seq, lastAuditHash: _hash, ...rest } = state;
  await deps.state.save(intact ? { ...state, locked: true } : { ...rest, locked: true, paused: true, pauseReason: 'audit log truncated or broken' });
  const servers: IpcServer[] = [
    await listen(config.ownerSocket, (r) => dispatcher.handle(r, { owner: true }), { mode: 0o600 }),
    await listen(config.agentSocket, (r) => dispatcher.handle(r, { owner: false }), { mode: 0o660, group: config.clientsGroup, maxConnections: 32 }),
  ];
  return async () => {
    await dispatcher.lock().catch(() => undefined);
    await Promise.all(servers.map((s) => s.close()));
    await deps.audit.close();
  };
}

/** cancore-botd [--config <path>] [--dev]. Resolves with the exit code once SIGTERM/SIGINT has shut it down. */
export async function main(argv: string[]): Promise<number> {
  const config = loadConfig(flag(argv, 'config'));
  const dev = argv.includes('--dev');
  if (dev) Object.assign(config, { clientsGroup: undefined });
  if (!dev && userInfo().username !== config.daemonUser) {
    process.stderr.write(`cancore-botd must run as ${config.daemonUser} (use --dev to override)\n`);
    return 1;
  }
  const stop = await start(config, await defaultDeps(config));
  process.stderr.write(`cancore-botd listening on ${config.ownerSocket} and ${config.agentSocket}\n`);
  return new Promise((resolve) => {
    const shutdown = () => void stop().then(() => resolve(0), () => resolve(1));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}

// shortcut: argv-based entry detection because jest runs this as CJS (no import.meta); breaks if the bin is renamed.
if (/(?:cancore-botd|daemon\.js)$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      process.stderr.write(`cancore-botd: ${err.message}\n`);
      process.exit(1);
    },
  );
}
