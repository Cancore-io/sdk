/**
 * The EIP-712 types and domains of the Cancore intent rail, filler protocol v1.
 *
 * The CODE types (`Order`, `Quote`, `FillTicket`; `FillProof` lives in
 * `../eip712`) come from evm-contracts/abi/typed-data through npm run sync.
 * Their public names stay here so callers use the same synchronized schemas.
 * The PROTOCOL types are off-chain,
 * signed in the `CancoreFillerProtocol` domain by the filler's one message key
 * (or the gateway key), and fixed by this package: a field reordered here
 * changes every digest, and the golden vectors under `spec/protocol/typed-data`
 * fail the moment it happens.
 */

import { ORDER_DOMAIN } from '../generated/typedData';
export { ORDER_TYPES, QUOTE_TYPES, FILL_TICKET_TYPES, FILL_TICKET_DOMAIN } from '../generated/typedData';

export type Hex = `0x${string}`;

/** A wide unsigned integer as the wire carries it (decimal string) or as code holds it. */
export type UintLike = bigint | number | string;

/** Name and version of the domain every off-chain protocol struct is signed in — no chain id, no verifying contract. */
export const FILLER_PROTOCOL_DOMAIN = { name: 'CancoreFillerProtocol', version: '1' } as const;

/** The source-router domain `Order` and `Quote` are hashed in. Canton source: `CANTON_ORIGIN_ID` and the anchor. */
export function routerDomain(chainId: UintLike, verifyingContract: Hex) {
  return { ...ORDER_DOMAIN, chainId, verifyingContract } as const;
}

