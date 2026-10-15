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
  method: Method;
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
  openOrders: { orderId: string; pair: string; side: 'buy' | 'sell'; amount: string; price: string }[];
  /** Per-instrument net position, decimal string. */
  positions: Record<string, string>;
  /** Per-instrument traded amount in the rolling 24h window. */
  dailyVolume: Record<string, string>;
  /** Epoch ms of recent trade commands, for the rate limit. */
  recentCommands: number[];
  /** Reference prices per pair, decimal string. */
  referencePrices: Record<string, string>;
}

export interface Command<M extends Method = Method> {
  method: M;
  params: Params<M>;
}

export type Decision = { allow: true } | { allow: false; reason: DenyReason };

/** Pure: no I/O, no clock beyond `now`. Anything not explicitly allowed is denied. */
export type RiskGate = (cmd: Command, state: BotState, limits: Limits, now: number) => Decision;

export interface StrategyHandle {
  strategyId: string;
  kind: 'grid' | 'dca';
  stop(): Promise<void>;
}

/** Self-custody trading over the client; every order goes through verify before signing. */
export interface Engine {
  make(params: Params<'order.make'>): Promise<{ orderId: string }>;
  take(params: Params<'order.take'>): Promise<{ orderId: string; filled: string }>;
  cancel(orderId: string): Promise<void>;
  /** Runs the strategy loop until stopped. */
  serve(strategy: Params<'strategy.start'>): Promise<StrategyHandle>;
}
