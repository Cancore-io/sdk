/**
 * The chains a filler reads: one `ChainClient` and one `RouterReader` per
 * configured EVM chain, built from `FillerConfig.rpc` and `FillerConfig.chains`.
 */
import type { Hex } from '@cancore/contracts';
import { isEvmChainId, type EvmChainId } from '../chains';
import type { EvmRpcMap } from '../rpc';
import type { Logger } from '../runtime';
import { ChainClient } from './client';
import { RouterReader } from './router';

/** How the SDK reads one EVM chain. Every value comes from the node's config; none has a default (CAN-1720). */
export interface ChainConfig {
  /** The pinned `CancoreRouter` of this chain (filler-node `routers.<caip2>`); never taken from filler-gateway. */
  router: Hex;
  /** Blocks below the head an escrow must already be open at to count (V-E2, `openConfirmations`). */
  openConfirmations: number;
  /** An endpoint whose head trails the best one by more than this is passed over (`ops.maxHeadLagBlocks`). */
  maxHeadLagBlocks: number;
  /** `MIN_TICKET_TTL[destination]`, seconds (V-T3). */
  minTicketTtlSec: number;
  /** The filler's own proof window for orders to this destination, seconds: finality + p99 attestation + p99 `settle` + margin (V-E3; filler-node `minProofWindowSec`). */
  requiredProofWindowSec: number;
  /** p99 inclusion time of `fill`, seconds: a ticket with less left is refused (V-T3, T-29; filler-node `sendGuardSec`). */
  sendGuardSec: number;
  /** Native balance the delivery address must hold for gas, wei (V-E5; filler-node `ops.minGas`). */
  minGasWei: bigint;
  /** Blocks deep an own transaction (`fill`, `settle`) must be before it counts as done; until then a reorg is answered by resending. Default `openConfirmations`. */
  fillConfirmations?: number;
  /** Ceiling on `maxFeePerGas`, wei: no transaction and no replacement is priced above it. Default none. */
  maxFeePerGasWei?: bigint;
}

export interface ChainReaders {
  readonly chain: EvmChainId;
  readonly config: Readonly<ChainConfig>;
  readonly client: ChainClient;
  readonly router: RouterReader;
}

export class FillerChains {
  private readonly byChain = new Map<EvmChainId, ChainReaders>();

  constructor(rpc: EvmRpcMap, chains: { readonly [chain: EvmChainId]: ChainConfig }, logger: Logger) {
    for (const [chain, config] of Object.entries(chains) as Array<[EvmChainId, ChainConfig]>) {
      const client = new ChainClient({ chain, endpoints: rpc[chain] ?? [], maxHeadLagBlocks: config.maxHeadLagBlocks, logger });
      this.byChain.set(chain, { chain, config, client, router: new RouterReader(chain, config.router.toLowerCase() as Hex, client) });
    }
  }

  /** The readers of `chain`; undefined for a chain not configured (or not EVM). */
  get(chain: string): ChainReaders | undefined {
    return isEvmChainId(chain) ? this.byChain.get(chain) : undefined;
  }

  get chains(): readonly EvmChainId[] {
    return [...this.byChain.keys()];
  }
}

export { AbiDecodeError } from './abi';
export { ChainClient, ChainReadError } from './client';
export type { BlockHeader, ChainReadFailure, EndpointHealth, ReadAt } from './client';
export { RouterEventWatcher, ROUTER_EVENTS } from './events';
export type { RouterEventName, RouterEventUpdate, RouterEventWatcherOptions, RouterLog } from './events';
export { hashFillProof, hashOrder, hashTicket } from './hashes';
export type { SourceRouter } from './hashes';
export { INTENT_STATUS, RouterReader } from './router';
export type { AttestorSetRecord, IntentRecord } from './router';
