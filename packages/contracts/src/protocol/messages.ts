/**
 * The wire shapes of filler protocol v1 — WebSocket frames on `/v1`, REST
 * bodies and the public draw/epoch records — as TypeScript. The JSON Schemas
 * under `spec/protocol/` are normative; schemas.test.ts holds the enums below
 * to them. Encoding (protocol §3.1): uint64 and wider as decimal strings,
 * uint8/16/32 as JSON integers, on-chain times in seconds (decimal string),
 * gateway times in milliseconds (JSON integer), hex lowercase.
 *
 * Every frame in both directions is signed by its sender (protocol §3.4):
 * `sig` (gateway key, `GatewayMessage`) on S→F, `msgSig` (the filler's message
 * key, `FillerMessage`) on F→S, and carries `id`, `fillerId` and `sentAt`.
 *
 * Receivers ignore unknown fields and unknown S→F types (V-2), so none of
 * these types is closed. The enum types list the known values; the schemas
 * accept any UPPER_SNAKE value besides them, and a receiver treats an unknown
 * one as OTHER/generic (V-2).
 */
import type { SettleAttestations } from './settleAttestations';
import type { Hex } from './typedData';

/** Unsigned decimal string: uint64 and wider. */
export type DecString = string;
/** Unix milliseconds, gateway clock. */
export type TimeMs = number;
/** EVM token address, or a Canton instrument. */
export type WireAsset = Hex | { admin: string; id: string };

