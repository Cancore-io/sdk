/**
 * `FillerStore` — all filler state, injected.
 *
 * The SDK keeps nothing that lives only in memory (sdk.md S16). Whatever it
 * must remember goes through this interface, and `cancore-filler-node`
 * implements it on Postgres: one database shared by every replica of the node,
 * each replica with its own session to filler-gateway under the one `fillerId`
 * (filler-node.md §3.5, N-32…N-36; protocol T-10). The interface is shaped for
 * that implementation:
 *
 * - **Async everywhere.** Every call may hit the database.
 * - **Per-order transactions.** `withOrder(orderHash, work)` runs `work` in one
 *   store transaction holding an exclusive lock on that `orderHash` (in
 *   Postgres: `SELECT … FOR UPDATE` on the order row, or
 *   `pg_advisory_xact_lock` on the hash). Two replicas never move one order at
 *   once (N-33). Everything `work` writes commits together when it resolves and
 *   is rolled back when it throws.
 * - **Idempotent writes.** The same frame recorded twice changes nothing: the
 *   evidence journal and the quote ledger are keyed by message identity and
 *   report whether the write was new, so a frame redelivered to another session,
 *   or received over WebSocket and REST, is handled once (N-35).
 * - **Nonces by lease.** EVM nonces are allocated atomically per
 *   `(chain, address)` with a lease (owner, expiry by STORE time); only the
 *   lease owner broadcasts on that nonce (N-9, N-34).
 * - **No keys.** The store holds no key material (N-5).
 *
 * Wire payloads are the `@cancore/contracts` message types, stored as received.
 * Identifiers are lowercase hex: the SDK lowercases before it calls the store.
 *
 * An in-memory implementation for tests is `InMemoryFillerStore` in
 * `@cancore/trader/filler/testing`; it is not for production.
 */
import type {
  DecString,
  Hex,
  OrderSettled,
  QuoteAck,
  QuoteMessage,
  QuoteReconfirmReply,
  TicketDecline,
  TicketExpired,
  TicketIntentAck,
  TicketIntentMessage,
  TicketIssued,
  TicketOffer,
  TicketReceiptMessage,
} from '@cancore/contracts';
import type { Caip2, EvmChainId } from './chains';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * State of one ticket attempt, `(orderHash, attempt)`. Filler-gateway sends at
 * most one of each message per attempt, in order (protocol §3.5 «Tickets»):
 * `ticket.offer` → `ticket.intent.ack` → `ticket.issued` → `ticket.expired`.
 */
export type TicketState =
  /** `ticket.offer` stored; the filler's hook has not answered yet. */
  | 'offered'
  /** `ticket.intent` sent (signed `TicketIntent`). */
  | 'intent-sent'
  /** `ticket.intent.ack` received. */
  | 'intent-acked'
  /** `ticket.issued` received; escrow and ticket checks run next. */
  | 'issued'
  /** The checks before the receipt are running; whoever finishes them moves it on, once. */
  | 'checking'
  /** `ticket.receipt` sent: the filler is now bound to deliver. */
  | 'receipted'
  /** `ticket.decline` sent (by the hook or by the SDK's checks). */
  | 'declined'
  /** Own `fill` confirmed on the destination. */
  | 'filled'
  /** `ticket.expired` received; terminal. */
  | 'expired';

export interface TicketRecord {
  orderHash: Hex;
  attempt: number;
  state: TicketState;
  offer?: TicketOffer;
  intent?: TicketIntentMessage;
  intentAck?: TicketIntentAck;
  issued?: TicketIssued;
  receipt?: TicketReceiptMessage;
  decline?: TicketDecline;
  expired?: TicketExpired;
  /** When `ticket.issued` first arrived, unix ms by the process clock (V-T4 compares it with `acceptBy + δ_issue`). */
  issuedAtMs?: number;
  /**
   * When the message of the current state — the intent, the receipt or the
   * decline — was handed to filler-gateway, unix ms. Unset while it is only
   * written down: after a restart it is sent again (the same bytes, never
   * signed twice), while its deadline lasts.
   */
  sentAtMs?: number;
  /** Set together with `sentAtMs` when the deadline passed before the message could go out: it never will. */
  unsent?: true;
  /** Unix ms, store time of the last write. */
  updatedAtMs: number;
}

