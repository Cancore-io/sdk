#!/usr/bin/env node
import { statSync, writeFileSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';
import { userInfo } from 'os';
import { createKeystore } from './keystore';
import { openAuditLog } from './audit';
import { applyFill, auditIntact, createStateStore, rollDaily, type StateStore } from './state';
import { emptyLimits, loadLimits, parseLimits } from './limits';
import { check, checkTake, dcaConfig, DEFAULT_ORDERS_PER_HOUR, gridConfig, ordersLastHour } from './riskgate';
import { dcaNext } from './engine/dca';
import { gridNext, gridRefill, gridSlots } from './engine/grid';
import { networkOf } from '@cancore/client/selfcustody';
import { createEngine, pinnedVenue, type EngineOptions } from './engine/index';
import { dec, fmt, SCALE } from './decimal';
import { listen, RpcFault, type IpcServer } from './ipc/server';
import { flag, loadConfig, paths, type BotConfig } from './config';
import { ERROR, JSONRPC_VERSION, RISK_CLASS, type Method, type RiskClass, type Params, type Result, type RpcRequest, type RpcResponse } from './protocol/index';
import type { AuditEntry, AuditLog, BotSigner, BotState, Decision, Engine, EngineHooks, Keystore, Limits, OrderInfo, OrderIntent, RiskGate, StrategyOrder, StrategyRecord } from './types';

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
  /** New orders an hour, agent and strategies together (config `ordersPerHour`); default 5, the platform's limit. */
  ordersPerHour?: number;
  /** Runs `fn` periodically until the returned stop is called; drives the strategy loop. Default: every 5s. */
  every?(fn: () => void): () => void;
}

export interface Dispatcher {
  /** `owner` is true only for requests that arrived on the owner socket. */
  handle(request: RpcRequest, from: { owner: boolean }): Promise<RpcResponse>;
  /** Stops strategies and wipes the key. */
  lock(): Promise<void>;
}

/** Params as they may be written to the audit log: secrets dropped. */
const auditable = (request: RpcRequest) => (request.method === 'unlock' || request.method === 'register' ? undefined : request.params);

/** Order statuses after which an order of ours will never fill. */
const ENDED = new Set(['cancelled', 'refunded', 'delivery_failed']);

/** `list` without one occurrence of `value`: two orders in the same millisecond keep the other's slot. */
const withoutOne = (list: number[], value: number) => {
  const i = list.indexOf(value);
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
};

/** How long a lock waits for background work after the key is wiped. */
const LOCK_DRAIN_MS = 5_000;

/** An intent younger than this may still be in flight: no lookup can tell it was never made. */
const INTENT_SETTLE_MS = 60_000;
/** Ceiling of the backoff between lookups of one intent while the API keeps failing. */
const LOOKUP_BACKOFF_MAX_MS = 15 * 60_000;

/** A 4xx answer (not timeout/throttle) is the API's refusal: it made no order. Anything else may have made one. */
const refused = (err: unknown) => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
};

const active = (s: StrategyRecord) => s.status === 'running' || s.status === 'rate_limited';
const everyFiveSeconds = (fn: () => void) => {
  const t = setInterval(fn, 5000);
  t.unref();
  return () => clearInterval(t);
};

/** A strategy's order filled: grid moves the slot to the opposite side one level away. */
function strategyFilled(strategies: StrategyRecord[] | undefined, tag: { id: string; slot: string }) {
  return strategies?.map((s) => {
    if (s.strategyId !== tag.id) return s;
    if (s.kind !== 'grid') return { ...s, fills: s.fills + 1 };
    const refill = gridRefill(gridConfig.parse(s.config), tag.slot);
    const want = s.want.filter((w) => w !== tag.slot);
    return { ...s, fills: s.fills + 1, want: refill === undefined || want.includes(refill) ? want : [...want, refill] };
  });
}

/** Orders the user cancelled by hand: a grid never places their slot again. */
function userCancelled(s: BotState, orderIds: string[]): BotState {
  const tags = s.openOrders.flatMap((o) => (o.strategy && orderIds.includes(o.orderId) ? [o.strategy] : []));
  if (tags.length === 0) return s;
  return {
    ...s,
    strategies: s.strategies?.map((r) => {
      const slots = tags.filter((t) => t.id === r.strategyId).map((t) => t.slot);
      if (slots.length === 0) return r;
      return { ...r, want: r.want.filter((w) => !slots.includes(w)), cancelled: [...new Set([...(r.cancelled ?? []), ...slots])] };
    }),
  };
}

