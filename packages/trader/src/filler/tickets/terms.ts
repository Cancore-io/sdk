/**
 * Ticket terms in one place: who the filler is in a ticket, how an issued
 * ticket is compared with the offer, and how the order and ticket of a frame
 * become the structs that are hashed. Everything that names the filler in a
 * ticket goes through here.
 *
 * Variant A (protocol §3.2, §3.15; CAN-2139): the ticket and the consent name
 * the filler by `fillerId` and carry the `deliveryKey` that sends `fill` and
 * the `repayTo` that `settle` pays. The SDK takes them from its own keys: the
 * delivery key is the fill key of the EVM destination (the zero address for a
 * Canton destination); `repayTo` on an EVM source is the address of the fill
 * key of that chain, padded — or, without one, of the destination's fill key
 * (one EVM address may serve every EVM network, §3.2) — and on a Canton
 * source the hash of the filler's party. The consent
 * and the receipt are signed by the message key (T-3). Choosing other
 * addresses per ticket from the node's configuration is CAN-2151.
 */
import {
  fillerIdHash,
  FILLER_PROTOCOL_DOMAIN,
  repayToFromEvm,
  repayToFromParty,
  TICKET_INTENT_TYPES,
  TICKET_RECEIPT_TYPES,
  type FillTicket,
  type Hex,
  type Order,
  type OrderJson,
  type TicketIntentMessage,
  type TicketJson,
  type TicketOffer,
  type TicketReceiptMessage,
  type TypedDataInput,
} from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { hashTicket } from '../chain/hashes';
import type { EvmChainId } from '../chains';
import type { Unsealed } from '../protocol/envelope';
import { signTypedDataChecked, type FillSigner, type QuoteSigner } from '../signer';

/** Canton origin ids are `2⁶³ + n` (protocol §3.8); every EVM chain id is below. */
export const CANTON_ORIGIN_FLOOR = 1n << 63n;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DEC = /^(0|[1-9][0-9]*)$/;

/** The chains of an order: its EVM source and EVM destination, when they are EVM. */
export interface OrderChains {
  source?: EvmChainId;
  destination?: EvmChainId;
  /** The raw origin id (`order.originChainId`). */
  origin: bigint;
}

/** Source and destination of an `Order` JSON; undefined when the fields do not parse. */
export function chainsOf(order: OrderJson): OrderChains | undefined {
  if (typeof order?.originChainId !== 'string' || !DEC.test(order.originChainId)) return undefined;
  if (typeof order.destination !== 'string' || !BYTES32.test(order.destination)) return undefined;
  const origin = BigInt(order.originChainId);
  const dst = BigInt(order.destination);
  return {
    origin,
    ...(origin > 0n && origin < CANTON_ORIGIN_FLOOR ? { source: `eip155:${origin}` as EvmChainId } : {}),
    ...(dst > 0n && dst < CANTON_ORIGIN_FLOOR ? { destination: `eip155:${dst}` as EvmChainId } : {}),
  };
}

/** `ICancoreRouter.Order` from its wire JSON (decimal strings stay strings: the hashing accepts them). */
export const orderOf = (order: OrderJson): Order => ({ ...order });

/** What the SDK derives a ticket identity from. */
export interface TicketKeys {
  fillerId: string;
  fillSigners: { readonly [chain: EvmChainId]: FillSigner };
  /** The filler's Canton party (`CantonLedger.party`): the payee on a Canton source. */
  cantonParty?: string;
}

/** Who the filler is in a ticket for one order: the values its consent names and the issued ticket must repeat. */
export interface TicketIdentity {
  /** The chain whose policy (`sendGuard`) the attempt runs on: the EVM destination, else the EVM source. */
  chain: EvmChainId;
  /** The fill key of that chain. */
  signer: FillSigner;
  fillerId: string;
  /** Sends `fill`: the destination's fill key; the zero address for a Canton destination. */
  deliveryKey: Hex;
  /** Where `settle` pays, encoded for the source chain (protocol §3.15). */
  repayTo: Hex;
}

const ZERO_ADDRESS: Hex = `0x${'00'.repeat(20)}`;

/**
 * The filler's identity for `order`, from its own keys; undefined when it
 * holds no fill key for the destination (or, for a Canton destination, the
 * source), or, on a Canton source, no party to be paid.
 */
export function identityFor(order: OrderJson, keys: TicketKeys): TicketIdentity | undefined {
  const chains = chainsOf(order);
  if (!chains) return undefined;
  const chain = chains.destination ?? chains.source;
  const signer = chain ? keys.fillSigners[chain] : undefined;
  if (!chain || !signer) return undefined;
  const deliveryKey = chains.destination ? (keys.fillSigners[chains.destination]!.address.toLowerCase() as Hex) : ZERO_ADDRESS;
  let repayTo: Hex | undefined;
  if (chains.source) {
    repayTo = repayToFromEvm((keys.fillSigners[chains.source] ?? signer).address);
  } else if (chains.origin >= CANTON_ORIGIN_FLOOR && keys.cantonParty) {
    repayTo = repayToFromParty(keys.cantonParty);
  }
  return repayTo ? { chain, signer, fillerId: keys.fillerId, deliveryKey, repayTo } : undefined;
}

