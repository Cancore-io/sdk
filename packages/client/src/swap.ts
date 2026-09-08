/**
 * `@cancore/client/swap` — the classic exchange, end to end: list what is on
 * offer, place an order, accept somebody else's, follow it to a terminal state;
 * and the pool trade, quote → execute, with no counterparty to wait for.
 *
 * Every shape below is the API's own DTO, field for field, as the gateway's
 * OpenAPI document declares it (`spec/openapi.json`, checked by spec.test.ts).
 * The two pool-trade shapes are the exception: /auto-trader is a separate
 * service the gateway document does not include, so they are written from the
 * responses the Cancore app itself consumes.
 *
 * Nothing here signs. Accepting an order is a POST; where a swap then needs the
 * user's signature (self-custody legs), that ceremony runs through
 * `@cancore/wallet/operations` or the dApp connector, not through this client.
 */
import { createHttp, type ClientOptions, type Http } from './http';

export type OrderStatus =
  | 'open'
  | 'accepted'
  | 'swap_created'
  | 'claimed'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'delivery_failed';

export type SwapStatus =
  | 'incomplete'
  | 'waiting_counter_accept'
  | 'both_active'
  | 'main_claimed'
  | 'counter_claimed'
  | 'both_claimed'
  | 'refunded';

/** States an order never leaves. `track` stops on these. */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'completed',
  'cancelled',
  'refunded',
  'delivery_failed',
]);

export interface OrderUser {
  id?: string;
  [key: string]: unknown;
}

/** `OrderResponseDto` */
export interface Order {
  id: string;
  sourceNetwork: string;
  sourceTokenAddress: string;
  sourceTokenName: string;
  sourceAmount: string;
  targetNetwork: string;
  targetTokenAddress: string;
  targetTokenName: string;
  targetAmount: string;
  initiatorUserId: string;
  opponentUserId?: string | null;
  initiator?: OrderUser;
  opponent?: OrderUser;
  swapId?: string | null;
  status: OrderStatus;
  swapStatus?: SwapStatus;
  swapLedgerStatus?: string;
  dvp?: boolean;
  mainHtlcRefunded?: boolean | null;
  counterHtlcRefunded?: boolean | null;
  mainHtlcExpired?: boolean | null;
  counterHtlcExpired?: boolean | null;
  retakeable?: boolean | null;
  swapTimeout?: string;
  swapCounterTimeout?: string;
  tradingPairId?: string;
  amountPrecision?: number;
  pricePrecision?: number;
  price?: string | null;
  expiresAt: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `CreateOrderDto` — an offer named by network + token address on both sides. */
export interface CreateOrderInput {
  sourceNetwork: string;
  sourceTokenAddress: string;
  sourceTokenName: string;
  sourceAmount: string;
  targetNetwork: string;
  targetTokenAddress: string;
  targetTokenName: string;
  targetAmount: string;
  expirationHours?: number;
  description?: string;
  dvp?: boolean;
}

/** `CreatePairOrderDto` — the same offer, named by a trading pair the venue lists. */
export interface CreatePairOrderInput {
  tradingPairId: string;
  sourceAmount: string;
  targetAmount: string;
  side?: 'buy' | 'sell';
  expirationHours?: number;
  description?: string;
}

/** `PaginatedOrderResponseDto` */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListOrdersQuery {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  sourceNetwork?: string;
  targetNetwork?: string;
  sourceTokenAddress?: string;
  targetTokenAddress?: string;
  status?: OrderStatus;
}

/** `POST /auto-trader/quote` — a live price for a pool trade, good for `expiresInSec`. */
export interface Quote {
  quoteToken: string;
  pairConfigId: string;
  sourceToken: string;
  sourceAmount: string;
  targetToken: string;
  targetAmount: string;
  marketRate: string;
  quotedRate: string;
  spreadPercent: string;
  expiresInSec: number;
}

/** `POST /auto-trader/execute` — the order the pool opened against you, and the trade record. */
export interface Executed {
  orderId: string;
  recordId: string;
}

export interface TrackOptions {
  /** Poll interval in milliseconds. Default 3000. */
  intervalMs?: number;
  /** Give up after this long. Default 15 minutes. Rejects with `TrackTimeoutError`. */
  timeoutMs?: number;
  /** Called on every poll with the latest order. */
  onUpdate?: (order: Order) => void;
  /** Stop early; resolves with the last order seen. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class TrackTimeoutError extends Error {
  constructor(
    readonly orderId: string,
    readonly last: Order,
  ) {
    super(`order ${orderId} still ${last.status} after the tracking budget`);
    this.name = 'TrackTimeoutError';
  }
}

export interface SwapClient {
  /** Open orders on the venue. */
  listOpen(query?: ListOrdersQuery): Promise<Page<Order>>;
  /** Orders the authenticated user created or accepted. */
  listMine(query?: ListOrdersQuery): Promise<Page<Order>>;
  get(id: string): Promise<Order>;
  create(input: CreateOrderInput): Promise<Order>;
  createForPair(input: CreatePairOrderInput): Promise<Order>;
  /** Take the other side of an open order. A POST — no signature crosses here. */
  accept(id: string): Promise<Order>;
  cancel(id: string): Promise<Order>;
  /** A live pool price. Rates move; the quote is good for `expiresInSec`. */
  quote(input: { pairConfigId: string; sourceAmount: number | string }): Promise<Quote>;
  /** Trade at a quoted price. Returns the order the pool opened for you. */
  execute(quoteToken: string): Promise<Executed>;
  /** Poll an order until it reaches a terminal status. */
  track(id: string, options?: TrackOptions): Promise<Order>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSwapClient(http: Http): SwapClient {
  return {
    listOpen: (query) => http.get('/orders', query),
    listMine: (query) => http.get('/orders/my', query),
    get: (id) => http.get(`/orders/${encodeURIComponent(id)}`),
    create: (input) => http.post('/orders', input),
    createForPair: (input) => http.post('/orders/pair', input),
    // AcceptOrderDto is `{}` — an empty body, not an absent one.
    accept: (id) => http.post(`/orders/${encodeURIComponent(id)}/accept`, {}),
    cancel: (id) => http.post(`/orders/${encodeURIComponent(id)}/cancel`),
    // The quote service takes a number where the rest of the API takes decimal
    // strings; the client converts so a caller can pass either.
    quote: ({ pairConfigId, sourceAmount }) =>
      http.post('/auto-trader/quote', { pairConfigId, sourceAmount: Number(sourceAmount) }),
    execute: (quoteToken) => http.post('/auto-trader/execute', { quoteToken }),

    async track(
      id,
      { intervalMs = 3000, timeoutMs = 15 * 60_000, onUpdate, signal, sleep = defaultSleep, now = Date.now } = {},
    ) {
      const deadline = now() + timeoutMs;
      for (;;) {
        const order = await http.get<Order>(`/orders/${encodeURIComponent(id)}`);
        onUpdate?.(order);
        if (TERMINAL_ORDER_STATUSES.has(order.status) || signal?.aborted) return order;
        if (now() + intervalMs > deadline) throw new TrackTimeoutError(id, order);
        await sleep(intervalMs);
      }
    },
  };
}

/** A swap client on its own, without assembling the whole client. */
export function swap(options: ClientOptions): SwapClient {
  return createSwapClient(createHttp(options));
}