export const DECLINE_REASONS = [
  'NO_INVENTORY', 'RISK_LIMIT', 'PRICE_MOVED', 'PAUSED', 'OTHER',
  'TICKET_SIGNER_UNKNOWN', 'TICKET_MISMATCH', 'TICKET_TTL_TOO_SHORT', 'TICKET_ISSUED_LATE', 'TICKET_BEYOND_DEADLINE',
  'ESCROW_NOT_OPEN', 'ESCROW_MISMATCH', 'PROOF_WINDOW_TOO_SHORT', 'SKEW_MARGIN_TOO_SHORT', 'DRAW_MISMATCH',
] as const;
export const ERROR_CODES = [
  'BAD_REQUEST', 'UNAUTHENTICATED', 'UNSUPPORTED_VERSION', 'UNSUPPORTED_TYPE', 'BAD_SIGNATURE',
  'STALE_MESSAGE', 'REPLAYED_MESSAGE', 'TICKET_REFUSED',
  'UNKNOWN_REQUEST', 'UNKNOWN_TICKET', 'TICKET_CLOSED', 'NOT_ELIGIBLE', 'RATE_LIMITED', 'INTERNAL',
  'ATTESTATIONS_NOT_READY', 'CANTON_NOT_READY', 'CANTON_REFUSED', 'CANTON_UNAVAILABLE', 'OPERATION_EXPIRED',
  'ROUTE_NOT_APPROVED',
] as const;
/** HTTP status of each error code on the REST fallback. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400, UNAUTHENTICATED: 401, UNSUPPORTED_VERSION: 400, UNSUPPORTED_TYPE: 400, BAD_SIGNATURE: 422,
  STALE_MESSAGE: 400, REPLAYED_MESSAGE: 409, TICKET_REFUSED: 409,
  UNKNOWN_REQUEST: 404, UNKNOWN_TICKET: 404, TICKET_CLOSED: 409, NOT_ELIGIBLE: 403, RATE_LIMITED: 429, INTERNAL: 500,
  ATTESTATIONS_NOT_READY: 404, CANTON_NOT_READY: 409, CANTON_REFUSED: 422, CANTON_UNAVAILABLE: 503, OPERATION_EXPIRED: 410,
  ROUTE_NOT_APPROVED: 403,
};
/** `error.reason` with `TICKET_REFUSED`: the pre-ticket check that failed (S-21). */
export const TICKET_REFUSED_REASONS = [
  'REPAY_TO_INVALID', 'REPAY_TO_BLOCKLISTED', 'DELIVERY_KEY_INVALID', 'PAYOUT_NOT_READY', 'RECIPIENT_NOT_READY',
  'OPEN_TICKET_LIMIT', 'PROOF_WINDOW_TOO_SHORT', 'ATTESTOR_REVOCATION_PENDING', 'SERVICE_DEGRADED', 'OTHER',
] as const;
export const EXPIRED_RESULTS = ['FILLED', 'NO_SHOW', 'NO_SHOW_UNCONFIRMED', 'EXEMPT'] as const;
export const EXEMPT_REASONS = ['DESTINATION_HALTED', 'GATEWAY_FAULT', 'REORGED_AFTER_INCLUSION', 'RECIPIENT_NOT_READY', 'OTHER'] as const;
/** Verdict at receipt time, on the `quote.ack`. */
export const QUOTE_ACK_STATUSES = ['COUNTED', 'LATE', 'SHORT_TTL'] as const;
/** Final status of a quote, `GET /v1/filler/quotes`. */
export const QUOTE_FINAL_STATUSES = [...QUOTE_ACK_STATUSES, 'REPLACED', 'BAD_SIG', 'OUTLIER', 'IN_BAND', 'OUT_OF_BAND', 'WON', 'LOST'] as const;
/** `penalty.applied.step`: a violation recorded, a ban, a ban lifted by Cancore staff (penalties.md §4.2). */
export const PENALTY_STEPS = ['RECORDED', 'BANNED', 'UNBANNED'] as const;
export const DRAW_CLOSED_BY = ['OFFER_TIMEOUT', 'OFFER_DECLINE', 'TICKET_DECLINE', 'TICKET_EXPIRED', 'FILLED'] as const;
export const TICKET_LIST_STATUSES = ['OFFERED', 'ISSUED'] as const;
/** The Canton operations of the filler's own party (§3.19): the backend prepares and submits, the node signs with its party key. */
export const CANTON_OPS = ['party.allocate', 'registry.accept', 'delivery.fill', 'intent.settle', 'holdings.transfer', 'preapproval.create'] as const;
/** `holdings.transfer` result: the receiver holds it, or a TransferInstruction waits for it to accept. */
export const CANTON_TRANSFER_OUTCOMES = ['COMPLETED', 'PENDING'] as const;
export const CANTON_LEG_KINDS = ['transaction', 'topology'] as const;
export const CANTON_REGISTRY_STATES = ['NONE', 'PROPOSED', 'ACTIVE', 'REMOVED'] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type TicketRefusedReason = (typeof TICKET_REFUSED_REASONS)[number];
export type ExpiredResult = (typeof EXPIRED_RESULTS)[number];
export type ExemptReason = (typeof EXEMPT_REASONS)[number];
export type QuoteAckStatus = (typeof QUOTE_ACK_STATUSES)[number];
export type QuoteFinalStatus = (typeof QUOTE_FINAL_STATUSES)[number];
export type PenaltyStep = (typeof PENALTY_STEPS)[number];
export type DrawClosedBy = (typeof DRAW_CLOSED_BY)[number];
export type CantonOp = (typeof CANTON_OPS)[number];
export type CantonLegKind = (typeof CANTON_LEG_KINDS)[number];
export type CantonRegistryState = (typeof CANTON_REGISTRY_STATES)[number];

/** `ICancoreRouter.Order` on the wire: every numeric field a decimal string, as `canton-order.json`. */
export interface OrderJson {
  user: Hex; originChainId: DecString; inputToken: Hex; inputAmount: DecString; destination: Hex; outputAsset: Hex;
  minReceived: DecString; recipient: Hex; createdAt: DecString; fillDeadline: DecString; feeBps: DecString;
  fillerId: Hex;
}

/** Every S→F frame: signed by the gateway (`GatewayMessage`), addressed (`fillerId`) and timed (`sentAt`). */
export interface S2FBase {
  type: string;
  id: string;
  /** The addressee. Absent only on an `error` that refuses a login (`POST /v1/filler/auth`). */
  fillerId?: string;
  sentAt: TimeMs;
  sig: Hex;
  /** The F→S `id` this frame answers. */
  re?: string;
}
/**
 * What every filler → filler-gateway message and REST request body carries (S-19, T-13): `id` unique per
 * `fillerId` and direction, ≤ 64 characters; the sender's `fillerId`; `sentAt`; `msgSig` by the message key over
 * `FillerMessage{bodyHash: fillerMessageBodyHash(message)}`.
 */
