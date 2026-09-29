import type { Result } from './quotes';
export interface OfferTerms { orderHash: string; attempt: number; order: Record<string, string | number>; amountOut: string; validFrom: string; validUntil: string; acceptBy: number }
export interface IntentAck { orderHash: string; attempt: number; intentHash: string; receivedAt: number }
export interface TicketRecord { fillerId: string; offer: OfferTerms; state: string; ack?: IntentAck; closedBy?: string; decline?: { reason: string; stage: string } }
export interface TicketRef { orderHash: string; attempt: number }
export type ExpiredResult = { result: 'FILLED' | 'NO_SHOW' | 'NO_SHOW_UNCONFIRMED' } | { result: 'EXEMPT'; exemptReason: string };
const todo = (): never => { throw new Error('not implemented'); };
export class TicketBook {
  offer(_f: string, _o: OfferTerms): TicketRecord { return todo(); }
  nextAttempt(_h: string): number { return todo(); }
  intent(_f: string, _i: TicketRef & { validFrom: string; validUntil: string }, _at: number, _h: string): Result<IntentAck> { return todo(); }
  issue(_t: TicketRecord, _msg: Record<string, unknown>, _h?: { ticketHash: string; ticketSigHash: string }): void { todo(); }
  receipt(_f: string, _r: TicketRef & { ticketHash: string; ticketSigHash: string }, _at: number): Result<void> { return todo(); }
  decline(_f: string, _d: TicketRef & { reason: string; detail?: string }): Result<void> { return todo(); }
  fillReported(_f: string, _r: TicketRef & { txRef: string }, _at: number): Result<void> { return todo(); }
  expire(_t: TicketRecord): ExpiredResult { return todo(); }
  close(_t: TicketRecord, _by: string): void { todo(); }
  list(_f: string, _s: 'OFFERED' | 'ISSUED'): TicketRecord[] { return todo(); }
}
export function payout(_t: string, _bps: number): { payout: string; fee: string } { return todo(); }