/**
 * Where an own delivery stands:
 * - `pending` — claimed by `owner` until `leaseUntilMs` (store time); nothing broadcast yet;
 * - `sent` — broadcast; `txRef` is the latest transaction on its nonce;
 * - `included` — in a block (`inclusion`), not yet `fillConfirmations` deep;
 * - `confirmed` — deep enough: the delivery is done;
 * - `failed` — reverted, or its nonce went to another transaction (`reason`).
 */
export type FillState = 'pending' | 'sent' | 'included' | 'confirmed' | 'failed';

/**
 * Proof that a fill was included (fillers.md T-30, R-3): the block header and
 * the receipt as the RPC returned them. Kept once seen, so a fill reorged out
 * after `validUntil` stays provable — not a no-show.
 */
export interface InclusionProof {
  blockNumber: DecString;
  blockHash: Hex;
  header: Readonly<Record<string, unknown>>;
  receipt: Readonly<Record<string, unknown>>;
  /** Unix ms, process clock. */
  seenAtMs: number;
}

/** Own delivery of one attempt. */
export interface FillRecord {
  orderHash: Hex;
  attempt: number;
  /** Destination chain. */
  chain: Caip2;
  /** EVM transaction hash (the latest on its nonce), or the Canton update id; empty while `pending`. */
  txRef: string;
  /** Amount sent, destination base units. */
  amount: DecString;
  /** What the recipient received, as the router measured it (`Filled.received`); below `amount` for a fee-on-transfer asset. */
  received?: DecString;
  state: FillState;
  /** EVM: the delivery key's nonce the fill went out on. */
  nonce?: DecString;
  /** `pending`: the replica sending it (`FillerConfig.instanceId`). */
  owner?: string;
  /** `pending`: unix ms by store time; past it another replica may take the attempt over. */
  leaseUntilMs?: number;
  /** First broadcast, unix ms by the process clock (latency metrics). */
  sentAtMs?: number;
  /** The last inclusion seen. */
  inclusion?: InclusionProof;
  /** `failed`: why. */
  reason?: string;
  updatedAtMs: number;
}

/** Which channel delivered an attestation set (sdk.md S14). */
export type AttestationChannel = 'ws' | 'rest';

/**
 * The attestation set for one attempt — the first one to arrive, from either
 * channel; later copies are duplicates (dedup by `orderHash` + `attempt`).
 */
export interface AttestationRecord {
  orderHash: Hex;
  attempt: number;
  channel: AttestationChannel;
  /**
   * The `settle.attestations` frame (or REST body) as the verbatim UTF-8 bytes
   * received. Its typed shape comes from `@cancore/contracts` once the frame is
   * added there; the store does not interpret it.
   */
  raw: Uint8Array;
  /** Result of the SDK's verification; a set that failed is never submitted (N-31). */
  verified: boolean;
  /** Why verification failed. */
  reason?: string;
  receivedAtMs: number;
}

export type SettlementState = 'sent' | 'confirmed' | 'settled' | 'failed';

/** Own `settle` of an order, then `order.settled` from filler-gateway. */
export interface SettlementRecord {
  orderHash: Hex;
  attempt: number;
  state: SettlementState;
  /** Source chain the `settle` went to. */
  chain?: Caip2;
  txHash?: Hex;
  orderSettled?: OrderSettled;
  /** Why it failed (revert reason, `refundAfter` passed). */
  reason?: string;
  updatedAtMs: number;
}

/** Direction of a journalled frame. */
export type EvidenceDirection = 'from-gateway' | 'to-gateway';

/**
 * One entry of the append-only evidence journal (N-14): every
 * filler-gateway-signed frame received and every receipt sent, as the
 * verbatim bytes with their signatures. Kept while a dispute is possible.
 */