export interface F2SEnvelope {
  id: string;
  fillerId: string;
  sentAt: TimeMs;
  msgSig: Hex;
  /** The S→F `id` this message answers. */
  re?: string;
}
export interface F2SBase extends F2SEnvelope {
  type: string;
}

/**
 * The login challenge: the body of `GET /v1/filler/auth/challenge?fillerId=`, addressed to that
 * `fillerId`. REST only — never on the WebSocket.
 */
export interface AuthChallenge extends S2FBase { type: 'auth.challenge'; fillerId: string; nonce: Hex; expiresAt: DecString }
/** The body of `POST /v1/filler/auth` (→ `AuthToken`). REST only — never on the WebSocket. */
export interface AuthResponse extends F2SBase {
  type: 'auth.response';
  fillerId: string;
  keyAddress: Hex;
  protocolVersion: '1';
  /** The `auth.challenge` nonce this answers (optional; senders should send it), so the login finds its challenge directly. */
  nonce?: Hex;
  sig: Hex;
}
export interface AuthOk extends S2FBase { type: 'auth.ok'; fillerId: string; heartbeatIntervalMs: number }
/** Heartbeat from the filler: signed with `msgSig`, like every F→S frame. */
export interface PingF2S extends F2SBase { type: 'ping' }
export interface PongF2S extends F2SBase { type: 'pong'; re: string }
/** Heartbeat from the gateway: signed, addressed and timed, like every S→F frame (D-C). */
export interface PingS2F extends S2FBase { type: 'ping'; fillerId: string }
export interface PongS2F extends S2FBase { type: 'pong'; fillerId: string; re: string }
export type Ping = PingF2S | PingS2F;
export type Pong = PongF2S | PongS2F;
export interface ErrorMessage extends S2FBase {
  type: 'error';
  code: ErrorCode;
  message: string;
  reason?: TicketRefusedReason;
  /** With `RATE_LIMITED`: ms (≥ 1) until the refused rate class may be used again, or until the cooldown ends. */
  retryAfterMs?: number;
}
/**
 * An unsigned, unaddressed refusal, so a filler cannot verify it; a hint only. Every 429 (`RATE_LIMITED`,
 * on every route), and the refusals of the login routes decided before any signature check:
 * 400 `BAD_REQUEST`, 404 `UNKNOWN_REQUEST`, and on `POST /v1/filler/auth` 401 `UNAUTHENTICATED`
 * (no live challenge for the fillerId: ask for a new one).
 */
export interface UnsignedErrorBody { type: 'error'; code: ErrorCode; message: string; retryAfterMs?: number }
/** The filler's reply to a gateway frame it cannot handle; informational. */
export interface ErrorF2S extends F2SBase { type: 'error'; re: string; code: ErrorCode; message: string }
export interface EpochWeights extends S2FBase { type: 'epoch.weights'; epochId: DecString; startsAt: DecString; endsAt: DecString; weightsRoot: Hex }

export interface QuoteRequest extends S2FBase {
  type: 'quote.request';
  requestId: string;
  route: { src: string; dst: string };
  inputToken: WireAsset;
  /** The total T the maker deposits, input base units. */
  inputAmount: DecString;
  outputAsset: WireAsset;
  feeBps: number;
  fillDeadlineHint: DecString;
  windowCloseAt: TimeMs;
  quoteTtlMs: number;
  imbalanceHint?: { dstAsset: WireAsset; netFlow24hUsd: string };
}
/** `sig` = `FillerQuote{requestIdHash(requestId), fillerId, amountOut, validUntil, nonce}` by the message key. */
export interface QuoteMessage extends F2SBase { type: 'quote'; requestId: string; amountOut: DecString; validUntil: DecString; nonce: DecString; sig: Hex }
export interface QuoteAck extends S2FBase { type: 'quote.ack'; requestId: string; quoteHash: Hex; receivedAt: TimeMs; status: QuoteAckStatus }
export interface QuoteReconfirm extends S2FBase {
  type: 'quote.reconfirm'; orderHash: Hex; requestId: string; order: OrderJson; amountOut: DecString; ticketTtl: number; replyBy: TimeMs;
}
export interface QuoteReconfirmReply extends F2SBase {
  type: 'quote.reconfirm.reply'; orderHash: Hex; accept: boolean; validUntil?: DecString; nonce?: DecString; sig?: Hex;
}

