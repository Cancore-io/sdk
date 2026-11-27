import { dec } from './decimal';
import { RpcFault } from './ipc/server';
import { ERROR } from './protocol/index';
import type { BotState } from './types';

/** Someone else's order as a trade of ours on an allowed pair (`takeView`): what a take books. */
export type Taken = { base: string; quote: string; side: 'buy' | 'sell'; amount: string; price: string };

/** A take booked earlier on other terms than `taken` (BUG-1637): replacing it for the limit check would leave its smaller or other-pair reservation on the book. Throws on an amount that does not parse. */
export function bookedOnOtherTerms(book: BotState['openOrders'], orderId: string, taken: Taken): boolean {
  const earlier = book.find((o) => o.taken && o.orderId === orderId);
  return !!earlier && (earlier.pair !== `${taken.base}/${taken.quote}` || earlier.side !== taken.side || dec(earlier.amount) !== dec(taken.amount) || dec(earlier.price) !== dec(taken.price));
}

export const booked = (s: BotState, orderId: string): boolean => s.openOrders.some((o) => o.orderId === orderId);

export function takeCalledOff(locked: boolean, paused: boolean): RpcFault {
  if (locked) return new RpcFault(ERROR.LOCKED, 'locked: the take was called off');
  if (paused) return new RpcFault(ERROR.PAUSED, 'paused: the take was called off');
  return new RpcFault(ERROR.INVALID_PARAMS, 'not booked: its earlier booking was dropped (a cancel, a release or the order ending) while this take was queued; take it again', { reason: 'cancelled' } as never);
}
