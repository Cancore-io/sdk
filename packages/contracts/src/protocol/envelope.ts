/**
 * The checks of protocol §3.4 a filler → filler-gateway message must pass
 * before it is processed, as far as they need no key and no state. What stays
 * with the receiver: recovering `msgSig` and comparing it with the message key
 * registered for `fillerId` (check 1 proper, S-24), and refusing an `id`
 * already accepted from that `fillerId` (check 4, `REPLAYED_MESSAGE`) — kept
 * until `messageIdRetainUntil`, so no replay outlives the record of its id.
 */
import { isEoaSignature } from './identity';
import type { ErrorCode } from './messages';

export interface FillerEnvelopeContext {
  /** The `fillerId` the session (or bearer token) is authenticated for. */
  fillerId: string;
  /** Arrival time, unix ms, the receiver's clock. */
  receivedAt: number;
  /** `GET /v1/gateway` `maxMessageAgeMs`. */
  maxMessageAgeMs: number;
}

/**
 * The error code the gateway answers for the first envelope check `message`
 * fails, in the order of §3.4, or `null` when every key-free check passes:
 * `BAD_SIGNATURE` — `msgSig` missing or not a 65-byte low-s EOA signature;
 * `UNAUTHENTICATED` — `fillerId` is not the session's; `BAD_REQUEST` — `sentAt`
 * not unix milliseconds, or no valid `id`; `STALE_MESSAGE` — `sentAt` further
 * than `maxMessageAgeMs` from `receivedAt`.
 */
export function fillerEnvelopeError(message: object, ctx: FillerEnvelopeContext): ErrorCode | null {
  const { msgSig, fillerId, sentAt, id } = message as Readonly<Record<string, unknown>>;
  if (!isEoaSignature(msgSig)) return 'BAD_SIGNATURE';
  if (fillerId !== ctx.fillerId) return 'UNAUTHENTICATED';
  if (typeof sentAt !== 'number' || !Number.isSafeInteger(sentAt) || sentAt < 1e12) return 'BAD_REQUEST';
  if (Math.abs(ctx.receivedAt - sentAt) > ctx.maxMessageAgeMs) return 'STALE_MESSAGE';
  if (typeof id !== 'string' || id.length < 1 || id.length > 64) return 'BAD_REQUEST';
  return null;
}

/**
 * Until when (unix ms, receiver clock) the receiver must remember an accepted
 * message `id` to refuse its replay: `max(receivedAt, sentAt) + maxMessageAgeMs`.
 * Freshness is symmetric (`|receivedAt − sentAt| ≤ maxMessageAgeMs`), so a
 * message whose `sentAt` runs ahead of the receiver's clock stays fresh until
 * `sentAt + maxMessageAgeMs` — later than `receivedAt + maxMessageAgeMs`.
 * Forgetting the id earlier would let the byte-identical message in again;
 * after this time a replay fails the freshness check by itself.
 */
export function messageIdRetainUntil(sentAt: number, receivedAt: number, maxMessageAgeMs: number): number {
  return Math.max(receivedAt, sentAt) + maxMessageAgeMs;
}