export interface TicketOffer extends S2FBase {
  type: 'ticket.offer'; orderHash: Hex; attempt: number; order: OrderJson; amountOut: DecString; validFrom: DecString; validUntil: DecString; acceptBy: TimeMs;
}
/** `sig` = `TicketIntent{orderHash, attempt, validFrom, validUntil, fillerId, deliveryKey, repayTo}` by the message key. */
export interface TicketIntentMessage extends F2SBase {
  type: 'ticket.intent'; orderHash: Hex; attempt: number; validFrom: DecString; validUntil: DecString;
  /** The address that will send `fill`; the zero address for a Canton destination. */
  deliveryKey: Hex;
  /** Where `settle` pays, encoded for the source chain. */
  repayTo: Hex;
  sig: Hex;
}
export interface TicketDecline extends F2SBase { type: 'ticket.decline'; orderHash: Hex; attempt: number; reason: DeclineReason; detail?: string }
export interface TicketIntentAck extends S2FBase { type: 'ticket.intent.ack'; orderHash: Hex; attempt: number; intentHash: Hex; receivedAt: TimeMs }
/** `FillTicket` on the wire; `fillerId` is the on-chain form, `fillerIdHash(fillerId)`. */
export interface TicketJson { orderHash: Hex; fillerId: Hex; deliveryKey: Hex; repayTo: Hex; attempt: number; validFrom: DecString; validUntil: DecString }
export interface TicketIssuedEvm extends S2FBase { type: 'ticket.issued'; form: 'evm'; orderHash: Hex; attempt: number; ticket: TicketJson; ticketSig: Hex }
export interface TicketIssuedCanton extends S2FBase {
  type: 'ticket.issued'; form: 'canton'; orderHash: Hex; attempt: number; deliveryOrderCid: string; validUntil: DecString; repayTo: Hex;
}
export type TicketIssued = TicketIssuedEvm | TicketIssuedCanton;
/** EVM-form receipt (`form` absent or `"evm"`): `sig` = `TicketReceipt{ticketHash, ticketSigHash}` by the message key. */
export interface TicketReceiptEvm extends F2SBase {
  type: 'ticket.receipt'; form?: 'evm'; orderHash: Hex; attempt: number; ticketHash: Hex; ticketSigHash: Hex; sig: Hex;
}
/** Canton-form receipt: `sig` = `CantonTicketReceipt` (`cantonTicketReceipt(frame)`) by the message key; fields as in `ticket.issued`. */
export interface TicketReceiptCanton extends F2SBase {
  type: 'ticket.receipt'; form: 'canton'; orderHash: Hex; attempt: number; deliveryOrderCid: string; validUntil: DecString; sig: Hex;
}
export type TicketReceiptMessage = TicketReceiptEvm | TicketReceiptCanton;
export interface FillReported extends F2SBase { type: 'fill.reported'; orderHash: Hex; attempt: number; txRef: string }
export interface TicketExpired extends S2FBase { type: 'ticket.expired'; orderHash: Hex; attempt: number; result: ExpiredResult; exemptReason?: ExemptReason }
export interface OrderSettled extends S2FBase {
  type: 'order.settled'; orderHash: Hex; payout: DecString; fee: DecString; penaltyWithheld: DecString; txRef: string;
}
export interface PenaltyApplied extends S2FBase { type: 'penalty.applied'; violationId: string; code: string; step: PenaltyStep; details: Record<string, unknown> }

// --- Canton operations of the filler's own party (§3.19). Hashes and party-key material are lowercase hex; the
// node signs the bytes of each leg's hash with its Ed25519 party key and never talks to a Ledger API.