/** The terms of the offer the ticket must repeat (protocol S-5, fillers.md V-T2). */
export interface OfferTerms {
  orderHash: Hex;
  attempt: number;
  validFrom: string;
  validUntil: string;
}

/**
 * The first field in which an issued ticket differs from what the filler
 * agreed to — the offer's terms and its own identity — or undefined when it
 * repeats them exactly. A mismatch is `TICKET_MISMATCH` (V-T2, T-48).
 */
export function ticketMismatch(ticket: TicketJson, terms: OfferTerms, identity: TicketIdentity): string | undefined {
  if (typeof ticket !== 'object' || ticket === null) return 'ticket';
  if (typeof ticket.orderHash !== 'string' || ticket.orderHash.toLowerCase() !== terms.orderHash.toLowerCase()) return 'orderHash';
  if (ticket.attempt !== terms.attempt) return 'attempt';
  if (ticket.validFrom !== terms.validFrom) return 'validFrom';
  if (ticket.validUntil !== terms.validUntil) return 'validUntil';
  const same = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
  if (!same(ticket.fillerId, fillerIdHash(identity.fillerId))) return 'fillerId';
  if (!same(ticket.deliveryKey, identity.deliveryKey)) return 'deliveryKey';
  if (!same(ticket.repayTo, identity.repayTo)) return 'repayTo';
  return undefined;
}

/** The `FillTicket` struct of an issued ticket, as the router hashes it. */
export const fillTicketOf = (ticket: TicketJson): FillTicket => ({
  orderHash: ticket.orderHash,
  fillerId: ticket.fillerId,
  deliveryKey: ticket.deliveryKey,
  repayTo: ticket.repayTo,
  attempt: ticket.attempt,
  validFrom: ticket.validFrom,
  validUntil: ticket.validUntil,
});

// ---------------------------------------------------------------------------
// The consent and the receipt
// ---------------------------------------------------------------------------

/**
 * The filler's consent to an offered ticket: `TicketIntent` with the offer's
 * values (protocol §3.5 — `orderHash`, `attempt`, `validFrom`, `validUntil`
 * MUST equal the offer) and the filler's `fillerId`, `deliveryKey`, `repayTo`.
 */
export const ticketIntentInput = (offer: TicketOffer, identity: TicketIdentity): TypedDataInput => ({
  domain: FILLER_PROTOCOL_DOMAIN,
  types: TICKET_INTENT_TYPES,
  primaryType: 'TicketIntent',
  message: {
    orderHash: offer.orderHash, attempt: offer.attempt, validFrom: offer.validFrom, validUntil: offer.validUntil,
    fillerId: identity.fillerId, deliveryKey: identity.deliveryKey, repayTo: identity.repayTo,
  },
});

/** Signs the consent with the message key and builds `ticket.intent`, still to be sealed. */
export async function signTicketIntent(offer: TicketOffer, identity: TicketIdentity, messageSigner: QuoteSigner, id: string): Promise<Unsealed<TicketIntentMessage>> {
  const sig = await signTypedDataChecked(messageSigner, ticketIntentInput(offer, identity));
  return {
    type: 'ticket.intent', id, orderHash: offer.orderHash.toLowerCase() as Hex, attempt: offer.attempt, validFrom: offer.validFrom, validUntil: offer.validUntil,
    deliveryKey: identity.deliveryKey, repayTo: identity.repayTo, sig,
  };
}

/** `TicketReceipt{hashTicket(ticket), keccak256(ticketSig)}` — what binds the filler to deliver (T-22). */
export function ticketReceiptInput(ticket: TicketJson, ticketSig: Hex): TypedDataInput {
  const ticketSigHash = `0x${bytesToHex(keccak_256(hexToBytes(ticketSig.slice(2))))}` as Hex;
  return { domain: FILLER_PROTOCOL_DOMAIN, types: TICKET_RECEIPT_TYPES, primaryType: 'TicketReceipt', message: { ticketHash: hashTicket(fillTicketOf(ticket)), ticketSigHash } };
}

/** Signs the receipt with the message key and builds `ticket.receipt` (EVM form), still to be sealed. */
export async function signTicketReceipt(ticket: TicketJson, ticketSig: Hex, messageSigner: QuoteSigner, id: string): Promise<Unsealed<TicketReceiptMessage>> {
  const input = ticketReceiptInput(ticket, ticketSig);
  const sig = await signTypedDataChecked(messageSigner, input);
  const { ticketHash, ticketSigHash } = input.message as { ticketHash: Hex; ticketSigHash: Hex };
  return { type: 'ticket.receipt', id, orderHash: ticket.orderHash.toLowerCase() as Hex, attempt: ticket.attempt, ticketHash, ticketSigHash, sig };
}
