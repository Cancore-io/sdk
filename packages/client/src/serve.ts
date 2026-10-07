/**
 * `acct.serve()` — one long-running loop that drives every Canton↔Canton DvP trade of a self-custody
 * account, so a partner only places orders and keeps this running.
 *
 * It builds nothing new: each order is handed to the account's own `make` / `take` (which resume from
 * whatever step the trade is at, and verify every transaction before the key signs it), and an expired
 * trade's locked allocation to `withdrawAllocation`. What this adds is when to call them:
 *
 * - realtime: `order:updated` for an order of this account, `swap:updated` (sent to the order's two users
 *   only) — each names an order to look at;
 * - a reconcile poll, every `reconcileMs`: this account's orders in flight (`accepted`, `swap_created`)
 *   and its `dvp_expired` swaps (all of them, a page at a time) — so a missed event never strands a trade.
 *
 * One handler per order at a time (a second trigger while one runs schedules one re-run, never a second
 * handler). `concurrency` bounds the work, not the trades: at most that many orders are being looked at or
 * have a step being signed at once, while a trade waiting on its counterparty or the venue holds no slot.
 * A failure is reported as an `error` event and retried on the next poll; it never stops the loop.
 */
import { ORDER_UPDATED_EVENT, SWAP_UPDATED_EVENT, type SocketLike, type SwapUpdate } from './realtime';
import type { AccountUser, HtlcSwap, IncomingTransfer, SelfCustodyAccount, SettleOptions, Settled, Withdrawal } from './selfcustody';
import { TERMINAL_ORDER_STATUSES, type Order, type OrderStatus } from './swap';

/** `make` / `take` options as serve passes them: `gate` holds each new step, never a wait, to its `concurrency`. Internal to serve. */
export interface SettleRun extends SettleOptions {
  gate?: <T>(run: () => Promise<T>) => Promise<T>;
}

export interface ServeOptions extends Omit<SettleOptions, 'signal'> {
  /**
   * A connected Socket.IO socket on the gateway's `/presence` namespace (see `@cancore/client/realtime`),
   * signed in as this account: `auth: (cb) => void acct.session.token().then((token) => cb({ token }), () => cb({}))`
   * (a failed sign-in must still answer the callback: the gateway refuses the handshake, never an unhandled rejection).
   * Without one, the poll alone drives the trades, `reconcileMs` apart.
   */
  socket?: SocketLike;
  /** Poll interval of the safety net. Default 30 s. */
  reconcileMs?: number;
  /**
   * Orders being looked at, or with a step being signed, at once. Default 4. A trade waiting on its
   * counterparty or the venue holds no slot, so it never delays another trade's next step.
   */
  concurrency?: number;
  /**
   * Release this account's allocation of a trade that expired with it still locked (`withdrawAllocation`:
   * verified, one signature per locked leg). Default **true** here, unlike `make` / `take`: nobody is
   * watching a serve loop, and funds left locked are the failure it exists to prevent.
   */
  autoWithdraw?: boolean;
  /** Accept incoming transfers (registry-token deliveries, cashback payouts) on every poll; a function filters them. Default false. */
  acceptIncoming?: boolean | ((transfer: IncomingTransfer) => boolean);
  /** Stops the loop like `stop()`. */
  signal?: AbortSignal;
  /** Everything the loop does or fails at. Called synchronously; an exception thrown here is swallowed. */
  onEvent?: (event: ServeEvent) => void;
}

export type ServeEvent =
  | { type: 'settled'; orderId: string; swapId: string; settled: Settled }
  /**
   * The trade ended unsettled — seen by its handler, or found by the poll (after a restart, say) with this
   * account's allocation still locked. Once per swap per loop. `withdrawal` says what `autoWithdraw` released, when it ran.
   */
  | { type: 'expired'; orderId: string; swapId: string | null; error: Error; withdrawal?: Withdrawal }
  | { type: 'withdrawn'; orderId: string; swapId: string; withdrawal: Withdrawal }
  | { type: 'accepted'; transfer: IncomingTransfer }
  /** Nothing is lost: the order is looked at again on the next poll. */
  | { type: 'error'; orderId?: string; swapId?: string | null; error: unknown };

export interface ServeHandle {
  /** Queue an open order of someone else's to take; the loop accepts it (`autoSplitForFee` applies) and settles the taker side. */
  take(orderId: string): void;
  /**
   * Stop: nothing new is started or signed from here on; resolves once the handlers in flight are done — a
   * step already being signed is finished, a wait ends within one poll interval (`pollMs`, 5 s by default).
   */
  stop(): Promise<void>;
}

/** Orders that are still somewhere between taken and settled. */
const IN_FLIGHT: OrderStatus[] = ['accepted', 'swap_created'];
const PAGE = 100;
/** Every AGING-th released slot goes to the expired backlog first. */
const AGING = 4;

