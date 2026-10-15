import type { KeySigner } from '@cancore/client/selfcustody';
import type { DenyReason, Method, Params, RiskClass } from './protocol/index';

/** Encrypted-at-rest key storage. The plaintext key exists only between unlock and lock. */
export interface Keystore {
  /** Creates a new keystore file from a mnemonic; refuses to overwrite. */
  init(mnemonic: string, passphrase: string): Promise<void>;
  /** Decrypts the key into memory; throws on a wrong passphrase. */
  unlock(passphrase: string): Promise<BotSigner>;
  /** Wipes the in-memory key. Idempotent. */
  lock(): void;
  isLocked(): boolean;
  /** Hex Ed25519 public key; readable while locked. */
  publicKey(): Promise<string>;
}

/** The daemon's signer: the client's KeySigner plus a wipe. Never serialised, never sent over the socket. */
export interface BotSigner extends KeySigner {
  signPreparedHash(preparedTransactionHashB64: string): Promise<string>;
  /** Zeroes the key material; every later call throws. */
  destroy(): void;
}

export interface AuditEntry {
  /** Monotonic, starting at 0. */
  seq: number;
  /** ISO-8601 UTC. */
  at: string;
  /** `settle`: what the background settlement loop did (a fill, an expiry, a refused signature). */
  method: Method | 'settle';
  riskClass: RiskClass;
  decision: 'allow' | 'deny' | 'error';
  reason?: DenyReason | string;
  params?: unknown;
  /** sha256 hex of the previous entry's line; 64 zeros for seq 0. */
  prev: string;
  /** sha256 hex of this entry without `hash`. */
  hash: string;
}

/** Append-only, hash-chained JSONL. */
export interface AuditLog {
  append(entry: Omit<AuditEntry, 'seq' | 'at' | 'prev' | 'hash'>): Promise<AuditEntry>;
  /** Re-walks the chain; `brokenAt` is the first seq whose hash or prev does not match. */
  verify(): Promise<{ ok: true; entries: number } | { ok: false; brokenAt: number }>;
  tail(n: number): Promise<AuditEntry[]>;
  /** Flushes pending appends and closes the file. */
  close(): Promise<void>;
}

/** Owner-set limits. Amounts are decimal strings. Absent = not allowed (default-deny). */
export interface Limits {
  /** Pairs as `BASE/QUOTE`; only these may trade. */
  allowedPairs: string[];
  /** Per-instrument cap on a single order's amount. */
  maxOrderAmount: Record<string, string>;
  /** Per-quote-instrument cap on a single order's notional. */
  maxOrderNotional: Record<string, string>;
  /** Per-instrument rolling 24h traded amount. */
  maxDailyVolume: Record<string, string>;
  /** Per-instrument net position cap (absolute). */
  maxPosition: Record<string, string>;
  maxOpenOrders: number;
  /** Max deviation from the reference price, in basis points. */
  maxPriceDeviationBps: number;
  /** Max trade commands per minute. */
  maxCommandsPerMinute: number;
}

/** Everything the risk gate needs to decide; the daemon owns and persists it. */
export interface BotState {
  locked: boolean;
  paused: boolean;
  pauseReason?: string;
  partyId?: string;
  /** Orders this bot made, and orders of others it took (`taken`), until they settle or end. */
  openOrders: { orderId: string; pair: string; side: 'buy' | 'sell'; amount: string; price: string; taken?: boolean; strategy?: { id: string; slot: string } }[];
  /** Every strategy started, with what it placed; a running one resumes on unlock. */
  strategies?: StrategyRecord[];
  /** Per-instrument net position, decimal string. */
  positions: Record<string, string>;
  /** Per-instrument traded amount in the rolling 24h window. */
  dailyVolume: Record<string, string>;
  /** Epoch ms of recent trade commands, for the rate limit. */
  recentCommands: number[];
  /** Reference prices per pair, decimal string. */
  referencePrices: Record<string, string>;
  /** Fills of the last 24h, the source of `dailyVolume`. Epoch ms, base instrument, base amount. */
  fills?: { at: number; instrument: string; amount: string }[];
  /** The last audit entry this state has seen: a log that no longer holds it was truncated. */
  lastAuditSeq?: number;
  lastAuditHash?: string;
}

export interface Command<M extends Method = Method> {
  method: M;
  params: Params<M>;
}

export type Decision = { allow: true } | { allow: false; reason: DenyReason };

/** Pure: no I/O, no clock beyond `now`. Anything not explicitly allowed is denied. */
export type RiskGate = (cmd: Command, state: BotState, limits: Limits, now: number) => Decision;

/** A strategy's persisted state. Its open orders are the `openOrders` tagged with its id. */
export interface StrategyRecord {
  strategyId: string;
  kind: 'grid' | 'dca';
  base: string;
  quote: string;
  /** Validated against `gridConfig` / `dcaConfig` when started. */
  config: Record<string, unknown>;
  /** `denied`/`failed`: stopped by a refusal or an error, see `reason`. `rate_limited`: waiting for its hourly budget. */
  status: 'running' | 'rate_limited' | 'denied' | 'failed' | 'stopped' | 'done';
  reason?: string;
  /** grid: the `level:side` slots that should have an open order. */
  want: string[];
  /** Epoch ms of every order placed: dca's next seq is its length; the last hour is the `ordersPerHour` budget. */
  placed: number[];
  fills: number;
}

/** One order a strategy wants placed; `slot` keeps it idempotent across restarts. */
export interface StrategyOrder {
  slot: string;
  side: 'buy' | 'sell';
  amount: string;
  price: string;
}

/** An order of someone else's, as the API lists it: `source` is what its maker gives. */
export interface OrderInfo {
  orderId: string;
  status: string;
  source: string;
  sourceAmount: string;
  target: string;
  targetAmount: string;
}

/** Self-custody trading over the client; every signature goes through the verifying signer (verify.ts). */
export interface Engine {
  make(params: Params<'order.make'>): Promise<{ orderId: string }>;
  /** Queues the taker side on the settlement loop; resolves once queued, not once settled. */
  take(params: Params<'order.take'>): Promise<{ orderId: string; filled: string }>;
  cancel(orderId: string): Promise<void>;
  /** Any order by id: one to take, or one of ours to reconcile. */
  order(orderId: string): Promise<OrderInfo>;
  balances(instruments: string[]): Promise<{ instrument: string; amount: string; locked: string }[]>;
  /** Market rate per `BASE/QUOTE`, both directions of every listed pair. */
  referencePrices(): Promise<Record<string, string>>;
  /** Sends `amount` of `instrument` to `to`; the daemon has already held `to` to the pinned owner party. */
  withdraw(to: string, instrument: string, amount: string): Promise<void>;
  /** Starts the background DvP settlement loop (make and take sides, autoWithdraw of expired allocations). */
  start(): void;
  /** Stops the settlement loop; a step already being signed finishes. */
  stop(): Promise<void>;
}

/** What the engine reports back to the daemon. */
export interface EngineHooks {
  /** A trade this account was in settled. */
  onSettled(orderId: string): void;
  /** A trade ended unsettled (expired, cancelled). */
  onEnded(orderId: string, reason: string): void;
  /** A prepared transaction's hash did not match its bytes, or a hash nobody verified was given to sign. */
  onVerifyFailed(reason: string): void;
}