/** An intent the API never saw: off the books, and its strategy's placement undone. */
function dropIntent(s: BotState, intent: OrderIntent): BotState {
  // Resolved already (by a tick or by the make itself): resolving it twice would double the book.
  if (!(s.intents ?? []).some((i) => i.key === intent.key)) return s;
  return {
    ...s,
    intents: (s.intents ?? []).filter((i) => i.key !== intent.key),
    strategies: intent.strategy
      ? s.strategies?.map((r) => (r.strategyId === intent.strategy!.id ? { ...r, placed: r.placed.filter((t) => t !== intent.at) } : r))
      : s.strategies,
  };
}

/** An intent whose order exists: on the book under its id. */
function adoptIntent(s: BotState, intent: OrderIntent, orderId: string): BotState {
  if (!(s.intents ?? []).some((i) => i.key === intent.key)) return s;
  const { key: _k, at: _a, ...order } = intent;
  return { ...s, intents: (s.intents ?? []).filter((i) => i.key !== intent.key), openOrders: [...s.openOrders, { orderId, ...order }] };
}

/** `a / b` in 1e-10 units, as a decimal string. */
const ratio = (a: string, b: string) => fmt((dec(a) * SCALE) / dec(b));

type Entry = { method: Method; riskClass: RiskClass; params: unknown };