/** `locked(swapId, self)`: the swap is `dvp_expired` with this account's allocation still locked (the account's own read; `self` is serve's `me()`, read once per poll). */
export function serve(acct: SelfCustodyAccount, options: ServeOptions = {}, locked: (swapId: string, self: AccountUser) => Promise<boolean>): ServeHandle {
  const { socket, reconcileMs = 30_000, concurrency = 4, autoWithdraw = true, acceptIncoming = false, onEvent } = options;
  const stopper = new AbortController();

  let busy = 0;
  const waiting: Array<() => void> = [];
  /** Looks at the expired swaps the poll lists: a released slot goes to a live trade first, except every `AGING`th. */
  const backlog: Array<() => void> = [];
  let released = 0;
  /**
   * One of `concurrency` slots, for a look at an order or one signing step; the waits between steps hold none.
   * `expired` puts a look in the backlog lane, so a restart over a long expired history never queues a live
   * trade's signature behind all of it; every `AGING`th released slot goes to the backlog, so live load
   * never starves a locked expired allocation of its withdraw.
   */
  async function slot<T>(run: () => Promise<T>, expired = false): Promise<T> {
    if (busy < concurrency) busy++;
    else await new Promise<void>((resolve) => (expired ? backlog : waiting).push(resolve));
    try {
      return await run();
    } finally {
      const next = ++released % AGING === 0 ? (backlog.shift() ?? waiting.shift()) : (waiting.shift() ?? backlog.shift());
      if (next) next();
      else busy--;
    }
  }
  const settle: SettleRun = { ...options, autoWithdraw, signal: stopper.signal, gate: slot };
  const emit = (event: ServeEvent) => {
    try {
      onEvent?.(event);
    } catch {
      // A listener's bug must not stop the loop.
    }
  };

  /** Orders with nothing left to do. ponytail: grows with the account's history; prune if a loop runs for months. */
  const done = new Set<string>();
  const toTake = new Set<string>();
  const again = new Set<string>();
  /** Swaps an `expired` event was sent for. */
  const reported = new Set<string>();
  const active = new Map<string, Promise<void>>();
  let self: Promise<AccountUser> | undefined;
  const me = () => (self ??= acct.me().catch((err: unknown) => {
    self = undefined;
    throw err;
  }));

  /** `expired`: the poll found it among the `dvp_expired` swaps (the backlog lane). */
  function kick(orderId: string, expired = false): void {
    if (stopper.signal.aborted || done.has(orderId)) return;
    if (active.has(orderId)) {
      again.add(orderId);
      return;
    }
    const running = work(orderId, expired)
      .catch((error: unknown) => {
        if (!stopper.signal.aborted) emit({ type: 'error', orderId, error });
      })
      .finally(() => {
        active.delete(orderId);
        if (again.delete(orderId)) kick(orderId);
      });
    active.set(orderId, running);
  }

  /** Which side of the order this account settles, if any. */
  async function look(orderId: string): Promise<boolean | undefined> {
    if (stopper.signal.aborted) return undefined;
    const [{ id: selfId }, order] = await Promise.all([me(), acct.swap.get(orderId)]);
    const maker = order.initiatorUserId === selfId;
    if (order.sourceNetwork !== 'canton' || order.targetNetwork !== 'canton' || order.dvp !== true) {
      done.add(orderId); // serve drives DvP orders only
      return undefined;
    }
    if (TERMINAL_ORDER_STATUSES.has(order.status)) {
      if (order.swapId) await expiredLocked(orderId, order.swapId);
      done.add(orderId);
      return undefined;
    }
    // An open order is the maker's to wait on — the next event or poll brings it back once taken.
    if (order.status === 'open' && (maker || !toTake.has(orderId))) return undefined;
    if (!maker && order.status !== 'open' && order.opponentUserId !== selfId) {
      done.add(orderId); // taken by somebody else
      return undefined;
    }
    return maker;
  }

  async function work(orderId: string, expired: boolean): Promise<void> {
    const maker = await slot(() => look(orderId), expired);
    if (maker === undefined || stopper.signal.aborted) return;
    try {
      const settled = await (maker ? acct.make : acct.take)(orderId, settle);
      done.add(orderId);
      emit({ type: 'settled', orderId, swapId: settled.swap.id, settled });
    } catch (error) {
      if (stopper.signal.aborted) return;
      const last = (error as { last?: HtlcSwap | Order }).last;
      if (last && 'status' in last && last.status === 'dvp_expired') {
        const { swapId, withdrawable, withdrawal } = error as { swapId: string | null; withdrawable?: boolean; withdrawal?: Withdrawal };
        if (swapId) reported.add(swapId);
        emit({ type: 'expired', orderId, swapId, error: error as Error, ...(withdrawal ? { withdrawal } : {}) });
        if (swapId && withdrawal && withdrawal.withdrawn.length > 0) emit({ type: 'withdrawn', orderId, swapId, withdrawal });
        // Still locked (a leg failed, or autoWithdraw is off): the next poll lists the swap and tries again.
        if (!withdrawable) done.add(orderId);
        return;
      }
      throw error;
    }
  }

  /**
   * A trade that ended while no handler was running (a restart, say): when it expired with this account's
   * allocation still locked, say so and, with `autoWithdraw`, release it. A settled or clean one is left alone.
   */
  async function expiredLocked(orderId: string, swapId: string): Promise<void> {
    if (!(await locked(swapId, await me())) || stopper.signal.aborted) return;
    const withdrawal = autoWithdraw ? await acct.withdrawAllocation(swapId) : undefined;
    if (!reported.has(swapId)) {
      reported.add(swapId);
      const error = new Error(`swap ${swapId} expired unsettled with this account's allocation locked${autoWithdraw ? '' : `: withdrawAllocation('${swapId}') releases it`}`);
      emit({ type: 'expired', orderId, swapId, error, ...(withdrawal ? { withdrawal } : {}) });
    }
    if (!withdrawal) return;
    if (withdrawal.withdrawn.length > 0) emit({ type: 'withdrawn', orderId, swapId, withdrawal });
    if (withdrawal.failed.length > 0) throw new Error(`withdrawing swap ${swapId}: ${withdrawal.failed.map((f) => `${f.leg}: ${String((f.error as Error)?.message ?? f.error)}`).join('; ')}`);
  }

  let olderPage = 2;
  async function reconcile(): Promise<void> {
    for (const statusFilter of IN_FLIGHT) {
      for (let page = 1; ; page++) {
        const { items, total } = await acct.swap.listMine({ statusFilter, page, pageSize: PAGE });
        for (const order of items) kick(order.id);
        if (items.length < PAGE || page * PAGE >= total) break;
      }
    }
    // dvp_expired is terminal: a swap withdrawn long ago stays listed, so the newest page alone would fill up
    // with finished ones. Each poll reads the newest page and one older page in turn, wrapping at the end, so
    // every expired swap is looked at again within (expired / 100) polls; `done` skips those already clean.
    const newest = await acct.listSwaps({ status: 'dvp_expired', pageSize: PAGE });
    let older: HtlcSwap[] = [];
    if (newest.length === PAGE) {
      older = await acct.listSwaps({ status: 'dvp_expired', page: olderPage, pageSize: PAGE });
      olderPage = older.length < PAGE ? 2 : olderPage + 1;
    }
    for (const swap of [...newest, ...older]) if (swap.orderId) kick(swap.orderId, true);
    for (const orderId of toTake) kick(orderId);
    if (acceptIncoming) {
      const { accepted, failed } = await acct.acceptIncoming(typeof acceptIncoming === 'function' ? acceptIncoming : undefined);
      for (const transfer of accepted) emit({ type: 'accepted', transfer });
      for (const { transfer, error } of failed) emit({ type: 'error', swapId: transfer.swapContext?.swapId ?? null, error });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick(): Promise<void> {
    self = undefined; // `/auth/me` once per poll: a changed party is seen within one tick
    try {
      await reconcile();
    } catch (error) {
      if (!stopper.signal.aborted) emit({ type: 'error', error });
    }
    if (!stopper.signal.aborted) timer = setTimeout(() => void tick(), reconcileMs);
  }

  const onOrder = (payload: unknown) => {
    const order = payload as Order;
    // The order feed goes to every client: only this account's orders are worked on.
    void me().then(({ id }) => {
      if (order.initiatorUserId === id || order.opponentUserId === id) kick(order.id);
    }, () => {});
  };
  const onSwap = (payload: unknown) => {
    const { orderId } = payload as SwapUpdate;
    if (orderId) kick(orderId);
  };
  socket?.on(ORDER_UPDATED_EVENT, onOrder);
  socket?.on(SWAP_UPDATED_EVENT, onSwap);

  let stopped: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopped ??= (async () => {
      stopper.abort();
      clearTimeout(timer);
      socket?.off(ORDER_UPDATED_EVENT, onOrder);
      socket?.off(SWAP_UPDATED_EVENT, onSwap);
      again.clear();
      await Promise.allSettled([...active.values()]);
    })();
    return stopped;
  }
  if (options.signal?.aborted) void stop();
  else options.signal?.addEventListener('abort', () => void stop(), { once: true });

  void tick();
  return {
    take(orderId) {
      toTake.add(orderId);
      kick(orderId);
    },
    stop,
  };
}
