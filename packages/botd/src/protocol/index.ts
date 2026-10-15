import { z } from 'zod';

/**
 * The cancore-botd wire protocol: JSON-RPC 2.0 over a unix socket.
 *
 * This entry is schemas and types only. It must never import keystore, signer
 * or engine code: `@cancore/bot-mcp` and any other socket client depend on it,
 * and a client that could reach the key is the thing this split prevents.
 */

export const JSONRPC_VERSION = '2.0' as const;

/**
 * What a method can do to the owner's funds, which decides who may call it.
 * - `read`   — no state change.
 * - `reduce` — can only lower exposure (cancel, pause).
 * - `trade`  — opens exposure, always behind the risk gate and limits.
 * - `owner`  — changes the trust boundary itself (unlock, limits, resume).
 *              Owner CLI only; bot-mcp must never expose these.
 */
export type RiskClass = 'read' | 'reduce' | 'trade' | 'owner';

const amount = z.string().regex(/^\d+(\.\d+)?$/, 'decimal string');
const instrument = z.string().min(1);
const side = z.enum(['buy', 'sell']);

/** Params schema per method. Empty object = no params. */
export const PARAMS = {
  // read
  status: z.object({}).strict(),
  balances: z.object({}).strict(),
  'orders.list': z.object({ status: z.enum(['open', 'filled', 'cancelled', 'all']).default('open') }).strict(),
  'limits.get': z.object({}).strict(),
  'audit.tail': z.object({ n: z.number().int().positive().max(1000).default(50) }).strict(),
  // reduce
  'order.cancel': z.object({ orderId: z.string().min(1) }).strict(),
  'orders.cancelAll': z.object({}).strict(),
  pause: z.object({ reason: z.string().max(500).optional() }).strict(),
  'strategy.stop': z.object({ strategyId: z.string().min(1) }).strict(),
  // trade
  'order.make': z
    .object({ base: instrument, quote: instrument, side, amount, price: amount, ttlSeconds: z.number().int().positive().optional() })
    .strict(),
  'order.take': z.object({ orderId: z.string().min(1), amount }).strict(),
  'strategy.start': z
    .object({ kind: z.enum(['grid', 'dca']), base: instrument, quote: instrument, config: z.record(z.unknown()) })
    .strict(),
  // owner
  unlock: z.object({ passphrase: z.string().min(1) }).strict(),
  lock: z.object({}).strict(),
  resume: z.object({}).strict(),
  'limits.set': z.object({ limits: z.record(z.unknown()) }).strict(),
  /** Only to the owner party pinned in the daemon's config; anything else is refused. */
  withdraw: z.object({ to: z.string().min(1), instrument, amount }).strict(),
} as const;

export type Method = keyof typeof PARAMS;
export type Params<M extends Method> = z.infer<(typeof PARAMS)[M]>;

export const RISK_CLASS: Record<Method, RiskClass> = {
  status: 'read',
  balances: 'read',
  'orders.list': 'read',
  'limits.get': 'read',
  'audit.tail': 'read',
  'order.cancel': 'reduce',
  'orders.cancelAll': 'reduce',
  pause: 'reduce',
  'strategy.stop': 'reduce',
  'order.make': 'trade',
  'order.take': 'trade',
  'strategy.start': 'trade',
  unlock: 'owner',
  lock: 'owner',
  resume: 'owner',
  'limits.set': 'owner',
  withdraw: 'owner',
};

export const METHODS = Object.keys(PARAMS) as Method[];

/** Result payloads. Amounts are decimal strings, never floats. */
export interface OrderView {
  orderId: string;
  base: string;
  quote: string;
  side: 'buy' | 'sell';
  amount: string;
  price: string;
  filled: string;
  status: 'open' | 'filled' | 'cancelled';
  createdAt: string;
}

export interface StatusResult {
  locked: boolean;
  paused: boolean;
  pauseReason?: string;
  partyId?: string;
  strategies: { strategyId: string; kind: 'grid' | 'dca'; running: boolean; status: string; reason?: string; placed: number; fills: number }[];
  version: string;
}

export interface Results {
  status: StatusResult;
  balances: { balances: { instrument: string; amount: string; locked: string }[] };
  'orders.list': { orders: OrderView[] };
  'limits.get': { limits: Record<string, unknown> };
  'audit.tail': { entries: Record<string, unknown>[] };
  'order.cancel': { orderId: string; cancelled: true };
  'orders.cancelAll': { cancelled: string[] };
  pause: { paused: true };
  'strategy.stop': { strategyId: string; stopped: true };
  'order.make': { order: OrderView };
  'order.take': { orderId: string; filled: string };
  'strategy.start': { strategyId: string };
  unlock: { locked: false };
  lock: { locked: true };
  resume: { paused: false };
  'limits.set': { limits: Record<string, unknown> };
  withdraw: { to: string; instrument: string; amount: string };
}

export type Result<M extends Method> = Results[M];

/** Error codes: JSON-RPC standard range plus the daemon's own (-32000..-32099). */
export const ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** The risk gate refused; `data.reason` is a DenyReason. */
  DENIED: -32001,
  /** The keystore is locked; the owner must `unlock`. */
  LOCKED: -32002,
  /** Trading is paused; only read/reduce/owner methods pass. */
  PAUSED: -32003,
  /** The caller's socket peer is not allowed this risk class. */
  FORBIDDEN: -32004,
} as const;

export type ErrorCode = (typeof ERROR)[keyof typeof ERROR];

/** Why the risk gate said no. Default-deny: anything unmatched is `no_rule`. */
export const DENY_REASONS = [
  'no_rule',
  'instrument_not_allowed',
  'order_size_exceeded',
  'notional_exceeded',
  'daily_volume_exceeded',
  'position_exceeded',
  'open_orders_exceeded',
  'price_deviation_exceeded',
  'rate_limited',
  'verify_failed',
  'paused',
  'locked',
] as const;

export type DenyReason = (typeof DENY_REASONS)[number];

export interface RpcRequest<M extends Method = Method> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  method: M;
  params?: Params<M>;
}

export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: { reason?: DenyReason; [key: string]: unknown };
}

export type RpcResponse<M extends Method = Method> =
  | { jsonrpc: typeof JSONRPC_VERSION; id: string | number | null; result: Result<M> }
  | { jsonrpc: typeof JSONRPC_VERSION; id: string | number | null; error: RpcError };

export const requestEnvelope = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: z.union([z.string(), z.number()]),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();

/** Validates a raw request: envelope, known method, params. Trust boundary of the socket. */
export function parseRequest(
  raw: unknown,
): { ok: true; request: RpcRequest } | { ok: false; error: RpcError; id: string | number | null } {
  const envelope = requestEnvelope.safeParse(raw);
  if (!envelope.success) return { ok: false, id: null, error: { code: ERROR.INVALID_REQUEST, message: 'invalid request' } };
  const { id, method } = envelope.data;
  if (!Object.hasOwn(PARAMS, method)) return { ok: false, id, error: { code: ERROR.METHOD_NOT_FOUND, message: `unknown method ${method}` } };
  const params = PARAMS[method as Method].safeParse(envelope.data.params ?? {});
  if (!params.success) return { ok: false, id, error: { code: ERROR.INVALID_PARAMS, message: params.error.message } };
  return { ok: true, request: { jsonrpc: JSONRPC_VERSION, id, method: method as Method, params: params.data } };
}
