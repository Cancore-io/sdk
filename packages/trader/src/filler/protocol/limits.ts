/**
 * filler-gateway's rate limits per fillerId (protocol §3.6, CAN-2232), as the
 * SDK honours them. The gateway keeps a token bucket per `(fillerId, class)`,
 * shared by REST and every WebSocket session of the filler; over the limit it
 * drops the message and answers `error RATE_LIMITED` with `retryAfterMs` (on
 * REST: 429 and `Retry-After`). The SDK then sends nothing of that class until
 * the time has passed: a call of a paused class is refused locally, without a
 * request, so a retry timer or a poll cannot turn one refusal into a storm.
 */
import { GatewayError } from '../errors';
import type { Clock } from '../runtime';

/** The rate classes of filler-gateway. */
export type RateClass = 'quote' | 'ticket' | 'service' | 'read' | 'login';

/** The classes a WebSocket frame can fall in; a refusal that names no frame of ours pauses them all. */
export const WS_RATE_CLASSES: readonly RateClass[] = ['quote', 'ticket', 'service'];

const FRAME_CLASSES: Readonly<Record<string, RateClass>> = {
  quote: 'quote',
  'quote.reconfirm.reply': 'quote',
  'ticket.intent': 'ticket',
  'ticket.decline': 'ticket',
  'ticket.receipt': 'ticket',
  'fill.reported': 'ticket',
};

/** The class a filler → filler-gateway frame counts in; `ping`, `pong`, `error` and unknown types are `service`. */
export const rateClassOfFrame = (type: string): RateClass => FRAME_CLASSES[type] ?? 'service';

/** The pause after a 429 that names no wait (no `retryAfterMs`, no `Retry-After`). */
export const DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * `Retry-After` in ms: delta-seconds, or an HTTP date (RFC 9110 §10.2.3).
 * Undefined when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (/^[0-9]+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
  }
  const at = Date.parse(text);
  return Number.isFinite(at) && at > nowMs ? Math.ceil(at - nowMs) : undefined;
}

/** Until when each rate class is held back. */
export class RateLimits {
  private readonly until = new Map<RateClass, number>();

  constructor(private readonly clock: Clock) {}

  /** Holds `classes` back for `ms` from now; an earlier, longer pause is kept. */
  pause(classes: RateClass | readonly RateClass[], ms: number): void {
    const at = this.clock.now() + Math.max(0, Math.ceil(ms));
    for (const rateClass of typeof classes === 'string' ? [classes] : classes) {
      this.until.set(rateClass, Math.max(this.until.get(rateClass) ?? 0, at));
    }
  }

  /** Ms left of the pause of `rateClass`; 0 when it may send. */
  remainingMs(rateClass: RateClass): number {
    return Math.max(0, (this.until.get(rateClass) ?? 0) - this.clock.now());
  }

  /** The end of the current pause of `rateClass` (unix ms), or 0. */
  pausedUntil(rateClass: RateClass): number {
    return this.remainingMs(rateClass) > 0 ? (this.until.get(rateClass) ?? 0) : 0;
  }

  /** Throws a local `RATE_LIMITED` (with the remaining `retryAfterMs`) while `rateClass` is paused. */
  check(rateClass: RateClass, what: string): void {
    const remaining = this.remainingMs(rateClass);
    if (remaining > 0) {
      throw new GatewayError('RATE_LIMITED', true, `${what}: held back, the ${rateClass} rate class is paused for ${remaining} ms more`, undefined, undefined, remaining);
    }
  }
}
