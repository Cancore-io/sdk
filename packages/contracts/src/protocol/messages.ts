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
  'ATTESTATIONS_NOT_READY',
] as const;
/** HTTP status of each error code on the REST fallback. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400, UNAUTHENTICATED: 401, UNSUPPORTED_VERSION: 400, UNSUPPORTED_TYPE: 400, BAD_SIGNATURE: 422,
  STALE_MESSAGE: 400, REPLAYED_MESSAGE: 409, TICKET_REFUSED: 409,
  UNKNOWN_REQUEST: 404, UNKNOWN_TICKET: 404, TICKET_CLOSED: 409, NOT_ELIGIBLE: 403, RATE_LIMITED: 429, INTERNAL: 500,
  ATTESTATIONS_NOT_READY: 404,
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
export const PENALTY_STEPS = ['L1', 'L2', 'L3', 'L4'] as const;
export const DRAW_CLOSED_BY = ['OFFER_TIMEOUT', 'OFFER_DECLINE', 'TICKET_DECLINE', 'TICKET_EXPIRED', 'FILLED'] as const;
export const TICKET_LIST_STATUSES = ['OFFERED', 'ISSUED'] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type TicketRefusedReason = (typeof TICKET_REFUSED_REASONS)[number];
export type ExpiredResult = (typeof EXPIRED_RESULTS)[number];
export type ExemptReason = (typeof EXEMPT_REASONS)[number];
export type QuoteAckStatus = (typeof QUOTE_ACK_STATUSES)[number];
export type QuoteFinalStatus = (typeof QUOTE_FINAL_STATUSES)[number];
export type PenaltyStep = (typeof PENALTY_STEPS)[number];
export type DrawClosedBy = (typeof DRAW_CLOSED_BY)[number];

/** `ICancoreRouter.Order` on the wire: every numeric field a decimal string, as `canton-order.json`. */
export interface OrderJson {
  user: Hex; originChainId: DecString; inputToken: Hex; inputAmount: DecString; destination: Hex; outputAsset: Hex;
  minReceived: DecString; recipient: Hex; createdAt: DecString; fillDeadline: DecString; feeBps: DecString;
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
export interface TicketReceiptMessage extends F2SBase {
  type: 'ticket.receipt'; orderHash: Hex; attempt: number; ticketHash: Hex; ticketSigHash: Hex; sig: Hex;
}
export interface FillReported extends F2SBase { type: 'fill.reported'; orderHash: Hex; attempt: number; txRef: string }
export interface TicketExpired extends S2FBase { type: 'ticket.expired'; orderHash: Hex; attempt: number; result: ExpiredResult; exemptReason?: ExemptReason }
export interface OrderSettled extends S2FBase {
  type: 'order.settled'; orderHash: Hex; payout: DecString; fee: DecString; penaltyWithheld: DecString; txRef: string;
}
export interface PenaltyApplied extends S2FBase { type: 'penalty.applied'; violationId: string; code: string; step: PenaltyStep; details: Record<string, unknown> }

export type S2FMessage =
  | AuthChallenge | AuthOk | PingS2F | PongS2F | ErrorMessage | EpochWeights | QuoteRequest | QuoteAck | QuoteReconfirm
  | TicketOffer | TicketIntentAck | TicketIssued | TicketExpired | OrderSettled | PenaltyApplied | SettleAttestations;
export type F2SMessage =
  | AuthResponse | PingF2S | PongF2S | ErrorF2S | QuoteMessage | QuoteReconfirmReply | TicketIntentMessage | TicketDecline | TicketReceiptMessage | FillReported;

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
