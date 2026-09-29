/**
 * Tickets per `(orderHash, attempt)` (protocol §3.5 Tickets): offer →
 * intent/ack (idempotent, `receivedAt ≤ acceptBy`) → issued → receipt
 * (until `validUntil`) → expired. Pure state; signatures and timing of the
 * server's own sends live in the gateway.
 */
import { fail } from './quotes';
import type { Result } from './quotes';

export interface OfferTerms {
  orderHash: string;
  attempt: number;
  order: Record<string, string | number>;
  amountOut: string;
  validFrom: string;
  validUntil: string;
  acceptBy: number;
}

export interface IntentAck {
  orderHash: string;
  attempt: number;
  intentHash: string;
  receivedAt: number;
}

export type TicketState = 'OFFERED' | 'ACKED' | 'ISSUED' | 'RECEIPTED' | 'DECLINED' | 'CLOSED' | 'EXPIRED';

export interface ReceiptHashes {
  ticketHash: string;
  ticketSigHash: string;
}

export interface TicketRecord {
  fillerId: string;
  offer: OfferTerms;
  state: TicketState;
  ack?: IntentAck;
  issued?: Record<string, unknown>;
  expected?: ReceiptHashes;
  fill?: { txRef: string; at: number };
  decline?: { reason: string; stage: 'offer' | 'issued'; detail?: string };
  closedBy?: string;
}

export interface TicketRef {
  orderHash: string;
  attempt: number;
}

export type ExpiredResult = { result: 'FILLED' | 'NO_SHOW' | 'NO_SHOW_UNCONFIRMED' } | { result: 'EXEMPT'; exemptReason: 'GATEWAY_FAULT' };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const done: Result<void> = ok(undefined);
const key = (orderHash: string, attempt: number) => `${orderHash}/${attempt}`;
const second = (ms: number) => BigInt(Math.floor(ms / 1000));

export class TicketBook {
  private tickets = new Map<string, TicketRecord>();

  offer(fillerId: string, offer: OfferTerms): TicketRecord {
    const k = key(offer.orderHash, offer.attempt);
    if (this.tickets.has(k)) throw new Error(`ticket ${k} already offered`);
    const t: TicketRecord = { fillerId, offer, state: 'OFFERED' };
    this.tickets.set(k, t);
    return t;
  }

  /** The ticket, only if it is this taker's. */
  find(fillerId: string, orderHash: string, attempt: number): TicketRecord | undefined {
    const t = this.tickets.get(key(orderHash, attempt));
    return t?.fillerId === fillerId ? t : undefined;
  }

  nextAttempt(orderHash: string): number {
    let n = 0;
    while (this.tickets.has(key(orderHash, n))) n++;
    return n;
  }

  intent(fillerId: string, i: TicketRef & { validFrom: string; validUntil: string }, receivedAt: number, intentHash: string): Result<IntentAck> {
    const t = this.find(fillerId, i.orderHash, i.attempt);
    if (!t) return fail('UNKNOWN_TICKET', `no ticket ${key(i.orderHash, i.attempt)} for ${fillerId}`);
    if (t.ack?.intentHash === intentHash) return ok(t.ack);
    if (t.state !== 'OFFERED' || receivedAt > t.offer.acceptBy) return fail('TICKET_CLOSED', `intent after acceptBy ${t.offer.acceptBy}, or the ticket is ${t.state}`);
    if (i.validFrom !== t.offer.validFrom || i.validUntil !== t.offer.validUntil) return fail('BAD_REQUEST', 'validFrom/validUntil: must equal the offer');
    t.ack = { orderHash: t.offer.orderHash, attempt: t.offer.attempt, intentHash, receivedAt };
    t.state = 'ACKED';
    return ok(t.ack);
  }

  /** `expected` is absent for a Canton-form ticket: its receipt is undefined (O-5). */
  issue(t: TicketRecord, issued: Record<string, unknown>, expected?: ReceiptHashes): void {
    t.state = 'ISSUED';
    t.issued = issued;
    if (expected) t.expected = expected;
  }

