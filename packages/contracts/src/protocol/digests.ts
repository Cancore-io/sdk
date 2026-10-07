/**
 * One digest helper per signed type of the intent rail's settlement design:
 * what a signer hands its secp256k1 key and what a verifier recovers from.
 * Each is `hashTypedData` over the type and domain of this package, so no
 * consumer re-types a struct (SDK S1). `FillProof` is `hashFillProof` in
 * `../eip712`, next to its domain.
 */
import { hashTypedData, fillerMessageBodyHash } from './hash';
import {
  FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, FILLER_KEY_REGISTRATION_TYPES, FILLER_MESSAGE_TYPES, FILLER_PROTOCOL_DOMAIN, FILLER_QUOTE_TYPES,
  TICKET_INTENT_TYPES,
  type FillerKeyRegistration, type FillerQuote, type FillTicket, type Hex, type TicketIntent,
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
