import type { Hex } from './keys';
const todo = (): never => { throw new Error('not implemented'); };
export interface FillTicket { orderHash: Hex; filler: Hex; attempt: number; validFrom: string; validUntil: string }
export function fillerAuthDigest(_m: { fillerId: string; nonce: Hex; expiresAt: string }): Hex { return todo(); }
export function fillerQuoteDigest(_m: { requestId: string; filler: string; amountOut: string; validUntil: string; nonce: string }): Hex { return todo(); }
export function ticketIntentDigest(_m: { orderHash: Hex; attempt: number; validFrom: string; validUntil: string }): Hex { return todo(); }
export function ticketReceiptDigest(_m: { ticketHash: Hex; ticketSigHash: Hex }): Hex { return todo(); }
export function fillTicketDigest(_t: FillTicket): Hex { return todo(); }
export function sigHash(_sig: Hex): Hex { return todo(); }
export function signGateway<T extends Record<string, unknown>>(_m: T, _k: Hex): T & { sig: Hex } { return todo(); }
export function gatewaySigner(_m: Record<string, unknown>): Hex { return todo(); }
export function drawOutcome(_rand: Hex, _orderHash: Hex, _attempt: number, _c: { fillerId: string; weight: string }[]): { r: string; winnerFillerId: string } { return todo(); }
