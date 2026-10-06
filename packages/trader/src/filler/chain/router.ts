/**
 * `RouterReader` — the views of one pinned `CancoreRouter` (its `AttestorSet`
 * included) that the filler reads with its own RPC (fillers.md §3.2, INV-10).
 *
 * The address comes only from the node's own config (`chains.<caip2>.router`),
 * never from a filler-gateway message: nothing here takes an address from a
 * frame. Calls and results are encoded from `CANCORE_ROUTER_ABI` of
 * `@cancore/contracts`, so a view renamed or reshaped in evm-contracts fails at
 * the next sync, not at a filler holding someone's order.
 *
 * The router has no filler registry: nothing about a filler is read here
 * (fillers.md T-2; the registration views still in the pinned ABI are not
 * used and leave with CAN-2140).
 */
import { CANCORE_ROUTER_ABI, type FillProof, type FillTicket, type Hex, type Order } from '@cancore/contracts';
import type { EvmChainId } from '../chains';
import { AbiDecodeError, decodeFunctionResult, encodeFunctionCall, entryOf, type AbiEntry } from './abi';
import { ChainReadError, type ChainClient, type ReadAt } from './client';

/** `IntentStatus` of `ICancoreRouter`: 1 = `Opened` (fillers.md §3.2). */
export const INTENT_STATUS = { None: 0, Opened: 1, Settled: 2, Refunded: 3 } as const;

export interface IntentRecord {
  /** `IntentStatus`; `INTENT_STATUS.Opened` is the only one a filler delivers against. */
  status: number;
  /** Unix seconds: from then on anyone may refund, and `settle` races it. */
  refundAfter: bigint;
  openedAt: bigint;
}

export interface AttestorSetRecord {
  /** Strictly ascending. */
  members: Hex[];
  threshold: number;
  activeFrom: bigint;
  retiredAt: bigint;
}

const ROUTER_ABI = CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[];

export class RouterReader {
  constructor(
    readonly chain: EvmChainId,
    /** The pinned router, lowercase. */
    readonly address: Hex,
    readonly client: ChainClient,
  ) {}

  /** The escrow record of `orderHash` (source router). */
  async intents(orderHash: Hex, at?: ReadAt): Promise<IntentRecord> {
    const r = (await this.read('intents', [orderHash], at)) as { status: bigint; refundAfter: bigint; openedAt: bigint };
    return { status: Number(r.status), refundAfter: r.refundAfter, openedAt: r.openedAt };
  }

  /** Whether `orderHash` was delivered on this (destination) router. */
  async filled(orderHash: Hex, at?: ReadAt): Promise<boolean> {
    return (await this.read('filled', [orderHash], at)) as boolean;
  }

  /** Whether `signer` may sign `FillTicket`s accepted by this router. */
  async ticketSigners(signer: Hex, at?: ReadAt): Promise<boolean> {
    return (await this.read('ticketSigners', [signer], at)) as boolean;
  }

  /** The proof window (s) this source router sets for orders to `destination` (bytes32 chain id). */
  async proofWindow(destination: Hex, at?: ReadAt): Promise<bigint> {
    return (await this.read('proofWindow', [destination], at)) as bigint;
  }

  /** The attestor set fixed for `orderHash` when it opened — the one `settle` verifies against. */
  async attestationSetFor(orderHash: Hex, at?: ReadAt): Promise<number> {
    return Number((await this.read('attestationSetFor', [orderHash], at)) as bigint);
  }

  async getAttestorSet(setId: number, at?: ReadAt): Promise<AttestorSetRecord> {
    const r = (await this.read('getAttestorSet', [setId], at)) as { members: Hex[]; threshold: bigint; activeFrom: bigint; retiredAt: bigint };
    return { members: r.members, threshold: Number(r.threshold), activeFrom: r.activeFrom, retiredAt: r.retiredAt };
  }

  async revokedAttestors(attestor: Hex, at?: ReadAt): Promise<boolean> {
    return (await this.read('revokedAttestors', [attestor], at)) as boolean;
  }

  async currentSetId(at?: ReadAt): Promise<number> {
    return Number((await this.read('currentSetId', [], at)) as bigint);
  }

  async isMember(setId: number, attestor: Hex, at?: ReadAt): Promise<boolean> {
    return (await this.read('isMember', [setId, attestor], at)) as boolean;
  }

  /** `orderHash` of `order` in its source router's domain, as this (destination) router computes it. */
  async sourceOrderHash(order: Order, at?: ReadAt): Promise<Hex> {
    return (await this.read('sourceOrderHash', [order], at)) as Hex;
  }

  /** `orderHash` of `order` in this router's own domain (this router as the source). */
  async hashOrder(order: Order, at?: ReadAt): Promise<Hex> {
    return (await this.read('hashOrder', [order], at)) as Hex;
  }

  async hashTicket(ticket: FillTicket, at?: ReadAt): Promise<Hex> {
    return (await this.read('hashTicket', [ticket], at)) as Hex;
  }

  async hashFillProof(proof: FillProof, at?: ReadAt): Promise<Hex> {
    return (await this.read('hashFillProof', [proof], at)) as Hex;
  }

  /** The smallest `inputAmount` this (source) router opens for `token` (T-16). */
  async minInput(token: Hex, at?: ReadAt): Promise<bigint> {
    return (await this.read('minInput', [token], at)) as bigint;
  }

  /** Calls the view `name` of the router ABI; a result that does not decode is `malformed`. */
  async read(name: string, args: readonly unknown[], at: ReadAt = 'latest'): Promise<unknown> {
    const entry = entryOf(ROUTER_ABI, 'function', name);
    const data = await this.client.call(this.address, encodeFunctionCall(entry, args), at);
    try {
      return decodeFunctionResult(entry, data);
    } catch (error) {
      if (error instanceof AbiDecodeError) throw new ChainReadError(this.chain, 'malformed', `${name}: ${error.message}`, { cause: error });
      throw error;
    }
  }
}
