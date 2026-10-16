import { open, readFile, rename } from 'fs/promises';
import { dirname } from 'path';
import { dec, fmt } from './decimal';
import type { AuditEntry, AuditLog, BotState } from './types';

export interface StateStore {
  load(): Promise<BotState>;
  save(state: BotState): Promise<void>;
  /** Records the latest audit entry; every later save carries it, whatever state it is given. */
  recordAudit(entry: Pick<AuditEntry, 'seq' | 'hash'>): Promise<void>;
}

const DAY_MS = 86_400_000;

export const initialState = (): BotState => ({
  locked: true, paused: false, openOrders: [], positions: {}, dailyVolume: {}, recentCommands: [], referencePrices: {}, usdPrices: {}, fills: [],
});

/** JSON file at `path` (mode 0600), written atomically (tmp + rename). A missing file is the initial state. */
export function createStateStore(path: string): StateStore {
  let audit: Pick<AuditEntry, 'seq' | 'hash'> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.catch(() => undefined);
    return p;
  };
  const read = async (): Promise<BotState> => {
    try {
      // USD prices are fetched fresh for every decision: a stale copy from disk is never trusted.
      const { usdPrices: _stale, ...saved } = JSON.parse(await readFile(path, 'utf8')) as Partial<BotState>;
      return { ...initialState(), ...saved };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return initialState();
      throw err;
    }
  };
  const write = async (state: BotState) => {
    // A stale caller must not move the audit pointer back: the newest entry seen wins.
    const next = audit && (state.lastAuditSeq ?? -1) < audit.seq ? { ...state, lastAuditSeq: audit.seq, lastAuditHash: audit.hash } : state;
    const tmp = `${path}.tmp`;
    // fsync file then directory: a power loss must leave either the old or the new state, never a torn one.
    const fh = await open(tmp, 'w', 0o600);
    try {
      const { usdPrices: _drop, ...persisted } = next;
      await fh.writeFile(JSON.stringify(persisted));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  };
  return {
    load: () => serial(read),
    save: (state) => serial(() => write(state)),
    recordAudit: (entry) =>
      serial(async () => {
        audit = { seq: entry.seq, hash: entry.hash };
        await write(await read());
      }),
  };
}

/** Drops fills older than 24h and recomputes `dailyVolume` from the rest. */
export function rollDaily(state: BotState, now: number): BotState {
  const fills = (state.fills ?? []).filter((f) => f.at > now - DAY_MS);
  const volume: Record<string, bigint> = {};
  for (const f of fills) volume[f.instrument] = (volume[f.instrument] ?? 0n) + dec(f.amount);
  return { ...state, fills, dailyVolume: Object.fromEntries(Object.entries(volume).map(([k, v]) => [k, fmt(v)])) };
}

/** An open order filled in full: off the book, into the position and the 24h volume. Unknown ids change nothing. */
export function applyFill(state: BotState, orderId: string, now: number): BotState {
  const order = state.openOrders.find((o) => o.orderId === orderId);
  if (!order) return state;
  const base = order.pair.split('/')[0]!;
  const pos = (Object.hasOwn(state.positions, base) ? dec(state.positions[base]!) : 0n) + (order.side === 'buy' ? dec(order.amount) : -dec(order.amount));
  return rollDaily({
    ...state,
    openOrders: state.openOrders.filter((o) => o.orderId !== orderId),
    positions: { ...state.positions, [base]: fmt(pos) },
    fills: [...(state.fills ?? []), { at: now, instrument: base, amount: order.amount }],
  }, now);
}

/**
 * Whether the audit log still holds the last entry the state recorded. A log cut back past it
 * (or with a broken chain) means someone removed history: the daemon starts locked and paused.
 * A log longer than the state knows is fine: a crash between the append and the state write.
 */
export async function auditIntact(state: BotState, audit: AuditLog): Promise<boolean> {
  const checked = await audit.verify();
  if (!checked.ok) return false;
  if (state.lastAuditSeq === undefined) return true;
  if (checked.entries <= state.lastAuditSeq) return false;
  const [entry] = await audit.tail(checked.entries - state.lastAuditSeq);
  return entry?.seq === state.lastAuditSeq && entry.hash === state.lastAuditHash;
}
