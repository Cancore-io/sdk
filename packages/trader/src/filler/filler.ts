/**
 * `createFiller` and the public surface of sdk.md §3.6.
 *
 * This is the skeleton: configuration, validation of what is injected, hook
 * registration, and the methods with their final signatures. The protocol
 * behind each method lands in its own task, named in its `NotImplementedError`.
 */
import type { DecString, Hex, QuoteReconfirm, QuoteRequest, StakeBindingRequest, TicketIssued, TicketOffer } from '@cancore/contracts';
import { isEvmChainId, type EvmChainId } from './chains';
import { FillerConfigError, NotImplementedError } from './errors';
import { noopEventSink, type EventSink } from './events';
import type { CantonLedger } from './ledger';
import type { EvmRpcMap } from './rpc';
import { silentLogger, systemClock, type Clock, type HttpFetch, type Logger, type WebSocketFactory } from './runtime';
import type { FillSigner, QuoteSigner, StakingSigner } from './signer';
import type { FillerStore } from './store';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FillerConfig {
  /** `wss://<filler-gateway host>/v1`; REST fallback is on the same host. `ws://` only for a local stand. */
  gatewayUrl: string;
  /** The filler's id at filler-gateway, `^[a-z0-9][a-z0-9-]{0,62}$` (protocol §3.1). */
  fillerId: string;
  /**
   * The pinned filler-gateway address that signs every filler-gateway → filler
   * frame (`GatewayMessage`). Release data: `FILLER_GATEWAYS[env].gateway` in
   * `@cancore/contracts`.
   */
  gatewaySigner: Hex;
  /** Cancore ticket signers (`FILLER_GATEWAYS[env].ticketSigners`); a ticket by anyone else is declined. */
  ticketSigners: readonly Hex[];
  /** Quote key: `FillerAuth` and `FillerQuote`. Must be a different key from every fill key (N-6). */
  quoteSigner: QuoteSigner;
  /** Fill key per EVM chain the filler delivers on or settles on. */
  fillSigners: { readonly [chain: EvmChainId]: FillSigner };
  /** RPC endpoints per EVM chain; every chain in `fillSigners` needs at least one. */
  rpc: EvmRpcMap;
  /** The filler's own Canton participant; required only for Canton routes. */
  ledger?: CantonLedger;
  /** All filler state (sdk.md S16). The filler node passes its Postgres store. */
  store: FillerStore;
  /** Connections to filler-gateway. Required: Node 20 has no global `WebSocket`. */
  webSocket: WebSocketFactory;
  /** Defaults to the global `fetch`. */
  fetch?: HttpFetch;
  /** Defaults to the system clock. */
  clock?: Clock;
  /** Defaults to a logger that drops everything. */
  logger?: Logger;
  /** Defaults to a sink that drops everything. */
  events?: EventSink;
  /**
   * This replica's identity, the owner of the nonce leases it takes. Unique per
   * running process; defaults to a random UUID.
   */
  instanceId?: string;
}

// ---------------------------------------------------------------------------
// Hooks — what the filler decides (plan §14a.4)
// ---------------------------------------------------------------------------

/** A firm price for a `quote.request`. */
export interface QuoteDecision {
  /** Output, destination base units. */
  amountOut: bigint | DecString;
  /** Unix seconds; how long the quote is firm. */
  validUntil: bigint | DecString;
}

/** `null` skips the request. */
export type QuoteRequestHook = (request: QuoteRequest) => Promise<QuoteDecision | null>;

/** Whether the filler still stands behind its quote for the opened order. */
export type ReconfirmHook = (reconfirm: QuoteReconfirm) => Promise<boolean>;

export type TicketOfferDecision = 'accept' | 'decline';
export type TicketOfferHook = (offer: TicketOffer) => Promise<TicketOfferDecision>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface SelfSettleResult {
  txHash: Hex;
}

/** V2 only: the draw is recomputed locally (auction-and-draw.md §12). */
export interface DrawVerification {
  winner: string;
  recomputedWinner: string;
  match: boolean;
  drandRound: DecString;
}

export interface EscrowVerification {
  ok: boolean;
  /** Why not, when `ok` is false. */
  reason?: string;
}

export interface BindStakeOptions {
  /** EVM chain of the `CNRXStaking` deployment. */
  chain: EvmChainId;
}

/** sdk.md §3.6. V1: `reliability`, `capacityUsd`, `inFlightUsd` are informational. */
export interface FillerStatsSnapshot {
  won: number;
  delivered: number;
  noShow: number;
  reliability: number;
  capacityUsd: string;
  inFlightUsd: string;
}

