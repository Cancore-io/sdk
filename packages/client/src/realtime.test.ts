import { ORDER_UPDATED_EVENT, OrderWaitTimeoutError, orderUpdates, waitForOrder } from './realtime';
import type { Order } from './swap';

/** A Socket.IO socket reduced to what this module touches, plus a way to push. */
function fakeSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event: string, handler: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set.add(handler));
    },
    off(event: string, handler: (payload: unknown) => void) {
      handlers.get(event)?.delete(handler);
    },
    /** What the gateway does: hand every listener the payload. */
    push(event: string, payload: unknown) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
    listeners(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

const order = (id: string, status: Order['status']) => ({ id, status }) as Order;

describe('orderUpdates', () => {
  test('subscribes to the gateway event and hands the payload straight through', () => {
    const socket = fakeSocket();
    const seen: Order[] = [];
    orderUpdates(socket, (o) => seen.push(o));

    socket.push(ORDER_UPDATED_EVENT, order('o1', 'open'));

    expect(seen).toEqual([{ id: 'o1', status: 'open' }]);
  });

  test('the returned unsubscribe removes that listener and nothing else', () => {
    const socket = fakeSocket();
    const seen: Order[] = [];
    const stop = orderUpdates(socket, (o) => seen.push(o));
    orderUpdates(socket, () => {});
    expect(socket.listeners(ORDER_UPDATED_EVENT)).toBe(2);

    stop();
    socket.push(ORDER_UPDATED_EVENT, order('o1', 'open'));

    expect(socket.listeners(ORDER_UPDATED_EVENT)).toBe(1);
    expect(seen).toEqual([]);
  });
});

describe('waitForOrder', () => {
  test('resolves on the first terminal update and leaves no listener behind', async () => {
    const socket = fakeSocket();
    const waiting = waitForOrder(socket, 'o1');

    socket.push(ORDER_UPDATED_EVENT, order('o1', 'accepted'));
    socket.push(ORDER_UPDATED_EVENT, order('o1', 'completed'));
    socket.push(ORDER_UPDATED_EVENT, order('o1', 'refunded'));

    await expect(waiting).resolves.toEqual({ id: 'o1', status: 'completed' });
    expect(socket.listeners(ORDER_UPDATED_EVENT)).toBe(0);
  });

  test('ignores an order that is not the one asked for', async () => {
    // The gateway broadcasts every order to every client, so this is the
    // common case, not an edge one: without the filter the first terminal
    // order on the whole venue would resolve the wait.
    const socket = fakeSocket();
    const waiting = waitForOrder(socket, 'o1', { timeoutMs: 1 });

    socket.push(ORDER_UPDATED_EVENT, order('somebody-else', 'completed'));

    await expect(waiting).rejects.toMatchObject({ name: 'OrderWaitTimeoutError', last: undefined });
  });

  test('a custom isTerminal decides instead', async () => {
    const socket = fakeSocket();
    const waiting = waitForOrder(socket, 'o1', { isTerminal: (o) => o.status === 'accepted' });

    socket.push(ORDER_UPDATED_EVENT, order('o1', 'accepted'));

    await expect(waiting).resolves.toEqual({ id: 'o1', status: 'accepted' });
  });

  test('the timeout carries the last update it saw for that order', async () => {
    const socket = fakeSocket();
    const waiting = waitForOrder(socket, 'o1', { timeoutMs: 1 });

    socket.push(ORDER_UPDATED_EVENT, order('o1', 'accepted'));
    socket.push(ORDER_UPDATED_EVENT, order('o1', 'swap_created'));

    await expect(waiting).rejects.toThrow(OrderWaitTimeoutError);
    await waiting.catch((error: OrderWaitTimeoutError) => {
      expect(error.orderId).toBe('o1');
      expect(error.last).toEqual({ id: 'o1', status: 'swap_created' });
      expect(error.message).toContain('still swap_created');
    });
    expect(socket.listeners(ORDER_UPDATED_EVENT)).toBe(0);
  });

  test('a timeout with nothing seen says so rather than pretending to a last order', async () => {
    const socket = fakeSocket();
    await expect(waitForOrder(socket, 'o1', { timeoutMs: 1 })).rejects.toThrow(
      'no update for order o1 within the wait budget',
    );
  });

  test('an AbortSignal stops the wait and rejects with the signal reason', async () => {
    const socket = fakeSocket();
    const controller = new AbortController();
    const waiting = waitForOrder(socket, 'o1', { signal: controller.signal });

    controller.abort(new Error('caller gave up'));

    await expect(waiting).rejects.toThrow('caller gave up');
    expect(socket.listeners(ORDER_UPDATED_EVENT)).toBe(0);
  });

  test('a signal already aborted never subscribes for long', async () => {
    const socket = fakeSocket();
    const waiting = waitForOrder(socket, 'o1', { signal: AbortSignal.abort(new Error('too late')) });

    await expect(waiting).rejects.toThrow('too late');
    expect(socket.listeners(ORDER_UPDATED_EVENT)).toBe(0);
  });
});
