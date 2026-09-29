/**
 * The digests of filler protocol v1, computed with `@cancore/contracts` — the
 * same encoder, JCS and draw a taker gets — so the mock never carries a second
 * copy of the protocol. Signing lives in keys.ts (test keys only).
 */
import {
  drawValue,
  drawWinner,
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  FILLER_AUTH_TYPES,
  FILLER_PROTOCOL_DOMAIN,
  FILLER_QUOTE_TYPES,
  GATEWAY_MESSAGE_TYPES,
  gatewayBodyHash,
  hashTypedData,
  ORDER_TYPES,
  requestIdHash,
  routerDomain,
  TICKET_INTENT_TYPES,
  TICKET_RECEIPT_TYPES,
} from '@cancore/contracts';
import type { Order } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { BadSignatureError, recover, sign } from './keys';
import type { Hex } from './keys';

export interface FillTicket {
  orderHash: Hex;
  filler: Hex;
  attempt: number;
  validFrom: string;
  validUntil: string;
}

const protocol = (types: Parameters<typeof hashTypedData>[0]['types'], primaryType: string, message: Record<string, unknown>) =>
  hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types, primaryType, message });

export const fillerAuthDigest = (m: { fillerId: string; nonce: Hex; expiresAt: string }) =>
  protocol(FILLER_AUTH_TYPES, 'FillerAuth', { fillerId: m.fillerId, nonce: m.nonce, expiresAt: m.expiresAt });

/** `requestId` is the wire string; the struct takes its keccak256. */
export const fillerQuoteDigest = (m: { requestId: string; filler: string; amountOut: string; validUntil: string; nonce: string }) =>
  protocol(FILLER_QUOTE_TYPES, 'FillerQuote', { requestId: requestIdHash(m.requestId), filler: m.filler, amountOut: m.amountOut, validUntil: m.validUntil, nonce: m.nonce });

export const ticketIntentDigest = (m: { orderHash: Hex; attempt: number; validFrom: string; validUntil: string }) =>
  protocol(TICKET_INTENT_TYPES, 'TicketIntent', { orderHash: m.orderHash, attempt: m.attempt, validFrom: m.validFrom, validUntil: m.validUntil });

export const ticketReceiptDigest = (m: { ticketHash: Hex; ticketSigHash: Hex }) =>
  protocol(TICKET_RECEIPT_TYPES, 'TicketReceipt', { ticketHash: m.ticketHash, ticketSigHash: m.ticketSigHash });

/** `hashTicket` of the router: the FillTicket digest in the Ticket domain (no chainId, no verifyingContract). */
export const fillTicketDigest = (t: FillTicket) =>
  hashTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: { ...t } });

export const orderHash = (order: Order, chainId: string, router: Hex) =>
  hashTypedData({ domain: routerDomain(chainId, router), types: ORDER_TYPES, primaryType: 'Order', message: { ...order } });

/** `TicketReceipt.ticketSigHash`: keccak256 of the 65 raw signature bytes. */
export const sigHash = (sig: Hex): Hex => `0x${bytesToHex(keccak_256(hexToBytes(sig.slice(2))))}`;

const gatewayDigest = (m: Record<string, unknown>) => protocol(GATEWAY_MESSAGE_TYPES, 'GatewayMessage', { bodyHash: gatewayBodyHash(m) });

/** `m` plus `sig` = the key's signature over `GatewayMessage{keccak256(JCS(m without sig))}` (§3.4). */
export function signGateway<T extends Record<string, unknown>>(m: T, privateKey: Hex): T & { sig: Hex } {
  return { ...m, sig: sign(gatewayDigest(m), privateKey) };
}

/** Who signed an S→F message or a public record. */
export function gatewaySigner(m: Record<string, unknown>): Hex {
  if (typeof m.sig !== 'string') throw new BadSignatureError('no sig');
  return recover(gatewayDigest(m), m.sig as Hex);
}

/** r and winner of one attempt (auction-and-draw A-21, A-22), as the draw record writes them. */
export function drawOutcome(randomness: Hex, orderHash: Hex, attempt: number, candidates: readonly { fillerId: string; weight: string }[]) {
  const { r, winnerFillerId } = drawWinner(drawValue(randomness, orderHash, attempt), candidates);
  return { r: r.toString(), winnerFillerId };
}