  receipt(fillerId: string, r: TicketRef & ReceiptHashes, receivedAt: number): Result<void> {
    const t = this.find(fillerId, r.orderHash, r.attempt);
    if (!t) return fail('UNKNOWN_TICKET', `no ticket ${key(r.orderHash, r.attempt)} for ${fillerId}`);
    const same = t.expected?.ticketHash === r.ticketHash && t.expected?.ticketSigHash === r.ticketSigHash;
    if (t.state === 'RECEIPTED' && same) return done;
    if (t.state !== 'ISSUED' || second(receivedAt) > BigInt(t.offer.validUntil)) return fail('TICKET_CLOSED', `receipt after validUntil, or the ticket is ${t.state}`);
    if (!t.expected) return fail('BAD_REQUEST', 'a Canton-destination ticket has no EVM receipt (protocol O-5)');
    if (!same) return fail('BAD_REQUEST', 'ticketHash/ticketSigHash: not the issued ticket');
    t.state = 'RECEIPTED';
    return done;
  }

  decline(fillerId: string, d: TicketRef & { reason: string; detail?: string }): Result<void> {
    const t = this.find(fillerId, d.orderHash, d.attempt);
    if (!t) return fail('UNKNOWN_TICKET', `no ticket ${key(d.orderHash, d.attempt)} for ${fillerId}`);
    if (!['OFFERED', 'ACKED', 'ISSUED'].includes(t.state)) return fail('TICKET_CLOSED', `the ticket is ${t.state}`);
    t.decline = { reason: d.reason, stage: t.state === 'ISSUED' ? 'issued' : 'offer', ...(d.detail ? { detail: d.detail } : {}) };
    t.state = 'DECLINED';
    return done;
  }

  fillReported(fillerId: string, f: TicketRef & { txRef: string }, receivedAt: number): Result<void> {
    const t = this.find(fillerId, f.orderHash, f.attempt);
    if (!t) return fail('UNKNOWN_TICKET', `no ticket ${key(f.orderHash, f.attempt)} for ${fillerId}`);
    if (t.state !== 'ISSUED' && t.state !== 'RECEIPTED') return fail('TICKET_CLOSED', `the ticket is ${t.state}`);
    t.fill = { txRef: f.txRef, at: receivedAt };
    return done;
  }

  /**
   * The result of an issued ticket after `validUntil` + finality. The mock's
   * stand-in for the chain is `fill.reported`: a fill in a second ≤ validUntil
   * counts (the router's check is inclusive).
   */
  expire(t: TicketRecord): ExpiredResult {
    const declined = t.state === 'DECLINED';
    const receipted = t.state === 'RECEIPTED';
    t.state = 'EXPIRED';
    if (declined) return { result: 'EXEMPT', exemptReason: 'GATEWAY_FAULT' };
    if (t.fill && second(t.fill.at) <= BigInt(t.offer.validUntil)) return { result: 'FILLED' };
    return { result: receipted ? 'NO_SHOW' : 'NO_SHOW_UNCONFIRMED' };
  }

  close(t: TicketRecord, closedBy: string): void {
    t.state = 'CLOSED';
    t.closedBy = closedBy;
  }

  /** `GET /v1/filler/tickets?status=`: OFFERED = offered or acked, not yet issued. */
  list(fillerId: string, status: 'OFFERED' | 'ISSUED'): TicketRecord[] {
    const states: TicketState[] = status === 'OFFERED' ? ['OFFERED', 'ACKED'] : ['ISSUED', 'RECEIPTED'];
    return [...this.tickets.values()].filter((t) => t.fillerId === fillerId && states.includes(t.state));
  }
}

/** Inclusive fee, EVM source (protocol §3.11): `payout = ⌊T × 10000 / (10000 + feeBps)⌋`. */
export function payout(inputAmount: string, feeBps: number): { payout: string; fee: string } {
  const t = BigInt(inputAmount);
  const p = (t * 10_000n) / (10_000n + BigInt(feeBps));
  return { payout: p.toString(), fee: (t - p).toString() };
}