type Tag = { id: string; slot: string };

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
  let stopTicks: (() => void) | undefined;

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
  /**
   * Books a confirmed order. One that lands after a pause (its make or its intent was in flight) is cancelled
   * at once; true when it was paused. A cancel that fails leaves the order booked, for the owner to see.
   */
  async function adoptOrCancel(e: Engine, intent: OrderIntent, orderId: string): Promise<boolean> {
    let paused = false;
    await mutate((s) => ((paused = s.paused), adoptIntent(s, intent, orderId)));
    if (!paused) return false;
    if (await e.cancel(orderId).then(() => true, () => false)) await mutate((s) => ({ ...s, openOrders: s.openOrders.filter((o) => o.orderId !== orderId) }));
    return true;
  }
  const hooks: EngineHooks = {
    onSettled: (orderId) =>
      later(async () => {
        await mutate((s) => {
          const tag = s.openOrders.find((o) => o.orderId === orderId)?.strategy;
          const next = applyFill(s, orderId, deps.now());
          return tag ? { ...next, strategies: strategyFilled(next.strategies, tag) } : next;
        });
        await append({ ...settleEntry, decision: 'allow', params: { orderId, event: 'settled' } });
      }),
    onEnded: (orderId, reason) =>
      later(async () => {
        // Cancelled outside the daemon (the web app): by hand, so a grid does not place it again.
        await mutate((s) => {
          const next = reason === 'cancelled' ? userCancelled(s, [orderId]) : s;
          return { ...next, openOrders: next.openOrders.filter((o) => o.orderId !== orderId) };
        });
        await append({ ...settleEntry, decision: 'allow', params: { orderId, event: reason } });
      }),
    onVerifyFailed: (detail) => later(() => append({ ...settleEntry, decision: 'deny', reason: 'verify_failed', params: { detail } })),
  };

  /** Per-intent lookup state, in memory: failed lookups back off, an empty one is confirmed once more. */
  const lookups = new Map<string, { failures: number; misses: number; next: number }>();

  /** An order of ours that settled or ended while nobody listened goes through the same hooks as a live one. */
  async function settleIfDone(e: Engine, orderId: string) {
    const info = await e.order(orderId).catch(() => undefined);
    if (info?.status === 'completed') hooks.onSettled(orderId);
    else if (info && ENDED.has(info.status)) hooks.onEnded(orderId, info.status);
  }

  /**
   * Adopts the order an intent made, or drops an intent the API never saw. An intent possibly still in
   * flight waits; one is dropped only after two empty lookups INTENT_SETTLE_MS apart.
   */
  async function reconcileIntents(e: Engine) {
    const now = deps.now();
    for (const intent of (await deps.state.load()).intents ?? []) {
      const seen = lookups.get(intent.key) ?? { failures: 0, misses: 0, next: 0 };
      if (now - intent.at < INTENT_SETTLE_MS || now < seen.next) continue;
      const known = (await deps.state.load()).openOrders.map((o) => o.orderId);
      const found = await e.findIntent(intent, known).then((id) => ({ id }), () => undefined);
      if (!found) {
        const failures = seen.failures + 1;
        lookups.set(intent.key, { ...seen, failures, next: now + Math.min(INTENT_SETTLE_MS * 2 ** failures, LOOKUP_BACKOFF_MAX_MS) });
        continue;
      }
      if (!found.id && seen.misses === 0) {
        lookups.set(intent.key, { ...seen, misses: 1, next: now + INTENT_SETTLE_MS });
        continue;
      }
      lookups.delete(intent.key);
      if (found.id) await adoptOrCancel(e, intent, found.id);
      else await mutate((s) => dropIntent(s, intent));
      await append({ ...settleEntry, decision: 'allow', params: { event: found.id ? 'intent_adopted' : 'intent_dropped', key: intent.key, ...(found.id && { orderId: found.id }) } });
      // It may have filled while it was an intent: its settle event found nothing on the book then.
      if (found.id) await settleIfDone(e, found.id);
    }
  }

  /** Orders that settled or ended while the daemon was down. A failed lookup leaves the order as it was. */
  async function reconcile(e: Engine) {
    await reconcileIntents(e);
    for (const o of (await deps.state.load()).openOrders) await settleIfDone(e, o.orderId);
  }

  const needEngine = () => {
    if (!engine) throw new RpcFault(ERROR.LOCKED, 'keystore is locked');
    return engine;
  };

  const setStrategy = async (id: string, patch: Partial<StrategyRecord>) => {
    await mutate((state) => ({ ...state, strategies: state.strategies?.map((s) => (s.strategyId === id ? { ...s, ...patch } : s)) }));
  };

  /** One step of one strategy: at most one order, through the same gate, audit and engine path as an agent's. */
  async function step(rec: StrategyRecord, limits: Limits) {
    const now = deps.now();
    const state = await deps.state.load();
    if (rec.kind === 'dca' && rec.placed.length >= dcaConfig.parse(rec.config).maxOrders) return setStrategy(rec.strategyId, { status: 'done' });
    // The platform's order limit is per user, one budget for every source: waiting here beats a refused order.
    if (ordersLastHour(state, now) >= (deps.ordersPerHour ?? DEFAULT_ORDERS_PER_HOUR)) {
      if (rec.status !== 'rate_limited') await setStrategy(rec.strategyId, { status: 'rate_limited', reason: 'rate_limited' });
      return;
    }
    const book = [...state.openOrders, ...(state.intents ?? [])];
    if (book.length >= limits.maxOpenOrders) return;
    let next: StrategyOrder | undefined;
    if (rec.kind === 'grid') {
      const open = book.flatMap((o) => (o.strategy?.id === rec.strategyId ? [o.strategy.slot] : []));
      next = gridNext(gridConfig.parse(rec.config), rec.want, open);
    } else {
      const ref = (await engine!.referencePrices().catch(() => ({}) as Record<string, string>))[`${rec.base}/${rec.quote}`];
      next = ref === undefined ? undefined : dcaNext(dcaConfig.parse(rec.config), rec.placed, now, ref);
    }
    if (!next) {
      if (rec.status === 'rate_limited') await setStrategy(rec.strategyId, { status: 'running', reason: undefined });
      return;
    }
    const request = { jsonrpc: JSONRPC_VERSION, id: `${rec.strategyId}:${next.slot}`, method: 'order.make' as const, params: { base: rec.base, quote: rec.quote, side: next.side, amount: next.amount, price: next.price } };
    try {
      await run(request, { owner: false }, { id: rec.strategyId, slot: next.slot });
      if (rec.status === 'rate_limited') await setStrategy(rec.strategyId, { status: 'running', reason: undefined });
    } catch (err) {
      const reason = err instanceof RpcFault ? (err.data?.reason ?? err.message) : 'internal error';
      // The gate's per-minute limit passes; any other refusal stops the strategy, and the daemon carries on.
      if (reason === 'rate_limited') await setStrategy(rec.strategyId, { status: 'rate_limited', reason });
      // A lost answer is not a failure: the intent holds the slot until a tick confirms or drops it.
      else if (err instanceof RpcFault && err.code === ERROR.UNCONFIRMED) return;
      else await setStrategy(rec.strategyId, { status: err instanceof RpcFault && err.code === ERROR.DENIED ? 'denied' : 'failed', reason });
    }
  }

  async function tick() {
    if (!engine) return;
    const [state, limits] = await Promise.all([deps.state.load(), deps.limits.load()]);
    await reconcileIntents(engine);
    for (const rec of (state.strategies ?? []).filter(active)) await step(rec, limits);
  }

  /** Marks the strategy ended and cancels its resting orders; one that will not cancel stays on the book. */
  async function endStrategy(id: string, status: StrategyRecord['status'], reason?: string) {
    const state = await deps.state.load();
    const cancelled: string[] = [];
    if (engine) {
      for (const o of state.openOrders.filter((x) => x.strategy?.id === id && !x.taken)) {
        if (await engine.cancel(o.orderId).then(() => true, () => false)) cancelled.push(o.orderId);
      }
    }
    await mutate((now) => ({
      ...now,
      openOrders: now.openOrders.filter((o) => !cancelled.includes(o.orderId)),
      strategies: now.strategies?.map((s) => (s.strategyId === id ? { ...s, status, ...(reason !== undefined && { reason }) } : s)),
    }));
  }

  // unlock and lock one at a time: a lock that lands during an unlock's passphrase check must not be undone by it.
  let keyQueue: Promise<unknown> = Promise.resolve();
  const keyExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = keyQueue.then(fn);
    keyQueue = p.catch(() => undefined);
    return p;
  };
  const lock = () => keyExclusive(lockNow);
  async function lockNow() {
    // Strategies stay `running` on disk: the next unlock resumes them.
    stopTicks?.();
    stopTicks = undefined;
    const running = engine;
    // The key goes first: a hung network call in a tick must never keep it in memory.
    signer?.destroy();
    signer = engine = undefined;
    deps.keystore.lock();
    await running?.stop().catch(() => undefined);
    // Bounded: hooks still in flight finish or are left behind, the lock does not wait on the network.
    await Promise.race([background, new Promise((r) => setTimeout(r, LOCK_DRAIN_MS).unref())]);
    await mutate((s) => ({ ...s, locked: true }));
  }

  async function execute(method: Method, p: unknown, taken?: Taken, tag?: { id: string; slot: string }): Promise<Result<Method>> {
    const state = await deps.state.load();
    switch (method) {
      case 'status':
        return {
          locked: deps.keystore.isLocked(),
          paused: state.paused,
          ...(state.pauseReason && { pauseReason: state.pauseReason }),
          ...(state.partyId && { partyId: state.partyId }),
          strategies: (state.strategies ?? []).map((s) => ({
            strategyId: s.strategyId, kind: s.kind, running: active(s), status: s.status, ...(s.reason && { reason: s.reason }), placed: s.placed.length, fills: s.fills,
            cancelledByUser: s.cancelled ?? [],
          })),
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
      case 'quote':
        return needEngine().quote(p as Params<'quote'>);
      case 'balances': {
        const instruments = [...new Set((await deps.limits.load()).allowedPairs.flatMap((pair) => pair.split('/')))];
        return { balances: await needEngine().balances(instruments) };
      }
      case 'order.cancel': {
        const { orderId } = p as Params<'order.cancel'>;
        await needEngine().cancel(orderId);
        await mutate((s) => {
          const next = userCancelled(s, [orderId]);
          return { ...next, openOrders: next.openOrders.filter((o) => o.orderId !== orderId) };
        });
        return { orderId, cancelled: true };
      }
      case 'orders.cancelAll': {
        const e = needEngine();
        const cancelled: string[] = [];
        // One that will not cancel stays on the book; the rest still come off it.
        for (const o of state.openOrders) {
          if (await e.cancel(o.orderId).then(() => true, () => false)) cancelled.push(o.orderId);
        }
        await mutate((s) => {
          const next = userCancelled(s, cancelled);
          return { ...next, openOrders: next.openOrders.filter((o) => !cancelled.includes(o.orderId)) };
        });
        return { cancelled };
      }
      case 'pause': {
        const { reason } = p as Params<'pause'>;
        // Paused first, so nothing new passes the gate while the book is being cancelled.
        await mutate((s) => ({
          ...s,
          paused: true,
          ...(reason !== undefined && { pauseReason: reason }),
          strategies: s.strategies?.map((x) => (active(x) ? { ...x, status: 'stopped' as const, reason: 'paused' } : x)),
        }));
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
        if (state.strategies?.some((s) => s.strategyId === strategyId)) await endStrategy(strategyId, 'stopped');
        return { strategyId, stopped: true };
      }
      case 'order.make': {
        const params = p as Params<'order.make'>;
        const e = needEngine();
        const at = deps.now();
        const intent: OrderIntent = { key: randomUUID(), pair: `${params.base}/${params.quote}`, side: params.side, amount: params.amount, price: params.price, at, ...(tag && { strategy: tag }) };
        // The intent, the hourly budget and a strategy's seq land before the API call: a crash after it leaves the
        // intent to reconcile, never an order the daemon does not know about.
        // Re-checked on the latest state: a pause that returned while this make awaited prices wins.
        let pausedFirst = false;
        await mutate((s) => (s.paused ? ((pausedFirst = true), s) : {
          ...s,
          intents: [...(s.intents ?? []), intent],
          orderTimes: [...(s.orderTimes ?? []).filter((t) => t > at - 3_600_000), at],
          ...(tag && { strategies: s.strategies?.map((x) => (x.strategyId === tag.id ? { ...x, placed: [...x.placed, at] } : x)) }),
        }));
        if (pausedFirst) throw new RpcFault(ERROR.PAUSED, 'paused');
        let orderId: string;
        try {
          ({ orderId } = await e.make({ ...params, clientKey: intent.key }));
        } catch (err) {
          if (refused(err)) {
            // The API answered no: nothing to reconcile, and the hourly slot is given back.
            await mutate((s) => ({ ...dropIntent(s, intent), orderTimes: withoutOne(s.orderTimes ?? [], at) }));
            throw err;
          }
          // No answer (network, timeout, 5xx): the order may exist. The intent stays; a tick resolves it.
          throw new RpcFault(ERROR.UNCONFIRMED, 'unconfirmed', { intent: intent.key });
        }
        if (await adoptOrCancel(e, intent, orderId)) throw new RpcFault(ERROR.PAUSED, 'paused: the order was cancelled');
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
        const { kind, base, quote, config } = p as Params<'strategy.start'>;
        needEngine();
        // The gate has already parsed the config; parsing again fills its defaults.
        const parsed = kind === 'grid' ? gridConfig.parse(config) : dcaConfig.parse(config);
        const rec: StrategyRecord = {
          strategyId: randomUUID(), kind, base, quote, config: parsed, status: 'running',
          want: kind === 'grid' ? gridSlots(gridConfig.parse(config)) : [], placed: [], fills: 0,
        };
        await mutate((s) => ({ ...s, strategies: [...(s.strategies ?? []), rec] }));
        return { strategyId: rec.strategyId };
      }
      case 'register': {
        const partyId = await needEngine().register((p as Params<'register'>).inviteCode);
        await mutate((s) => ({ ...s, partyId }));
        return { partyId };
      }
      case 'unlock': {
        // Runs inside the key queue (see run): a concurrent unlock sees the engine, a lock waits and then wins.
        // Already unlocked: a second engine would run beside the first with a destroyed signer.
        if (engine) return { locked: false };
        signer = await deps.keystore.unlock((p as Params<'unlock'>).passphrase).catch(() => {
          throw new RpcFault(ERROR.LOCKED, 'unlock failed');
        });
        engine = deps.createEngine(signer, hooks);
        await mutate((s) => ({ ...s, locked: false }));
        engine.start();
        // In the background: a slow API must not time the unlock out after the key is already loaded.
        const unlocked = engine;
        later(() => reconcile(unlocked));
        // First unlock of an account registered elsewhere (the web app): onboard it and learn its party.
        // A new account needs `register` (owner) first; until then this fails quietly and is logged.
        if (!(await deps.state.load()).partyId) {
          const e = engine;
          later(async () => {
            const partyId = await e.onboard().catch(() => undefined);
            if (partyId) await mutate((s) => ({ ...s, partyId }));
            await append({ ...settleEntry, decision: partyId ? 'allow' : 'error', params: { event: 'onboard' }, ...(!partyId && { reason: 'not registered: run cancore-bot register' }) });
          });
        }
        stopTicks?.();
        let ticking = false;
        // One tick at a time: a slow API must not pile ticks up in the queue ahead of settlements.
        stopTicks = (deps.every ?? everyFiveSeconds)(() => {
          if (ticking) return;
          ticking = true;
          later(() => tick().finally(() => (ticking = false)));
        });
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

  async function run(request: RpcRequest, from: { owner: boolean }, tag?: { id: string; slot: string }): Promise<RpcResponse> {
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
    if (riskClass === 'trade') return exclusive(() => gated(request, entry, deny, tag));
    // unlock takes its key-queue slot before its audit write, so a lock sent after it always runs after it.
    if (request.method === 'unlock') {
      return keyExclusive(async () => {
        await append({ ...entry, decision: 'allow' });
        return executed(request, entry);
      });
    }
    if (request.method === 'lock') {
      // The key goes before the audit write: a full disk must not leave it in memory with the engine running.
      await lock();
      try {
        await append({ ...entry, decision: 'allow' });
      } catch (err) {
        throw new RpcFault(ERROR.INTERNAL, `locked, but the audit write failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      }
      return { jsonrpc: JSONRPC_VERSION, id: request.id, result: { locked: true } };
    }
    await append({ ...entry, decision: 'allow' });
    return executed(request, entry);
  }

  async function gated(request: RpcRequest, entry: Entry, deny: (code: RpcFault['code'], reason: string) => Promise<never>, tag?: Tag): Promise<RpcResponse> {
    let taken: Taken | undefined;
    if (!engine) await deny(ERROR.LOCKED, 'locked');
    const now = deps.now();
    const [loaded, stored] = await Promise.all([deps.state.load(), deps.limits.load()]);
    const limits: Limits = { ...stored, ordersPerHour: deps.ordersPerHour ?? DEFAULT_ORDERS_PER_HOUR };
    if (loaded.paused) await deny(ERROR.PAUSED, 'paused');
    // Fresh prices for every decision: an unreachable price feed leaves none, and the gate then refuses.
    const [referencePrices, usdPrices] = await Promise.all([
      engine!.referencePrices().catch(() => ({})),
      // Never from disk: a stale or edited state file must not value an order.
      engine!.usdPrices().catch(() => ({})),
    ]);
    // An unconfirmed intent may be an order on the book: it counts as one.
    const intents = (loaded.intents ?? []).map(({ key, at: _at, ...o }) => ({ ...o, orderId: `intent:${key}` }));
    const state: BotState = { ...rollDaily(loaded, now), referencePrices, usdPrices, openOrders: [...loaded.openOrders, ...intents] };
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
    return executed(request, entry, taken, tag);
  }

  async function executed(request: RpcRequest, entry: Entry, taken?: Taken, tag?: Tag): Promise<RpcResponse> {
    try {
      return { jsonrpc: JSONRPC_VERSION, id: request.id, result: await execute(request.method, request.params, taken, tag) };
    } catch (err) {
      await append({ ...entry, decision: 'error', reason: err instanceof RpcFault ? err.message : 'internal error' });
      throw err;
    }
  }

  return { handle: (request, from) => run(request, from), lock };
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
  // v1 is dev only: testnet and mainnet are refused before any engine or API call exists.
  const network = config.network ?? networkOf(config.baseUrl);
  if (network !== 'devnet') throw new Error(`cancore-botd v1 runs on devnet only; ${config.baseUrl} is ${network ?? 'an unknown network'}`);
  const p = paths(config);
  // Keystore, state, limits and audit are trusted only inside a directory nobody else can enter or swap files in.
  const dir = statSync(config.stateDir);
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || dir.mode & 0o077) {
    throw new Error(`${config.stateDir}: must be a directory owned by this user with mode 0700 (mode ${(dir.mode & 0o777).toString(8)})`);
  }
  // The venue settles every trade: one the API could name is refused here, before anything listens.
  if (!pinnedVenue(config)) throw new Error(`no venue is pinned for ${config.baseUrl}: set venuePartyId (or network) in the config`);
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
    ...(config.ordersPerHour !== undefined && { ordersPerHour: config.ordersPerHour }),
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
