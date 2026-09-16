/**
 * `@cancore/client/realtime` — order updates as the gateway pushes them,
 * instead of `track`'s poll loop.
 *
 * The socket is injected, exactly the way `request` is. This package has no
 * runtime dependencies and is not about to grow one for a transport the host
 * already has; `socket.io-client` stays on your side of the seam:
 *
 * ```ts
 * import { io } from 'socket.io-client';
 * const socket = io(`${baseUrl}/presence`, { auth: { token }, transports: ['websocket'] });
 * ```
 *
 * `/presence` is the namespace and `auth.token` is the credential — the
 * handshake is rejected without it. There is no join message to send: the
 * gateway verifies the token and puts the socket in that user's room itself, so
 * `on`/`off` is the whole protocol from this side. Event names and the payload
 * shape are pinned in `contract/realtime-events.contract.json`, with the
 * backend file:line each came from.
 */
import { TERMINAL_ORDER_STATUSES, type Order } from './swap';

/** The gateway's event for an order that changed. */
export const ORDER_UPDATED_EVENT = 'order:updated';

/**
 * The part of a Socket.IO client this module uses — `socket.io-client`'s own
 * `Socket` satisfies it, and so does a two-method stub in a test. That
 * assignability is checked, not assumed: see `realtime.socket-io.test.ts`.
 *
 * The payload is `unknown` because that is what a socket delivers. Socket.IO
 * types its own listeners as `(...args: any[]) => void`, and `unknown` is the
 * narrowest thing those two signatures agree on.
 */
export interface SocketLike {
  on(event: string, handler: (payload: unknown) => void): unknown;
  off(event: string, handler: (payload: unknown) => void): unknown;
}

/**
 * Every order update the venue broadcasts, for as long as you keep the
 * subscription. Returns the unsubscribe.
 *
 * This feed is not filtered for you: the gateway emits `order:updated` to every
 * connected client, so orders you have nothing to do with arrive here too. The
 * payload is the same `Order` the REST API returns, minus the counterparties'
 * `ethAddress`/`tronAddress`, which the broadcast strips.
 */
export function orderUpdates(socket: SocketLike, handler: (order: Order) => void): () => void {
  // The one place the gateway's word is taken for the payload's shape, the way
  // `http` takes it for a JSON body. The same reference has to reach `off`, or
  // the unsubscribe removes nothing.
  const listener = handler as (payload: unknown) => void;
  socket.on(ORDER_UPDATED_EVENT, listener);
  return () => {
    socket.off(ORDER_UPDATED_EVENT, listener);
  };
}

export interface WaitForOrderOptions {
  /** Which update ends the wait. Default: the order reached a terminal status. */
  isTerminal?: (order: Order) => boolean;
  /** Give up after this long. Default 15 minutes, as `track`. */
  timeoutMs?: number;
  /** Stop early. Rejects with the signal's `reason`. */
  signal?: AbortSignal;
}

/**
 * `waitForOrder` gave up. `last` is the most recent update seen for that order
 * — absent when none arrived at all, which is a different failure worth telling
 * apart from "still running after the budget".
 */
export class OrderWaitTimeoutError extends Error {
  constructor(
    readonly orderId: string,
    readonly last?: Order,
  ) {
    super(
      last
        ? `order ${orderId} still ${last.status} after the wait budget`
        : `no update for order ${orderId} within the wait budget`,
    );
    this.name = 'OrderWaitTimeoutError';
  }
}

/**
 * Resolve on the first update for `id` that is terminal. The socket-fed twin of
 * `track`, minus the polling.
 *
 * Unlike `track`, an aborted wait REJECTS rather than resolving: `track` always
 * holds an order it just fetched, a subscription may have seen nothing yet, and
 * a promise that resolves with nothing is worse than one that says why it
 * stopped.
 *
 * An order already terminal before you subscribed sends no further update —
 * `swap.get(id)` answers that case, this one waits for a transition.
 */
export function waitForOrder(
  socket: SocketLike,
  id: string,
  { isTerminal = (order) => TERMINAL_ORDER_STATUSES.has(order.status), timeoutMs = 15 * 60_000, signal }: WaitForOrderOptions = {},
): Promise<Order> {
  return new Promise<Order>((resolve, reject) => {
    let last: Order | undefined;

    const unsubscribe = orderUpdates(socket, (order) => {
      if (order.id !== id) return;
      last = order;
      if (isTerminal(order)) settle(() => resolve(order));
    });

    const timer = setTimeout(() => settle(() => reject(new OrderWaitTimeoutError(id, last))), timeoutMs);
    const onAbort = () => settle(() => reject(signal?.reason));
    signal?.addEventListener('abort', onAbort);

    function settle(finish: () => void): void {
      unsubscribe();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      finish();
    }

    if (signal?.aborted) onAbort();
  });
}
