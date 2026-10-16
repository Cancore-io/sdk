import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { DENY_REASONS, ERROR, PARAMS, RISK_CLASS, type Method, type RiskClass } from '@cancore/botd/protocol';

/** The slice of the ipc client this server uses; injected so tests need no socket. */
export interface BotClient {
  call(method: Method, params: unknown): Promise<unknown>;
}

/**
 * The daemon methods an agent may reach. Owner-class methods (unlock, lock,
 * resume, limits.set, withdraw) are absent by construction: withdraw exists only
 * on the owner socket, to the pinned owner party. No key export exists at all.
 */
export const AGENT_METHODS: readonly Method[] = (Object.keys(RISK_CLASS) as Method[]).filter(
  (method) => RISK_CLASS[method] !== 'owner',
);

export const toolName = (method: Method): string => `trade_${method.replace(/\./g, '_')}`;

const EFFECT: Record<Method, string> = {
  status: "daemon state: locked, paused, the bot's party, strategies (with slots cancelled by hand), version",
  balances: 'balances per instrument',
  quote: 'a live pool price for an amount of base; nothing is traded',
  'orders.list': "the bot's orders, filtered by status (default open)",
  'limits.get': 'the limits the owner set, read-only',
  'audit.tail': 'the last n audit-log entries',
  'order.cancel': 'cancels one open order',
  'orders.cancelAll': 'cancels every open order',
  pause: 'pauses trading; only the owner can resume',
  'strategy.stop': 'stops a running strategy',
  'order.make': 'places a limit order (maker)',
  'order.take': 'fills an existing order (taker)',
  'strategy.start': 'starts a grid or dca strategy',
  unlock: '',
  register: '',
  lock: '',
  resume: '',
  'limits.set': '',
  withdraw: '',
};