// ---------------------------------------------------------------------------
// The filler
// ---------------------------------------------------------------------------

export interface Filler {
  /** The id this filler logs in with. */
  readonly fillerId: string;
  /** This replica's nonce-lease owner id. */
  readonly instanceId: string;
  onQuoteRequest(hook: QuoteRequestHook): void;
  onReconfirm(hook: ReconfirmHook): void;
  onTicketOffer(hook: TicketOfferHook): void;
  /**
   * Login by challenge, heartbeat, reconnect, REST fallback; reconciles from
   * the store and the chain, then quotes, takes tickets, fills and settles every
   * won fill on its own. Requires all three hooks.
   */
  start(): Promise<void>;
  /** Closes the session. In-flight work stays in the store for any replica to resume. */
  stop(): Promise<void>;
  /** Settles one order now from the attestation set held for it, or pulled from filler-gateway. */
  selfSettle(orderHash: Hex): Promise<SelfSettleResult>;
  /** V2. */
  verifyDraw(orderHash: Hex): Promise<DrawVerification>;
  /** Own RPC / own participant; runs automatically before every `TicketReceipt`. */
  verifyEscrow(ticket: TicketIssued): Promise<EscrowVerification>;
  /** Signs a `StakeBinding` with the staking key. */
  bindStake(stakingSigner: StakingSigner, options: BindStakeOptions): Promise<StakeBindingRequest>;
  stats(): Promise<FillerStatsSnapshot>;
}

const FILLER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function requireAddress(field: string, value: unknown): void {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new FillerConfigError(field, 'expected a 0x-prefixed 20-byte address');
}

function requireMethods(field: string, value: unknown, methods: readonly string[]): void {
  if (!isObject(value)) throw new FillerConfigError(field, 'is required');
  for (const method of methods) {
    if (typeof value[method] !== 'function') throw new FillerConfigError(field, `must implement ${method}()`);
  }
}

function defaultInstanceId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID !== 'function') throw new FillerConfigError('instanceId', 'no global crypto.randomUUID; pass instanceId');
  return crypto.randomUUID();
}

function defaultFetch(): HttpFetch | undefined {
  const fetch = (globalThis as { fetch?: unknown }).fetch;
  return typeof fetch === 'function' ? (fetch as HttpFetch) : undefined;
}

/** Holds `config` to the rules above; throws `FillerConfigError` naming the first field at fault. */
function validate(config: FillerConfig): void {
  if (!isObject(config)) throw new FillerConfigError('config', 'is required');
  if (typeof config.gatewayUrl !== 'string' || !/^wss?:\/\/[^/]+/.test(config.gatewayUrl)) {
    throw new FillerConfigError('gatewayUrl', 'expected a ws:// or wss:// URL');
  }
  if (typeof config.fillerId !== 'string' || !FILLER_ID.test(config.fillerId)) {
    throw new FillerConfigError('fillerId', 'expected ^[a-z0-9][a-z0-9-]{0,62}$');
  }
  requireAddress('gatewaySigner', config.gatewaySigner);
  if (!Array.isArray(config.ticketSigners) || config.ticketSigners.length === 0) {
    throw new FillerConfigError('ticketSigners', 'expected at least one address');
  }
  config.ticketSigners.forEach((signer, i) => requireAddress(`ticketSigners[${i}]`, signer));

  requireMethods('quoteSigner', config.quoteSigner, ['signTypedData']);
  requireAddress('quoteSigner.address', config.quoteSigner.address);

  if (!isObject(config.fillSigners) || Object.keys(config.fillSigners).length === 0) {
    throw new FillerConfigError('fillSigners', 'expected a fill signer for at least one EVM chain');
  }
  if (!isObject(config.rpc)) throw new FillerConfigError('rpc', 'is required');
  const quoteKey = config.quoteSigner.address.toLowerCase();
  for (const [chain, signer] of Object.entries(config.fillSigners)) {
    if (!isEvmChainId(chain)) throw new FillerConfigError(`fillSigners.${chain}`, 'key must be an eip155 CAIP-2 chain id');
    requireMethods(`fillSigners.${chain}`, signer, ['signTypedData', 'signTransaction']);
    requireAddress(`fillSigners.${chain}.address`, signer.address);
    if (signer.address.toLowerCase() === quoteKey) {
      throw new FillerConfigError(`fillSigners.${chain}`, 'the fill key must differ from the quote key (keys are separate by purpose)');
    }
    const endpoints = config.rpc[chain];
    if (!Array.isArray(endpoints) || endpoints.length === 0) throw new FillerConfigError(`rpc.${chain}`, 'expected at least one endpoint');
  }
  for (const [chain, endpoints] of Object.entries(config.rpc)) {
    if (!isEvmChainId(chain)) throw new FillerConfigError(`rpc.${chain}`, 'key must be an eip155 CAIP-2 chain id');
    (endpoints as readonly unknown[]).forEach((endpoint, i) => requireMethods(`rpc.${chain}[${i}]`, endpoint, ['request']));
  }

  if (config.ledger !== undefined) requireMethods('ledger', config.ledger, ['activeContracts', 'exercise']);
  requireMethods('store', config.store, ['now', 'withOrder', 'listOpenOrders', 'appendEvidence', 'getOverrides']);
  requireMethods('store.quotes', config.store.quotes, ['nextNonce', 'recordQuote', 'recordAck', 'listQuotes']);
  requireMethods('store.nonces', config.store.nonces, ['allocate', 'renew', 'recordTransaction', 'complete', 'claimExpired', 'listOpen']);

  if (typeof config.webSocket !== 'function') {
    throw new FillerConfigError('webSocket', 'a WebSocketFactory is required (Node 20 has no global WebSocket); see the README for a `ws` adapter');
  }
  if (config.fetch !== undefined && typeof config.fetch !== 'function') throw new FillerConfigError('fetch', 'expected a function');
  if (config.clock !== undefined) requireMethods('clock', config.clock, ['now', 'schedule']);
  if (config.logger !== undefined) requireMethods('logger', config.logger, ['debug', 'info', 'warn', 'error']);
  if (config.events !== undefined) requireMethods('events', config.events, ['emit']);
  if (config.instanceId !== undefined && (typeof config.instanceId !== 'string' || config.instanceId.length === 0)) {
    throw new FillerConfigError('instanceId', 'expected a non-empty string');
  }
}