export interface EvidenceEntry {
  /** Message identity: keccak256 of `raw`. A byte-identical redelivery has the same id. */
  id: Hex;
  direction: EvidenceDirection;
  /** The frame's `type`, e.g. `quote.ack`, `ticket.issued`, `ticket.receipt`. */
  type: string;
  orderHash?: Hex;
  attempt?: number;
  requestId?: string;
  raw: Uint8Array;
  atMs: number;
}

/** A quote the filler sent, and the `quote.ack` that answered it. */
export interface StoredQuote {
  requestId: string;
  /** EIP-712 digest of the `FillerQuote`; `quote.ack.quoteHash` echoes it. */
  quoteHash: Hex;
  /**
   * The `quote` frame as sent; for a price confirmed through `quote.reconfirm`, its `FillerQuote`
   * content only (`QuoteContent`): such a price never travels as a `quote` frame and has no envelope
   * of its own — `via` is the sealed `quote.reconfirm.reply` that carried it, the evidence.
   */
  quote: QuoteMessage | QuoteContent;
  /** The sealed `quote.reconfirm.reply` that carried a reconfirmed price. */
  via?: QuoteReconfirmReply;
  ack?: QuoteAck;
  sentAtMs: number;
}

/** A quote's `FillerQuote` content without a frame envelope (`id`, `fillerId`, `sentAt`, `msgSig`). */
export type QuoteContent = Omit<QuoteMessage, 'id' | 'fillerId' | 'sentAt' | 'msgSig'>;

