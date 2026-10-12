/**
 * One digest helper per signed type of the intent rail's settlement design:
 * what a signer hands its secp256k1 key and what a verifier recovers from.
 * Each is `hashTypedData` over the type and domain of this package, so no
 * consumer re-types a struct (SDK S1). `FillProof` is `hashFillProof` in
 * `../eip712`, next to its domain.
 */
import { utf8ToBytes } from '@noble/hashes/utils';
import { hexBytes, keccak, toHex, uint } from './bytes';
import { hashTypedData, fillerMessageBodyHash } from './hash';
import type { TicketIssuedCanton } from './messages';
import {
  CANTON_TICKET_RECEIPT_TYPES, FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, FILLER_KEY_REGISTRATION_TYPES, FILLER_MESSAGE_TYPES, FILLER_PROTOCOL_DOMAIN,
  FILLER_QUOTE_TYPES, TICKET_INTENT_TYPES,
  type CantonTicketReceipt, type FillerKeyRegistration, type FillerQuote, type FillTicket, type Hex, type TicketIntent,
} from './typedData';

/** `hashTicket` of the router: the `FillTicket` digest in the ticket domain, the same on every chain. */
export const hashFillTicket = (ticket: FillTicket): Hex =>
  hashTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: { ...ticket } });

/** The `FillerQuote` digest; `quote.requestId` is already `requestIdHash(requestId)`. */
export const hashFillerQuote = (quote: FillerQuote): Hex =>
  hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: FILLER_QUOTE_TYPES, primaryType: 'FillerQuote', message: { ...quote } });

/** The `TicketIntent` digest — the inner `sig` of `ticket.intent`. */
export const hashTicketIntent = (intent: TicketIntent): Hex =>
  hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: TICKET_INTENT_TYPES, primaryType: 'TicketIntent', message: { ...intent } });

/** What `msgSig` of a filler → filler-gateway message is over: `FillerMessage{bodyHash}` of the message without `msgSig`. */
export const hashFillerMessage = (message: object): Hex =>
  hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: FILLER_MESSAGE_TYPES, primaryType: 'FillerMessage', message: { bodyHash: fillerMessageBodyHash(message) } });

/** The `FillerKeyRegistration` digest; the registered key signs it, and it must recover to `messageKey`. */
export const hashFillerKeyRegistration = (registration: FillerKeyRegistration): Hex =>
  hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: FILLER_KEY_REGISTRATION_TYPES, primaryType: 'FillerKeyRegistration', message: { ...registration } });

/** `keccak256(utf8(deliveryOrderCid))` over the contract id exactly as `ticket.issued` sent it: no trimming, no case change. */
export function deliveryOrderCidHash(deliveryOrderCid: string): Hex {
  if (typeof deliveryOrderCid !== 'string' || deliveryOrderCid.length === 0) throw new TypeError('deliveryOrderCid: a Canton contract id is a non-empty string');
  return toHex(keccak(utf8ToBytes(deliveryOrderCid)));
}

/**
 * The `CantonTicketReceipt` of a Canton-form ticket, from the fields that name it — the filler reads them from
 * `ticket.issued`, filler-gateway from the `ticket.receipt` it verifies; both get the same struct. Any other field of
 * the frame (`fillerId`, `repayTo`) is not part of the receipt and is ignored.
 */
export function cantonTicketReceipt(ticket: Pick<TicketIssuedCanton, 'orderHash' | 'attempt' | 'deliveryOrderCid' | 'validUntil'>): CantonTicketReceipt {
  hexBytes(ticket.orderHash, 'orderHash', 32);
  return {
    orderHash: ticket.orderHash.toLowerCase() as Hex,
    attempt: Number(uint(ticket.attempt, 32, 'attempt')),
    deliveryOrderCidHash: deliveryOrderCidHash(ticket.deliveryOrderCid),
    validUntil: uint(ticket.validUntil, 64, 'validUntil').toString(),
  };
}

/** The `CantonTicketReceipt` digest — the inner `sig` of a Canton-form `ticket.receipt`. */
export const hashCantonTicketReceipt = (receipt: CantonTicketReceipt): Hex =>
  hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: CANTON_TICKET_RECEIPT_TYPES, primaryType: 'CantonTicketReceipt', message: { ...receipt } });
