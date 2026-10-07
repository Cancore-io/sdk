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
 *   and its `dvp_expired` swaps — so a missed event never strands a trade.
 *
 * One handler per order at a time (a second trigger while one runs schedules one re-run, never a second
 * handler), at most `concurrency` at once. A failure is reported as an `error` event and retried on the
 * next poll; it never stops the loop.
 */
import { ORDER_UPDATED_EVENT, SWAP_UPDATED_EVENT, type SocketLike, type SwapUpdate } from './realtime';
import type { HtlcSwap, IncomingTransfer, SelfCustodyAccount, SettleOptions, Settled, Withdrawal } from './selfcustody';
import { TERMINAL_ORDER_STATUSES, type Order, type OrderStatus } from './swap';

export interface ServeOptions extends Omit<SettleOptions, 'signal'> {
  /**
   * A connected Socket.IO socket on the gateway's `/presence` namespace (see `@cancore/client/realtime`),
   * signed in as this account: `auth: (cb) => acct.session.token().then((token) => cb({ token }))`.
   * Without one, the poll alone drives the trades, `reconcileMs` apart.
   */
  socket?: SocketLike;
  /** Poll interval of the safety net. Default 30 s. */
  reconcileMs?: number;
  /** Orders worked on at once. Default 4. */
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
  /** The trade ended unsettled. `withdrawal` says what `autoWithdraw` released, when it ran. */
  | { type: 'expired'; orderId: string; swapId: string | null; error: Error; withdrawal?: Withdrawal }
  | { type: 'withdrawn'; orderId: string; swapId: string; withdrawal: Withdrawal }
  | { type: 'accepted'; transfer: IncomingTransfer }
  /** Nothing is lost: the order is looked at again on the next poll. */
  | { type: 'error'; orderId?: string; swapId?: string | null; error: unknown };

export interface ServeHandle {
  /** Queue an open order of someone else's to take; the loop accepts it (`autoSplitForFee` applies) and settles the taker side. */
  take(orderId: string): void;
  /** Stop: no new work, then wait for the handlers in flight to reach their next wait (a step being signed is finished). */
  stop(): Promise<void>;
}

/** Orders that are still somewhere between taken and settled. */
const IN_FLIGHT: OrderStatus[] = ['accepted', 'swap_created'];
const PAGE = 100;

export function serve(acct: SelfCustodyAccount, options: ServeOptions = {}): ServeHandle {
  const { socket, reconcileMs = 30_000, concurrency = 4, autoWithdraw = true, acceptIncoming = false, onEvent } = options;
  const stopper = new AbortController();
  const settle: SettleOptions = { ...options, autoWithdraw, signal: stopper.signal };
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
  const queued = new Set<string>();
  const again = new Set<string>();
  const active = new Map<string, Promise<void>>();
  let self: Promise<{ id: string }> | undefined;
  const me = () => (self ??= acct.me().catch((err: unknown) => {
    self = undefined;
    throw err;
  }));

  function kick(orderId: string): void {
    if (stopper.signal.aborted || done.has(orderId)) return;
    if (active.has(orderId)) {
      again.add(orderId);
      return;
    }
    queued.add(orderId);
    pump();
  }

  function pump(): void {
    for (const orderId of queued) {
      if (active.size >= concurrency) return;
      queued.delete(orderId);
      const running = work(orderId)
        .catch((error: unknown) => {
          if (!stopper.signal.aborted) emit({ type: 'error', orderId, error });
        })
        .finally(() => {
          active.delete(orderId);
          if (again.delete(orderId)) kick(orderId);
          pump();
        });
      active.set(orderId, running);
    }
  }

  async function work(orderId: string): Promise<void> {
    const [{ id: selfId }, order] = await Promise.all([me(), acct.swap.get(orderId)]);
    const maker = order.initiatorUserId === selfId;
    if (order.sourceNetwork !== 'canton' || order.targetNetwork !== 'canton' || order.dvp !== true) {
      done.add(orderId); // serve drives DvP orders only
      return;
    }
    if (TERMINAL_ORDER_STATUSES.has(order.status)) {
      if (order.swapId && autoWithdraw) await withdrawIfExpired(orderId, order.swapId);
      done.add(orderId);
      return;
    }
    // An open order is the maker's to wait on — the next event or poll brings it back once taken.
    if (order.status === 'open' && (maker || !toTake.has(orderId))) return;
    if (!maker && order.status !== 'open' && order.opponentUserId !== selfId) {
      done.add(orderId); // taken by somebody else
      return;
    }
    try {
      const settled = await (maker ? acct.make : acct.take)(orderId, settle);
      done.add(orderId);
      emit({ type: 'settled', orderId, swapId: settled.swap.id, settled });
    } catch (error) {
      if (stopper.signal.aborted) return;
      const last = (error as { last?: HtlcSwap | Order }).last;
      if (last && 'status' in last && last.status === 'dvp_expired') {
        const { swapId, withdrawable, withdrawal } = error as { swapId: string | null; withdrawable?: boolean; withdrawal?: Withdrawal };
        emit({ type: 'expired', orderId, swapId, error: error as Error, ...(withdrawal ? { withdrawal } : {}) });
        if (swapId && withdrawal && withdrawal.withdrawn.length > 0) emit({ type: 'withdrawn', orderId, swapId, withdrawal });
        // Still locked (a leg failed, or autoWithdraw is off): the next poll lists the swap and tries again.
        if (!withdrawable) done.add(orderId);
        return;
      }
      throw error;
    }
  }

  /** A trade that ended while no handler was running: release what is still locked. A settled one is left alone. */
  async function withdrawIfExpired(orderId: string, swapId: string): Promise<void> {
    if ((await acct.swapState(swapId)).status !== 'dvp_expired') return;
    const withdrawal = await acct.withdrawAllocation(swapId);
    if (withdrawal.withdrawn.length > 0) emit({ type: 'withdrawn', orderId, swapId, withdrawal });
    if (withdrawal.failed.length > 0) throw new Error(`withdrawing swap ${swapId}: ${withdrawal.failed.map((f) => `${f.leg}: ${String((f.error as Error)?.message ?? f.error)}`).join('; ')}`);
  }

  async function reconcile(): Promise<void> {
    for (const statusFilter of IN_FLIGHT) {
      for (let page = 1; ; page++) {
        const { items, total } = await acct.swap.listMine({ statusFilter, page, pageSize: PAGE });
        for (const order of items) kick(order.id);
        if (items.length < PAGE || page * PAGE >= total) break;
      }
    }
    // ponytail: the newest 100 expired swaps only; page further if an account ever has more locked at once.
    for (const swap of await acct.listSwaps({ status: 'dvp_expired', pageSize: PAGE })) if (swap.orderId) kick(swap.orderId);
    for (const orderId of toTake) kick(orderId);
    if (acceptIncoming) {
      const { accepted, failed } = await acct.acceptIncoming(typeof acceptIncoming === 'function' ? acceptIncoming : undefined);
      for (const transfer of accepted) emit({ type: 'accepted', transfer });
      for (const { transfer, error } of failed) emit({ type: 'error', swapId: transfer.swapContext?.swapId ?? null, error });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick(): Promise<void> {
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
      queued.clear();
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
