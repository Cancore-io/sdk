/**
 * Ticket terms in one place: who the filler is in a ticket, how an issued
 * ticket is compared with the offer, and how the order and ticket of a frame
 * become the structs that are hashed. Everything that names the filler in a
 * ticket goes through here, so the switch to the variant A identity — the
 * ticket and the consent carrying `fillerId`, `deliveryKey` and `repayTo`,
 * every message signed by one message key (fillers.md T-48, V-T2;
 * CAN-2139 types, CAN-2151) — changes this file and its tests only.
 *
 * Today (pinned `@cancore/contracts` types) a ticket names the filler by one
 * address, `FillTicket.filler`: the fill key of the chain the filler delivers
 * on (protocol §3.2).
 */
import type { FillTicket, Hex, Order, OrderJson, TicketJson } from '@cancore/contracts';
import type { EvmChainId } from '../chains';
import type { FillSigner } from '../signer';

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

/**
 * Who the filler is in a ticket for one order. Pinned types: the fill address
 * that signs the consent and the receipt and sends `fill`.
 */
export interface TicketIdentity {
  /** The chain whose fill key names the filler: the EVM destination, else the EVM source. */
  chain: EvmChainId;
  /** That fill key; `FillTicket.filler` must equal its address. */
  signer: FillSigner;
}

/** The filler's identity for `order`, from its own fill keys; undefined when it holds none for the order's chains. */
export function identityFor(order: OrderJson, fillSigners: { readonly [chain: EvmChainId]: FillSigner }): TicketIdentity | undefined {
  const chains = chainsOf(order);
  const chain = chains?.destination ?? chains?.source;
  const signer = chain ? fillSigners[chain] : undefined;
  return chain && signer ? { chain, signer } : undefined;
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
  if (typeof ticket.filler !== 'string' || ticket.filler.toLowerCase() !== identity.signer.address.toLowerCase()) return 'filler';
  return undefined;
}

/** The `FillTicket` struct of an issued ticket, as the router hashes it. */
export const fillTicketOf = (ticket: TicketJson): FillTicket => ({
  orderHash: ticket.orderHash,
  filler: ticket.filler,
  attempt: ticket.attempt,
  validFrom: ticket.validFrom,
  validUntil: ticket.validUntil,
});