/** Runtime overrides an operator sets on a running node (N-13): apply to every replica at once. */
export interface RuntimeOverrides {
  /** Kill-switch: no new quotes, no new ticket intents. Receipted tickets are still delivered and settled. */
  paused: boolean;
  /** Node-specific overrides (routes, limits, price parameters); opaque to the SDK. */
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Nonce leases
// ---------------------------------------------------------------------------

export interface NonceLease {
  chain: EvmChainId;
  address: Hex;
  nonce: bigint;
  /** The replica that holds it (`FillerConfig.instanceId`). */
  owner: string;
  /** Unix ms by store time. */
  expiresAtMs: number;
}

/** `cancel`: a zero-value transfer to self that frees a nonce whose transaction can no longer succeed. */
export type InFlightKind = 'fill' | 'settle' | 'approve' | 'cancel';

/**
 * A transaction on a leased nonce, recorded before it is broadcast.
 * Replacements (replace-by-fee) append another.
 */
export interface InFlightTransaction {
  hash: Hex;
  /** The raw signed transaction, so a new lease owner can rebroadcast it. */
  raw: Hex;
  kind: InFlightKind;
  orderHash?: Hex;
  attempt?: number;
  /** The call, so a new lease owner can replace it without decoding `raw`. */
  to: Hex;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  sentAtMs: number;
}

export interface NonceRecord extends NonceLease {
  transactions: readonly InFlightTransaction[];
  state: 'open' | 'mined';
  /** Hash of the transaction that consumed the nonce on chain. */
  minedHash?: Hex;
}

export interface NonceAllocation {
  chain: EvmChainId;
  address: Hex;
  owner: string;
  ttlMs: number;
  /**
   * `eth_getTransactionCount(address, 'pending')` as the caller just read it.
   * The store returns `max(chainNonce, highest nonce ever allocated + 1)`.
   */
  chainNonce: bigint;
}

/**
 * EVM nonces of the fill addresses. All operations are atomic in the store;
 * "held" means owner matches and the lease has not expired by store time.
 */
export interface NonceLeases {
  /** Allocates the next nonce of `(chain, address)` and leases it to `owner`. */
  allocate(request: NonceAllocation): Promise<NonceLease>;
  /** Extends a held lease; `null` when it is no longer held (expired or taken over). */
  renew(lease: NonceLease, ttlMs: number): Promise<NonceLease | null>;
  /** Records a broadcast; `false` (and nothing written) when the lease is no longer held. Re-check right before every broadcast. */
  recordTransaction(lease: NonceLease, tx: InFlightTransaction): Promise<boolean>;
  /** Marks the nonce consumed on chain by `minedHash`; `false` when the lease is no longer held. */
  complete(lease: NonceLease, minedHash: Hex): Promise<boolean>;
  /**
   * Takes over every open nonce of `(chain, address)` whose lease expired,
   * leasing it to `owner` for `ttlMs`. The new owner reads the chain before it
   * resubmits or replaces (N-34).
   */
  claimExpired(request: { chain: EvmChainId; address: Hex; owner: string; ttlMs: number }): Promise<readonly NonceRecord[]>;
  /** Every open nonce of `(chain, address)`, held or not, ascending. */
  listOpen(chain: EvmChainId, address: Hex): Promise<readonly NonceRecord[]>;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface QuoteLedger {
  /**
   * The next `FillerQuote.nonce` for `requestId` under the quote key `signer`:
   * strictly greater than any nonce returned before for that pair, on any
   * replica (protocol §3.3).
   */
  nextNonce(requestId: string, signer: Hex): Promise<bigint>;
  /** Stores a sent quote; `false` when one with this `quoteHash` is already stored. */
  recordQuote(quote: StoredQuote): Promise<boolean>;
  /** Attaches `ack` to the quote with `ack.quoteHash`; `false` when already attached or no such quote. */
  recordAck(ack: QuoteAck): Promise<boolean>;
  /** Quotes sent for `requestId`, oldest first. */
  listQuotes(requestId: string): Promise<readonly StoredQuote[]>;
}

// ---------------------------------------------------------------------------
// Per-order transaction
// ---------------------------------------------------------------------------

/**
 * The view of one order inside `withOrder`. Valid only until `work` settles;
 * using it afterwards throws.
 */
export interface OrderTransaction {
  readonly orderHash: Hex;
  getTicket(attempt: number): Promise<TicketRecord | undefined>;
  /** Every attempt of this order, ascending. */
  listTickets(): Promise<readonly TicketRecord[]>;
  /** Inserts or replaces the record of `record.attempt`. */
  putTicket(record: TicketRecord): Promise<void>;
  getFill(attempt: number): Promise<FillRecord | undefined>;
  putFill(record: FillRecord): Promise<void>;
  getAttestations(attempt: number): Promise<AttestationRecord | undefined>;
  putAttestations(record: AttestationRecord): Promise<void>;
  getSettlement(): Promise<SettlementRecord | undefined>;
  putSettlement(record: SettlementRecord): Promise<void>;
  /** Appends to the evidence journal in this transaction; `false` when `entry.id` is already journalled. */
  appendEvidence(entry: EvidenceEntry): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface FillerStore {
  /** Store time, unix ms (Postgres `now()`); nonce leases expire by it. */
  now(): Promise<number>;
  /**
   * Runs `work` in one transaction holding the exclusive lock of `orderHash`.
   * Commits what it wrote when it resolves; rolls back when it throws, and
   * rethrows. Calls for one `orderHash` run one at a time, across replicas;
   * calls for different hashes run concurrently.
   */
  withOrder<T>(orderHash: Hex, work: (tx: OrderTransaction) => Promise<T>): Promise<T>;
  /**
   * Orders that still need work after a restart (N-15): a ticket in a
   * non-terminal state, a `declined` ticket whose decline has not gone out
   * yet (`sentAtMs` unset), or a fill without a `settled` settlement.
   */
  listOpenOrders(): Promise<readonly Hex[]>;
  readonly quotes: QuoteLedger;
  readonly nonces: NonceLeases;
  /** Appends evidence that belongs to no order (`quote.request`, `quote.ack`); `false` when already journalled. */
  appendEvidence(entry: EvidenceEntry): Promise<boolean>;
  getOverrides(): Promise<RuntimeOverrides>;
}