const ANNOTATIONS: Record<Exclude<RiskClass, 'owner'>, ToolAnnotations> = {
  read: { readOnlyHint: true },
  reduce: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  trade: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

const BOUNDARY =
  'Limits are enforced by the daemon, not by this tool; a refusal returns {denied: reason}. Withdraw, limit changes, unlock and resume are owner-only and do not exist here.';

// An id, decimal or enum: no whitespace, so no free-form sentence; anything else is dropped. Only fields the
// daemon or the Cancore API fills are whitelisted; counterparty text (names, memos, metadata) never is.
const TOKEN = /^[\w.:\-+@/#=]{0,256}$/;
const token = (v: unknown) => (typeof v === 'string' && TOKEN.test(v) ? v : undefined);
const scalar = (v: unknown) => (typeof v === 'number' || typeof v === 'boolean' ? v : token(v));
// Money fields carry a decimal and nothing else, so a token-shaped instruction cannot ride in one.
const DECIMAL = /^-?\d{1,40}(\.\d{1,40})?$/;
const DECIMAL_KEYS = new Set(['amount', 'price', 'filled', 'total']);

function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (source === null || typeof source !== 'object') return out;
  for (const key of keys) {
    const raw = (source as Record<string, unknown>)[key];
    const value = DECIMAL_KEYS.has(key) && typeof raw === 'string' && !DECIMAL.test(raw) ? undefined : scalar(raw);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const LIMIT_NUMBERS = ['maxOpenOrders', 'maxPriceDeviationBps', 'maxCommandsPerMinute'] as const;
const LIMIT_CAPS = ['maxOrderAmount', 'maxOrderNotional', 'maxDailyVolume', 'maxPosition'] as const;
// A cap is instrument -> decimal: both the key and the value are checked.
const caps = (m: unknown) =>
  Object.fromEntries(Object.entries(m !== null && typeof m === 'object' ? m : {}).filter(([i, v]) => token(i) !== undefined && typeof v === 'string' && DECIMAL.test(v)));
const limits = (l: any) => ({
  ...pick(l, LIMIT_NUMBERS),
  allowedPairs: list(l?.allowedPairs).map(token).filter((v) => v !== undefined),
  ...Object.fromEntries(LIMIT_CAPS.map((k) => [k, caps(l?.[k])])),
});
const AUDIT = ['seq', 'at', 'method', 'riskClass', 'decision'] as const;
const denyReason = (v: unknown) => (typeof v === 'string' && (DENY_REASONS as readonly string[]).includes(v) ? v : undefined);

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ORDER = ['orderId', 'base', 'quote', 'side', 'amount', 'price', 'filled', 'status', 'createdAt'] as const;
const order = (o: unknown) => pick(o, ORDER);

/**
 * Whitelist per method. Counterparty-controlled text (memos, metadata, names)
 * never reaches the model: that is the prompt-injection surface.
 */
const VIEW: Record<Method, (r: any) => unknown> = {
  status: (r) => ({
    ...pick(r, ['locked', 'paused', 'partyId', 'version']),
    strategies: list(r?.strategies).map((s: any) => ({
      ...pick(s, ['strategyId', 'kind', 'running', 'status', 'placed', 'fills']),
      // Only a known deny code: a free-text reason may carry an error message built from untrusted input.
      reason: denyReason(s?.reason),
      cancelledByUser: list(s?.cancelledByUser).map(token).filter((v) => v !== undefined),
    })),
  }),
  balances: (r) => ({ balances: list(r?.balances).map((b) => pick(b, ['instrument', 'amount'])) }),
  quote: (r) => pick(r, ['base', 'quote', 'side', 'amount', 'price', 'total', 'expiresInSec']),
  'orders.list': (r) => ({ orders: list(r?.orders).map(order) }),
  'limits.get': (r) => ({ limits: limits(r?.limits) }),
  'audit.tail': (r) => ({ entries: list(r?.entries).map((e: any) => ({ ...pick(e, AUDIT), reason: denyReason(e?.reason) })) }),
  'order.cancel': (r) => pick(r, ['orderId', 'cancelled']),
  'orders.cancelAll': (r) => ({ cancelled: list(r?.cancelled).map(token).filter((v) => v !== undefined) }),
  pause: (r) => pick(r, ['paused']),
  'strategy.stop': (r) => pick(r, ['strategyId', 'stopped']),
  'order.make': (r) => ({ order: order(r?.order) }),
  'order.take': (r) => pick(r, ['orderId', 'filled']),
  'strategy.start': (r) => pick(r, ['strategyId']),
  unlock: () => ({}),
  register: () => ({}),
  lock: () => ({}),
  resume: () => ({}),
  'limits.set': () => ({}),
  withdraw: () => ({}),
};

export const view = (method: Method, result: unknown): unknown => VIEW[method](result);

type ToolReply = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function reply(payload: Record<string, unknown>, isError = false): ToolReply {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, ...(isError && { isError }) };
}

const UNCONFIRMED_ACT = 'The order may exist. Do not place it again: the daemon confirms or drops it within minutes; check trade_orders_list.';

const OWNER_ACTS = 'The owner must act via the cancore-bot CLI; no tool here can change this.';

/** Daemon errors to tool replies. DENIED is an answer, not a crash: the agent should read the reason. */
export function errorReply(err: unknown, method?: Method): ToolReply {
  // ipc/client rejects with RpcCallError { error: RpcError }; duck-typed so this file needs no ipc import.
  const rpc = err !== null && typeof err === 'object' && 'error' in err ? (err as { error: unknown }).error : err;
  const e = (rpc ?? {}) as { code?: number; data?: { reason?: unknown }; message?: unknown };
  switch (e.code) {
    case ERROR.DENIED:
      return reply({ denied: denyReason(e.data?.reason) ?? 'no_rule' }, true);
    case ERROR.LOCKED:
      return reply({ error: 'locked', instruction: `The keystore is locked. ${OWNER_ACTS} (cancore-bot unlock)` }, true);
    case ERROR.PAUSED:
      return reply({ error: 'paused', instruction: `Trading is paused. ${OWNER_ACTS} (cancore-bot resume)` }, true);
    case ERROR.FORBIDDEN:
      return reply({ error: 'forbidden', instruction: 'This socket peer is not allowed this method.' }, true);
    case ERROR.INVALID_PARAMS:
      return reply({ error: 'invalid_params' }, true);
    case ERROR.UNCONFIRMED:
      return reply({ error: 'unconfirmed', instruction: UNCONFIRMED_ACT }, true);
    default:
      // A trade that died mid-call (connection dropped, daemon error) may still have placed its order.
      return reply({ error: 'daemon_error', ...(typeof e.code === 'number' && { code: e.code }), ...(method && RISK_CLASS[method] === 'trade' && { instruction: UNCONFIRMED_ACT }) }, true);
  }
}

/** Tool name → risk class and one-line effect, for `trade_tools` and the README. */
export function inventory() {
  return AGENT_METHODS.map((method) => ({ tool: toolName(method), riskClass: RISK_CLASS[method], effect: EFFECT[method] }));
}

export async function callTool(getClient: () => Promise<BotClient>, method: Method, args: unknown): Promise<ToolReply> {
  // Validated here, before the socket: bad amounts never leave the process. Over MCP the SDK has already
  // stripped unknown keys (it builds a non-strict object from the shape), so they are dropped, not refused.
  const params = PARAMS[method].safeParse(args ?? {});
  if (!params.success) return reply({ error: 'invalid_params', issues: params.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, true);
  try {
    const result = await (await getClient()).call(method, params.data);
    return reply(view(method, result) as Record<string, unknown>);
  } catch (err) {
    if (err instanceof SocketError) return reply({ error: 'socket_unavailable', instruction: err.message }, true);
    return errorReply(err, method);
  }
}

export class SocketError extends Error {}

export function registerBotTools(server: McpServer, getClient: () => Promise<BotClient>): McpServer {
  for (const method of AGENT_METHODS) {
    const risk = RISK_CLASS[method] as Exclude<RiskClass, 'owner'>;
    server.registerTool(
      toolName(method),
      {
        description: `${EFFECT[method]}. Risk class: ${risk}. ${BOUNDARY}`,
        inputSchema: PARAMS[method].shape,
        annotations: { title: toolName(method), ...ANNOTATIONS[risk] },
      },
      // The SDK strips unknown keys before this handler; callTool validates what remains.
      (async (args: unknown) => callTool(getClient, method, args)) as never,
    );
  }
  server.registerTool(
    'trade_tools',
    {
      description: `Lists every tool here with its risk class (read, reduce, trade) and effect. ${BOUNDARY}`,
      inputSchema: {},
      annotations: { title: 'trade_tools', readOnlyHint: true },
    },
    async () => reply({ tools: inventory() }),
  );
  return server;
}

export function createServer(getClient: () => Promise<BotClient>, version: string): McpServer {
  return registerBotTools(new McpServer({ name: 'cancore-bot-mcp', version }), getClient);
}