/** `FillerQuote(bytes32 requestId,string fillerId,uint256 amountOut,uint64 validUntil,uint64 nonce)` — signed by the message key. */
export const FILLER_QUOTE_TYPES = {
  FillerQuote: [
    { name: 'requestId', type: 'bytes32' },
    { name: 'fillerId', type: 'string' },
    { name: 'amountOut', type: 'uint256' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

/**
 * `TicketIntent(bytes32 orderHash,uint32 attempt,uint64 validFrom,uint64 validUntil,string fillerId,address deliveryKey,bytes32 repayTo)`
 * — the filler's consent to an offered ticket, signed by its message key; `deliveryKey` and `repayTo` go into the `FillTicket` as they are.
 */
export const TICKET_INTENT_TYPES = {
  TicketIntent: [
    { name: 'orderHash', type: 'bytes32' },
    { name: 'attempt', type: 'uint32' },
    { name: 'validFrom', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'fillerId', type: 'string' },
    { name: 'deliveryKey', type: 'address' },
    { name: 'repayTo', type: 'bytes32' },
  ],
} as const;

/** `TicketReceipt(bytes32 ticketHash,bytes32 ticketSigHash)` — signed by the message key. */
export const TICKET_RECEIPT_TYPES = {
  TicketReceipt: [
    { name: 'ticketHash', type: 'bytes32' },
    { name: 'ticketSigHash', type: 'bytes32' },
  ],
} as const;

/**
 * `CantonTicketReceipt(bytes32 orderHash,uint32 attempt,bytes32 deliveryOrderCidHash,uint64 validUntil)` — the receipt of a
 * Canton-form ticket, which has no `FillTicket` and no `ticketSig`; signed by the message key. `fillerId` and `repayTo`
 * are not in it: they travel in `ticket.issued` (protocol.md §3.3, §10 D-O).
 */
export const CANTON_TICKET_RECEIPT_TYPES = {
  CantonTicketReceipt: [
    { name: 'orderHash', type: 'bytes32' },
    { name: 'attempt', type: 'uint32' },
    { name: 'deliveryOrderCidHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

/** `StakeBinding(string partnerId,address stakingAddress,uint256 chainId,uint64 nonce)` — signed by the staking address. */
export const STAKE_BINDING_TYPES = {
  StakeBinding: [
    { name: 'partnerId', type: 'string' },
    { name: 'stakingAddress', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

/** `FillerAuth(string fillerId,bytes32 nonce,uint64 expiresAt)` — signed by the message key. */
export const FILLER_AUTH_TYPES = {
  FillerAuth: [
    { name: 'fillerId', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

/** `GatewayMessage(bytes32 bodyHash)` — signed by the gateway key; `bodyHash = gatewayBodyHash(message)`. */
export const GATEWAY_MESSAGE_TYPES = {
  GatewayMessage: [{ name: 'bodyHash', type: 'bytes32' }],
} as const;

/** `FillerMessage(bytes32 bodyHash)` — the envelope `msgSig` of every filler message, by the message key; `bodyHash = fillerMessageBodyHash(message)`. */
export const FILLER_MESSAGE_TYPES = {
  FillerMessage: [{ name: 'bodyHash', type: 'bytes32' }],
} as const;

/**
 * `FillerKeyRegistration(string fillerId,address messageKey,uint64 issuedAt)` — proof of possession of a message key,
 * signed by that key: at onboarding, and with the NEW key at a manual key change by Cancore staff. There is no rotation type.
 */
export const FILLER_KEY_REGISTRATION_TYPES = {
  FillerKeyRegistration: [
    { name: 'fillerId', type: 'string' },
    { name: 'messageKey', type: 'address' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const;

export interface Order {
  user: Hex;
  originChainId: UintLike;
  inputToken: Hex;
  inputAmount: UintLike;
  destination: Hex;
  outputAsset: Hex;
  minReceived: UintLike;
  recipient: Hex;
  createdAt: UintLike;
  fillDeadline: UintLike;
  feeBps: number | string;
  /** `fillerIdHash(fillerId)` of the filler the user picked: only its ticket fills the order and only a proof naming it settles it (`WrongFiller`). */
  fillerId: Hex;
}

export interface Quote {
  orderHash: Hex;
  quoteDeadline: UintLike;
}

export interface FillTicket {
  orderHash: Hex;
  /** `fillerIdHash(fillerId)`: the on-chain form of the filler's id. */
  fillerId: Hex;
  /** The only address `fill` accepts this ticket from; the zero address never reaches a router (Canton destinations have no `FillTicket`). */
  deliveryKey: Hex;
  /** Where `settle` pays, encoded for the source chain (`repayToFromEvm`, `repayToFromParty`). */
  repayTo: Hex;
  attempt: number;
  validFrom: UintLike;
  validUntil: UintLike;
}

export interface FillerQuote {
  /** `requestIdHash(requestId)`, not the string. */
  requestId: Hex;
  fillerId: string;
  amountOut: UintLike;
  validUntil: UintLike;
  nonce: UintLike;
}

export interface TicketIntent {
  orderHash: Hex;
  attempt: number;
  validFrom: UintLike;
  validUntil: UintLike;
  /** The signer's own id, the string form. */
  fillerId: string;
  /** The address that will send `fill` on the destination; the zero address for a Canton destination. */
  deliveryKey: Hex;
  /** Where `settle` pays, encoded for the source chain. */
  repayTo: Hex;
}

export interface TicketReceipt {
  /** `hashTypedData` of the `FillTicket` in `FILL_TICKET_DOMAIN`. */
  ticketHash: Hex;
  /** keccak256 of the 65 raw signature bytes. */
  ticketSigHash: Hex;
}

export interface CantonTicketReceipt {
  orderHash: Hex;
  attempt: number;
  /** `deliveryOrderCidHash(deliveryOrderCid)`: keccak256 of the contract id exactly as `ticket.issued` sent it. */
  deliveryOrderCidHash: Hex;
  /** `ticket.issued.validUntil` (= `DeliveryOrder.validUntil`), unix seconds. */
  validUntil: UintLike;
}

export interface StakeBinding {
  partnerId: string;
  stakingAddress: Hex;
  chainId: UintLike;
  nonce: UintLike;
}

export interface FillerAuth {
  fillerId: string;
  nonce: Hex;
  expiresAt: UintLike;
}

export interface GatewayMessage {
  bodyHash: Hex;
}

export interface FillerMessage {
  bodyHash: Hex;
}

export interface FillerKeyRegistration {
  fillerId: string;
  /** The address derived from the key being registered. */
  messageKey: Hex;
  /** Unix seconds. */
  issuedAt: UintLike;
}