/** The resolved dependencies every protocol component of this entry receives. */
export interface FillerContext {
  readonly config: Readonly<FillerConfig>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly events: EventSink;
  readonly fetch: HttpFetch | undefined;
  readonly instanceId: string;
}

/**
 * Builds a filler from injected dependencies. Validates them up front and
 * throws `FillerConfigError` for anything missing or malformed — never a
 * `ReferenceError` later. Opens no connection until `start()`.
 */
export function createFiller(config: FillerConfig): Filler {
  validate(config);
  const context: FillerContext = {
    config,
    clock: config.clock ?? systemClock,
    logger: config.logger ?? silentLogger,
    events: config.events ?? noopEventSink,
    fetch: config.fetch ?? defaultFetch(),
    instanceId: config.instanceId ?? defaultInstanceId(),
  };

  let quoteHook: QuoteRequestHook | undefined;
  let reconfirmHook: ReconfirmHook | undefined;
  let ticketHook: TicketOfferHook | undefined;

  const hook = <T>(name: string, value: T): T => {
    if (typeof value !== 'function') throw new FillerConfigError(name, 'expected a function');
    return value;
  };

  return {
    fillerId: config.fillerId,
    instanceId: context.instanceId,
    onQuoteRequest: (h) => void (quoteHook = hook('onQuoteRequest', h)),
    onReconfirm: (h) => void (reconfirmHook = hook('onReconfirm', h)),
    onTicketOffer: (h) => void (ticketHook = hook('onTicketOffer', h)),
    async start() {
      if (!quoteHook) throw new FillerConfigError('onQuoteRequest', 'register the hook before start()');
      if (!reconfirmHook) throw new FillerConfigError('onReconfirm', 'register the hook before start()');
      if (!ticketHook) throw new FillerConfigError('onTicketOffer', 'register the hook before start()');
      throw new NotImplementedError('start', 'CAN-1847');
    },
    async stop() {
      // Nothing is open until start() exists (CAN-1847).
    },
    selfSettle: async () => {
      throw new NotImplementedError('selfSettle', 'CAN-1856');
    },
    verifyDraw: async () => {
      throw new NotImplementedError('verifyDraw', 'CAN-1848');
    },
    verifyEscrow: async () => {
      throw new NotImplementedError('verifyEscrow', 'CAN-1854');
    },
    bindStake: async () => {
      throw new NotImplementedError('bindStake', 'CAN-1857');
    },
    stats: async () => {
      throw new NotImplementedError('stats', 'CAN-1940');
    },
  };
}
