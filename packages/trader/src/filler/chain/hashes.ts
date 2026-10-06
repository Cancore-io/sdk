/**
 * The router's three EIP-712 digests, computed locally from the types and
 * domains of `@cancore/contracts` (sdk.md S1: compositions of `hashTypedData`,
 * no second encoder). Each equals the router's own view — `hashOrder` /
 * `sourceOrderHash`, `hashTicket`, `hashFillProof` — and the golden vectors
 * under `@cancore/contracts/spec/typed-data`. The Canton-source order rule
 * (`buildCantonSourceOrder`) is CAN-1863.
 */
import {
  FILL_PROOF_TYPES,
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  ORDER_TYPES,
  fillProofDomain,
  hashTypedData,
  routerDomain,
  type FillProof,
  type FillTicket,
  type Hex,
  type Order,
  type UintLike,
} from '@cancore/contracts';

/** The source router an order and its proof are hashed against: `{chainId = order.originChainId, verifyingContract}`. */
export interface SourceRouter {
  chainId: UintLike;
  router: Hex;
}

/** `orderHash`: the order's digest in its SOURCE router's domain (V-E1). */
export const hashOrder = (order: Order, source: SourceRouter): Hex =>
  hashTypedData({ domain: routerDomain(source.chainId, source.router), types: ORDER_TYPES, primaryType: 'Order', message: { ...order } });

/** `hashTicket`: the ticket's digest in the `CancoreFillTicket` domain — no chain id, no router, so one ticket verifies everywhere. */
export const hashTicket = (ticket: FillTicket): Hex =>
  hashTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: { ...ticket } });

/** `hashFillProof`: the proof's digest in the order's source router domain. */
export const hashFillProof = (proof: FillProof, source: SourceRouter): Hex =>
  hashTypedData({
    domain: fillProofDomain(BigInt(source.chainId), source.router),
    types: FILL_PROOF_TYPES,
    primaryType: 'FillProof',
    message: { ...proof },
  });