/** A Canton asset: the instrument admin party and its id. */
export interface CantonAsset { admin: string; id: string }
/** What each op takes: the backend picks every contract itself. */
export interface CantonOpParams {
  'party.allocate': { publicKey: Hex };
  'registry.accept': Record<string, never>;
  'delivery.fill': { orderHash: Hex; attempt: number };
  'intent.settle': { orderHash: Hex };
  /** To a party other than the filler's own; never what the party's open delivery orders need. */
  'holdings.transfer': { asset: CantonAsset; amount: string; toParty: string };
  /** The party's transfer preapproval with the registry of the instrument admin `admin`: transfers to it complete at once. */
  'preapproval.create': { admin: string };
}
/** What the prepared legs do, by op: the node checks it before it signs. */
export interface CantonOpSummary {
  'party.allocate': {
    partyId: string; publicKey: Hex;
    /** On the Cancore participant alone, Confirmation, threshold 1: the node checks the decoded topology against it. */
    hosting: { participantUid: string; permission: 'CONFIRMATION'; threshold: 1 };
  };
  'registry.accept': { fillerId: string; party: string; operator: string; proposalCid: string };
  'delivery.fill': {
    orderHash: Hex; attempt: number; deliveryOrderCid: string; recipient: string; asset: CantonAsset; amount: string; repayTo: Hex; validUntil: DecString;
    /** The party's holdings the transfer spends; what they hold beyond `amount` comes back as change. */
    inputHoldingCids: string[];
    /** The transfer's executeBefore: the order's fillDeadline. */
    executeBefore: DecString;
    /** The registry factory the order pins. */
    transferFactoryCid: string;
  };
  'intent.settle': {
    orderHash: Hex; intentCid: string; asset: CantonAsset;
    /** What the payee is paid: `giveAmount` less `fee.amount`. */
    amount: string;
    executeBefore: DecString;
    /** The filler's own party. */
    payee: string;
    /** The intent's committed give, fee-inclusive. */
    giveAmount: string;
    /** The fee leg to the operator; amount 0 when there is none. */
    fee: { receiver: string; amount: string };
  };
  'holdings.transfer': { asset: CantonAsset; amount: string; receiver: string; inputHoldingCids: string[]; executeBefore: DecString };
  'preapproval.create': {
    /** The receiver: the filler's own party. */
    party: string;
    /** The registry's instrument admin, as asked. */
    admin: string;
    /** Instrument ids the preapproval is limited to; empty: every instrument of the admin. */
    instrumentAllowances: string[];
    /** Unix s. */
    requestedAt: DecString;
    /** Unix s: the preapproval expires then; renew it before. */
    executeBefore: DecString;
  };
}
/** What the committed operation created, by op. */
export interface CantonOpResult {
  'party.allocate': { partyId: string };
  'registry.accept': { entryCid: string };
  'delivery.fill': { receiptCid: string };
  'intent.settle': Record<string, never>;
  'holdings.transfer': { outcome: (typeof CANTON_TRANSFER_OUTCOMES)[number]; transferInstructionCid?: string };
  'preapproval.create': { preapprovalCid: string };
}
/**
 * A prepared transaction to sign. The node MUST, before signing (§3.19): recompute `hash` from
 * `preparedTransaction` with the hashing of `hashingSchemeVersion`, decode the transaction and check it against
 * the `summary` of the op (template and choice, parties, instrument, amount); on any difference, not sign.
 */
export interface CantonLegTransaction {
  legId: string;
  kind: 'transaction';
  /** 32 bytes. */
  hash: Hex;
  /** Base64 protobuf. Never logged. */
  preparedTransaction: string;
  /** e.g. `HASHING_SCHEME_VERSION_V2`. */
  hashingSchemeVersion: string;
}
/**
 * The party's onboarding topology, in `party.allocate` only. The node MUST, before signing (§3.19): recompute
 * the multihash over `topologyTransactions` and check they create `summary.partyId` with `summary.publicKey` as
 * its only signing key, hosted on the Cancore participant; on any difference, not sign.
 */
