#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { userInfo } from 'os';
import { createKeystore } from './keystore';
import { openAuditLog } from './audit';
import { createStateStore, type StateStore } from './state';
import { emptyLimits, parseLimits } from './limits';
import { check } from './riskgate';
import { createSelfCustody } from './engine/index';
import { listen, RpcFault, type IpcServer } from './ipc/server';
import { flag, loadConfig, paths, type BotConfig } from './config';
import { ERROR, JSONRPC_VERSION, RISK_CLASS, type Method, type Params, type Result, type RpcRequest, type RpcResponse } from './protocol/index';
import type { AuditLog, BotSigner, Engine, Keystore, Limits, RiskGate, StrategyHandle } from './types';

const VERSION = '0.1.0-rc.0';

/** Everything the dispatcher talks to; injected so tests run on fakes. */
export interface Deps {
  keystore: Keystore;
  audit: AuditLog;
  state: StateStore;
  limits: { load(): Promise<Limits>; save(limits: Limits): Promise<void> };
  riskgate: RiskGate;
  /** Called on unlock with the freshly decrypted signer. */
  createEngine(signer: BotSigner): Engine;
  now(): number;
}

export interface Dispatcher {
  /** `owner` is true only for requests that arrived on the owner socket. */
  handle(request: RpcRequest, from: { owner: boolean }): Promise<RpcResponse>;
  /** Stops strategies and wipes the key. */
  lock(): Promise<void>;
}

/** Params as they may be written to the audit log: secrets dropped. */
const auditable = (request: RpcRequest) => (request.method === 'unlock' ? undefined : request.params);

export function createDispatcher(deps: Deps): Dispatcher {
  let signer: BotSigner | undefined;
  let engine: Engine | undefined;
  const strategies = new Map<string, StrategyHandle>();

  const needEngine = () => {
    if (!engine) throw new RpcFault(ERROR.LOCKED, 'keystore is locked');
    return engine;
  };

  async function lock() {
    for (const s of strategies.values()) await s.stop().catch(() => undefined);
    strategies.clear();
    signer?.destroy();
    signer = engine = undefined;
    deps.keystore.lock();
    const state = await deps.state.load();
    await deps.state.save({ ...state, locked: true });
  }

  async function execute(method: Method, p: unknown): Promise<Result<Method>> {
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
      case 'balances':
        throw new RpcFault(ERROR.METHOD_NOT_FOUND, 'balances is not supported by this engine yet');
      case 'order.cancel': {
        const { orderId } = p as Params<'order.cancel'>;
        await needEngine().cancel(orderId);
        await deps.state.save({ ...state, openOrders: state.openOrders.filter((o) => o.orderId !== orderId) });
        return { orderId, cancelled: true };
      }
      case 'orders.cancelAll': {
        const e = needEngine();
        const cancelled: string[] = [];
        for (const o of state.openOrders) {
          await e.cancel(o.orderId);
          cancelled.push(o.orderId);
        }
        await deps.state.save({ ...state, openOrders: state.openOrders.filter((o) => !cancelled.includes(o.orderId)) });
        return { cancelled };
      }
      case 'pause': {
        const { reason } = p as Params<'pause'>;
        for (const s of strategies.values()) await s.stop();
        strategies.clear();
        await deps.state.save({ ...state, paused: true, ...(reason !== undefined && { pauseReason: reason }) });
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
        await deps.state.save({ ...state, openOrders: [...state.openOrders, { orderId, pair, side: params.side, amount: params.amount, price: params.price }] });
        return { order: { orderId, base: params.base, quote: params.quote, side: params.side, amount: params.amount, price: params.price, filled: '0', status: 'open', createdAt: new Date(deps.now()).toISOString() } };
      }
      case 'order.take':
        return needEngine().take(p as Params<'order.take'>);
      case 'strategy.start': {
        const handle = await needEngine().serve(p as Params<'strategy.start'>);
        strategies.set(handle.strategyId, handle);
        return { strategyId: handle.strategyId };
      }
      case 'unlock': {
        signer = await deps.keystore.unlock((p as Params<'unlock'>).passphrase).catch(() => {
          throw new RpcFault(ERROR.LOCKED, 'unlock failed');
        });
        engine = deps.createEngine(signer);
        await deps.state.save({ ...state, locked: false });
        return { locked: false };
      }
      case 'lock':
        await lock();
        return { locked: true };
      case 'resume': {
        const { pauseReason: _, ...rest } = state;
        await deps.state.save({ ...rest, paused: false });
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
    const deny = async (code: RpcFault['code'], reason: string) => {
      await deps.audit.append({ ...entry, decision: 'deny', reason });
      throw new RpcFault(code, reason, code === ERROR.DENIED ? { reason: reason as never } : undefined);
    };

    if (riskClass === 'owner' && !from.owner) await deny(ERROR.FORBIDDEN, 'forbidden');
    if (riskClass === 'trade') {
      if (!engine) await deny(ERROR.LOCKED, 'locked');
      const [state, limits] = await Promise.all([deps.state.load(), deps.limits.load()]);
      if (state.paused) await deny(ERROR.PAUSED, 'paused');
      const now = deps.now();
      const decision = deps.riskgate({ method: request.method, params: request.params as never }, state, limits, now);
      if (!decision.allow) await deny(ERROR.DENIED, decision.reason);
      await deps.state.save({ ...state, recentCommands: [...state.recentCommands.filter((t) => t > now - 60_000), now] });
    }
    // The decision is on disk before anything touches the engine or the key.
    await deps.audit.append({ ...entry, decision: 'allow' });
    try {
      return { jsonrpc: JSONRPC_VERSION, id: request.id, result: await execute(request.method, request.params) };
    } catch (err) {
      await deps.audit.append({ ...entry, decision: 'error', reason: err instanceof RpcFault ? err.message : 'internal error' });
      throw err;
    }
  }

  return { handle, lock };
}

function fileLimits(path: string): Deps['limits'] {
  return {
    async load() {
      try {
        return parseLimits(JSON.parse(readFileSync(path, 'utf8')));
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

export async function defaultDeps(config: BotConfig): Promise<Deps> {
  const p = paths(config);
  return {
    keystore: createKeystore(p.keystore),
    audit: await openAuditLog(p.audit),
    state: createStateStore(p.state),
    limits: fileLimits(p.limits),
    riskgate: check,
    createEngine: (signer) => createSelfCustody({ signer, baseUrl: config.baseUrl }),
    now: Date.now,
  };
}

/** Opens both sockets; resolves with a stop function that locks and closes them. */
export async function start(config: BotConfig, deps: Deps): Promise<() => Promise<void>> {
  const dispatcher = createDispatcher(deps);
  await deps.limits.load();
  const servers: IpcServer[] = [
    await listen(config.ownerSocket, (r) => dispatcher.handle(r, { owner: true }), { mode: 0o600 }),
    await listen(config.agentSocket, (r) => dispatcher.handle(r, { owner: false }), { mode: 0o660, group: config.clientsGroup }),
  ];
  return async () => {
    await dispatcher.lock().catch(() => undefined);
    await Promise.all(servers.map((s) => s.close()));
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