export interface CantonLegTopology {
  legId: string;
  kind: 'topology';
  /** `0x1220` ‖ sha256: 34 bytes. */
  hash: Hex;
  /** Base64 protobuf, in order. */
  topologyTransactions: string[];
}
/** One thing to sign. The kind is closed: a leg of any other kind is refused, never signed. */
export type CantonLeg = CantonLegTransaction | CantonLegTopology;
export interface CantonSignature { legId: string; signature: Hex }
export type CantonPrepare = { [K in CantonOp]: F2SBase & { type: 'canton.prepare'; op: K; params: CantonOpParams[K] } }[CantonOp];
export type CantonPrepared = {
  [K in CantonOp]: S2FBase & {
    type: 'canton.prepared'; fillerId: string; re: string; operationId: string; op: K;
    /** Topology legs with `party.allocate` only. */
    legs: K extends 'party.allocate' ? CantonLegTopology[] : CantonLegTransaction[];
    summary: CantonOpSummary[K]; expiresAt: TimeMs;
  };
}[CantonOp];
/** Idempotent per `operationId`: a repeat gets the same `canton.submitted`. */
export interface CantonSubmit extends F2SBase { type: 'canton.submit'; operationId: string; signatures: CantonSignature[] }
export type CantonSubmitted = {
  [K in CantonOp]: S2FBase & { type: 'canton.submitted'; fillerId: string; re: string; operationId: string; op: K; updateId?: string; result: CantonOpResult[K] };
}[CantonOp];

/** A route of the catalogue: CAIP-2 source and destination. */
export interface RouteRef { src: string; dst: string }
/** The full list of routes the filler serves from now on (§3.20); each must be approved for it, else ROUTE_NOT_APPROVED and nothing changes. */
export interface RoutesSet extends F2SBase { type: 'routes.set'; routes: RouteRef[] }
/** Every route approved for the filler; it is asked for quotes on a route only while `active`. */
export interface RoutesState extends S2FBase { type: 'routes.state'; fillerId: string; routes: (RouteRef & { active: boolean })[] }

export type S2FMessage =
  | AuthChallenge | AuthOk | PingS2F | PongS2F | ErrorMessage | EpochWeights | QuoteRequest | QuoteAck | QuoteReconfirm
  | TicketOffer | TicketIntentAck | TicketIssued | TicketExpired | OrderSettled | PenaltyApplied | SettleAttestations
  | CantonPrepared | CantonSubmitted | RoutesState;
export type F2SMessage =
  | AuthResponse | PingF2S | PongF2S | ErrorF2S | QuoteMessage | QuoteReconfirmReply | TicketIntentMessage | TicketDecline | TicketReceiptMessage | FillReported
  | CantonPrepare | CantonSubmit | RoutesSet;

// --- REST (protocol §3.6); an error body is the `error` message itself.

/** `POST /v1/filler/auth`: the bearer token of REST and of the WebSocket upgrade, bound to (fillerId, message key). */
export interface AuthToken { token: string; expiresAt: TimeMs }
/** `GET /v1/filler/auth/challenge` query. */
export interface ChallengeQuery { fillerId: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
export type TicketList = Page<TicketOffer | TicketIssued>;
export interface QuoteRecord { quote: QuoteMessage; ack: QuoteAck; status: QuoteFinalStatus }
export type QuoteList = Page<QuoteRecord>;
/** `GET /v1/filler/attestations/{orderHash}`: the `settle.attestations` frame itself, freshly signed. */
export type AttestationsResponse = SettleAttestations;
export interface StakeBindingRequest extends F2SEnvelope { partnerId: string; stakingAddress: Hex; chainId: DecString; nonce: DecString; sig: Hex }
export interface FillerStats { won: number; delivered: number; noShow: number; reliability: number; capacityUsd: string; inFlightUsd: string }
export interface PenaltyRecord { violationId: string; code: string; step: PenaltyStep; orderHash?: Hex; attempt?: number; at: TimeMs; details: Record<string, unknown> }
export type PenaltyList = Page<PenaltyRecord>;
/** `GET /v1/filler/canton/party`: the party registered for the fillerId and its `FillerRegistryEntry`. */
/** A live transfer preapproval of the party with one registry (`preapproval.create`). */
export interface CantonPreapproval { admin: string; contractId: string; instrumentAllowances: string[]; executeBefore: DecString }
export interface CantonParty {
  party: string | null;
  publicKey: Hex | null;
  registry: { state: CantonRegistryState; proposalCid: string | null; entryCid: string | null };
  /** The party's live transfer preapprovals, one per registry admin at most; absent from a gateway that predates them. */
  preapprovals?: CantonPreapproval[];
}
export interface CantonHolding { contractId: string; asset: CantonAsset; amount: string; locked: boolean }
/** `GET /v1/filler/canton/holdings`. */
export type CantonHoldingList = Page<CantonHolding>;
export interface CantonDeliveryOrder {
  deliveryOrderCid: string; orderHash: Hex; attempt: number; asset: CantonAsset; amount: string; recipient: string; repayTo: Hex; validUntil: DecString;
}
/** `GET /v1/filler/canton/delivery-orders`. */
export type CantonDeliveryOrderList = Page<CantonDeliveryOrder>;
/** One leg side of an AllocationV2 view; `otherside` is the owner of the other account. */
export interface CantonAllocationLeg { legId: string; side: 'SENDER' | 'RECEIVER'; otherside: string | null; amount: string; instrumentId: string }
/** A Token Standard V2 allocation by its view, as the operator (an executor) reads it. */
export interface CantonAllocation {
  contractId: string;
  /** `<package id>:<module>:<entity>`. */
  templateId: string;
  admin: string;
  /** The owner of the authorizer account. */
  authorizer: string | null;
  committed: boolean;
  settlementId: string;
  executors: string[];
  /** Unix seconds; null when the allocation has none. */
  settlementDeadline: DecString | null;
  legs: CantonAllocationLeg[];
}
/**
 * `GET /v1/filler/canton/intents/{orderHash}`: the live Canton-source `SwapIntent` naming the party as its
 * filler, as that party sees it, and its committed allocation (null when not live). The node checks it
 * before `ticket.receipt` (fillers.md V-C1…V-C6) and recomputes `orderHash` from these fields itself.
 */
export interface CantonIntent {
  intentCid: string;
  templateId: string;
  orderHash: Hex;
  owner: string;
  operator: string;
  filler: string;
  fillerId: string;
  requestId: string;
  asset: CantonAsset;
  /** The committed give, fee-inclusive, Daml Decimal. */
  amount: string;
  /** `Destination.Evm`. */
  destination: { chainId: DecString; token: Hex; recipient: Hex };
  minReceived: { units: DecString; decimals: number };
  feeRate: string;
  fillDeadline: DecString;
  refundAfter: DecString;
  /** The owner's signing time: the order's `createdAt`. */
  orderCreatedAt: DecString;
  allocationCid: string;
  allocation: CantonAllocation | null;
}

// --- Public records (auction-and-draw §3.3–3.4) and the gateway identity.

export interface DrawAttempt {
  attempt: number;
  tBase: DecString;
  closedBy: DrawClosedBy | null;
  drandRound: DecString;
  drandRandomness: Hex;
  drandSignature: Hex;
  candidates: { fillerId: string; weight: DecString }[];
  r: DecString;
  winnerFillerId: string;
  fallbackReason: 'DRAW_FALLBACK' | null;
}
export interface DrawRecord {
  orderHash: Hex; source: string; openRef: string; t0: DecString; epochId: DecString; deltaDrand: number; attempts: DrawAttempt[]; sig: Hex;
}
export interface EpochLeaf { fillerId: string; base: DecString; tier: number; reliabilityBps: number }
export interface EpochRecord {
  epochId: DecString;
  startsAt: DecString;
  endsAt: DecString;
  weightsRoot: Hex;
  leaves: EpochLeaf[];
  stakeSteps: { tier: number; minStake: DecString; step: DecString }[];
  rMinBps: number;
  snapshotBlocks: Record<string, DecString>;
  sig: Hex;
}
/** `GET /v1/gateway`: the mirror of `FILLER_GATEWAYS` for one environment. */
export interface GatewayInfo { env: string; gateway: Hex; ticketSigners: Hex[]; protocolVersion: '1'; maxMessageAgeMs: number }

/**
 * `FillerKeyRegistration` with its signature by the key being registered (§3.16): handed to Cancore at
 * onboarding and, signed by the NEW key, at a manual key change by staff. Not a frame — no message changes a key.
 */
export interface SignedFillerKeyRegistration { fillerId: string; messageKey: Hex; issuedAt: DecString; sig: Hex }
