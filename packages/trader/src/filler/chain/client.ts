/**
 * One EVM chain behind several injected endpoints (`EvmRpc`), used in the
 * configured order (filler-node.md `rpc.<caip2>`: «the first healthy one is
 * used»):
 *
 * - **Chain id.** Every endpoint answers `eth_chainId` before its first use;
 *   one that names another chain than the configured CAIP-2 id is never used
 *   again (filler-node C-1).
 * - **Failover.** A transport or node error moves the request to the next
 *   endpoint. A revert is the chain's answer, not an endpoint failure: it is
 *   not retried elsewhere.
 * - **Head lag.** Reads at a depth start from the head; an endpoint whose head
 *   trails the best head seen by more than `maxHeadLagBlocks` is passed over
 *   while a fresher one answers (`ops.maxHeadLagBlocks`).
 * - **Depth.** A read names where it reads (`ReadAt`): `latest`, `safe`,
 *   `finalized`, `confirmations` blocks below the head, or a block number.
 *   The tag is resolved to one block number first, so every call of one check
 *   sees the same block, whichever endpoint serves it.
 *
 * Every failure is a `ChainReadError` naming the chain and the reason. The
 * SDK never reads a chain it could not verify: a caller that gets one refuses
 * whatever depended on the read (fillers.md N-12: unverifiable → decline).
 */
import type { Hex } from '@cancore/contracts';
import { evmChainNumber, type EvmChainId } from '../chains';
import type { Logger } from '../runtime';
import type { EvmRpc } from '../rpc';

export type ReadAt =
  | 'latest'
  | 'safe'
  | 'finalized'
  /** `head − confirmations`: the block an escrow must already be open at (V-E2, `openConfirmations`). */
  | { confirmations: number }
  | { blockNumber: bigint };

export type ChainReadFailure =
  /** `eth_chainId` of every endpoint that answered names another chain. */
  | 'wrong-chain'
  /** No endpoint answered (transport errors, node errors, no fresh head). */
  | 'unavailable'
  /** The call reverted. */
  | 'reverted'
  /** An answer that is not what the method returns (bad hex, bad ABI encoding, missing block). */
  | 'malformed';

export class ChainReadError extends Error {
  override readonly name = 'ChainReadError';
  constructor(
    readonly chain: EvmChainId,
    readonly reason: ChainReadFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${chain}: ${message}`, options);
  }
}

export interface ChainClientOptions {
  chain: EvmChainId;
  /** In order of preference; at least one. */
  endpoints: readonly EvmRpc[];
  maxHeadLagBlocks: number;
  logger: Logger;
}

/** What `health()` reports per endpoint, for the node's `check` (C-1). */
export interface EndpointHealth {
  label: string;
  /** False when `eth_chainId` named another chain; undefined when it did not answer. */
  chainIdOk?: boolean;
  head?: bigint;
  /** Blocks behind the best head of this round. */
  lag?: bigint;
  error?: string;
}

export interface BlockHeader {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
}

interface Endpoint {
  readonly rpc: EvmRpc;
  /** undefined until `eth_chainId` answered; then whether it matched. */
  chainOk?: boolean;
  /** Passed over by plain requests until the next head round finds it fresh again. */
  lagging: boolean;
}

const HEX_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) throw new TypeError(`${what}: expected a hex quantity, got ${String(value)}`);
  return BigInt(value);
}

export const toQuantity = (n: bigint): string => `0x${n.toString(16)}`;

/** JSON-RPC answers that mean "the call reverted" rather than "this endpoint failed". */
function isRevert(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 3 || (typeof message === 'string' && /revert/i.test(message));
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : String(error));

export class ChainClient {
  readonly chain: EvmChainId;
  private readonly endpoints: Endpoint[];
  private readonly expectedChainId: bigint;
  private bestHead = -1n;

  constructor(private readonly options: ChainClientOptions) {
    if (options.endpoints.length === 0) throw new TypeError(`${options.chain}: at least one RPC endpoint is required`);
    if (!Number.isSafeInteger(options.maxHeadLagBlocks) || options.maxHeadLagBlocks < 0) throw new TypeError(`${options.chain}: maxHeadLagBlocks must be a non-negative integer`);
    this.chain = options.chain;
    this.expectedChainId = evmChainNumber(options.chain);
    this.endpoints = options.endpoints.map((rpc) => ({ rpc, lagging: false }));
  }

  /**
   * One JSON-RPC request with failover: fresh endpoints in order, then the
   * lagging ones. A revert is thrown as `reverted` at once.
   */
  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const ordered = [...this.endpoints.filter((e) => !e.lagging), ...this.endpoints.filter((e) => e.lagging)];
    const errors: string[] = [];
    for (const endpoint of ordered) {
      if (!(await this.verified(endpoint, errors))) continue;
      try {
        return await endpoint.rpc.request<T>({ method, params });
      } catch (error) {
        if (isRevert(error)) throw new ChainReadError(this.chain, 'reverted', `${method} reverted: ${describeError(error)}`, { cause: error });
        errors.push(`${endpoint.rpc.label}: ${describeError(error)}`);
        this.options.logger.warn('chain: endpoint failed, trying the next', { chain: this.chain, endpoint: endpoint.rpc.label, method, error: describeError(error) });
      }
    }
    throw this.exhausted(method, errors);
  }

  /**
   * The head, from the first endpoint in order whose head is within
   * `maxHeadLagBlocks` of the best head every endpoint reported this round.
   */
  async head(): Promise<bigint> {
    const errors: string[] = [];
    const heads = await Promise.all(
      this.endpoints.map(async (endpoint) => {
        if (!(await this.verified(endpoint, errors))) return undefined;
        try {
          return quantity(await endpoint.rpc.request({ method: 'eth_blockNumber', params: [] }), 'eth_blockNumber');
        } catch (error) {
          errors.push(`${endpoint.rpc.label}: ${describeError(error)}`);
          return undefined;
        }
      }),
    );
    for (const h of heads) if (h !== undefined && h > this.bestHead) this.bestHead = h;
    const floor = this.bestHead - BigInt(this.options.maxHeadLagBlocks);
    let chosen: bigint | undefined;
    this.endpoints.forEach((endpoint, i) => {
      const h = heads[i];
      if (h === undefined) return;
      endpoint.lagging = h < floor;
      if (endpoint.lagging) {
        this.options.logger.warn('chain: endpoint head lags, passed over', { chain: this.chain, endpoint: endpoint.rpc.label, head: h.toString(), best: this.bestHead.toString() });
      } else chosen ??= h;
    });
    if (chosen === undefined) throw this.exhausted('eth_blockNumber', errors);
    return chosen;
  }

  /** The block number a read at `at` reads. */
  async resolve(at: ReadAt): Promise<bigint> {
    if (typeof at === 'object' && 'blockNumber' in at) return at.blockNumber;
    if (typeof at === 'object') {
      if (!Number.isSafeInteger(at.confirmations) || at.confirmations < 0) throw new TypeError('confirmations must be a non-negative integer');
      const target = (await this.head()) - BigInt(at.confirmations);
      return target < 0n ? 0n : target;
    }
    if (at === 'latest') return this.head();
    return (await this.block(at)).number;
  }

  /** `eth_call` of `data` on `to` at `at`. */
  async call(to: Hex, data: Hex, at: ReadAt = 'latest'): Promise<Hex> {
    const block = await this.resolve(at);
    const result = await this.request<unknown>('eth_call', [{ to, data }, toQuantity(block)]);
    if (typeof result !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(result)) throw new ChainReadError(this.chain, 'malformed', `eth_call returned ${String(result)}`);
    return result as Hex;
  }

  /** A block header by number or tag; `malformed` when the node has no such block. */
  async block(at: bigint | 'latest' | 'safe' | 'finalized'): Promise<BlockHeader> {
    const tag = typeof at === 'bigint' ? toQuantity(at) : at;
    const raw = await this.request<unknown>('eth_getBlockByNumber', [tag, false]);
    if (typeof raw !== 'object' || raw === null) throw new ChainReadError(this.chain, 'malformed', `no block ${tag}`);
    const { number, hash, parentHash } = raw as Record<string, unknown>;
    try {
      if (typeof hash !== 'string' || !HEX32.test(hash) || typeof parentHash !== 'string' || !HEX32.test(parentHash)) throw new TypeError('bad hash');
      return { number: quantity(number, 'block.number'), hash: hash.toLowerCase() as Hex, parentHash: parentHash.toLowerCase() as Hex };
    } catch (error) {
      throw new ChainReadError(this.chain, 'malformed', `block ${tag}: ${describeError(error)}`, { cause: error });
    }
  }

  /** Native balance of `address` at `at`. */
  async balance(address: Hex, at: ReadAt = 'latest'): Promise<bigint> {
    const block = await this.resolve(at);
    const raw = await this.request<unknown>('eth_getBalance', [address, toQuantity(block)]);
    try {
      return quantity(raw, 'eth_getBalance');
    } catch (error) {
      throw new ChainReadError(this.chain, 'malformed', describeError(error), { cause: error });
    }
  }

  /** Every endpoint, probed now: chain id, head, lag. Never throws. */
  async health(): Promise<EndpointHealth[]> {
    const rows = await Promise.all(
      this.endpoints.map(async (endpoint): Promise<EndpointHealth> => {
        const row: EndpointHealth = { label: endpoint.rpc.label };
        try {
          row.chainIdOk = quantity(await endpoint.rpc.request({ method: 'eth_chainId', params: [] }), 'eth_chainId') === this.expectedChainId;
          if (!row.chainIdOk) return row;
          row.head = quantity(await endpoint.rpc.request({ method: 'eth_blockNumber', params: [] }), 'eth_blockNumber');
        } catch (error) {
          row.error = describeError(error);
        }
        return row;
      }),
    );
    const best = rows.reduce((max, r) => (r.head !== undefined && r.head > max ? r.head : max), -1n);
    for (const r of rows) if (r.head !== undefined) r.lag = best - r.head;
    return rows;
  }

  /** Whether `endpoint` serves the configured chain; asks `eth_chainId` once. */
  private async verified(endpoint: Endpoint, errors: string[]): Promise<boolean> {
    if (endpoint.chainOk !== undefined) {
      if (!endpoint.chainOk) errors.push(`${endpoint.rpc.label}: wrong chain`);
      return endpoint.chainOk;
    }
    let chainId: bigint;
    try {
      chainId = quantity(await endpoint.rpc.request({ method: 'eth_chainId', params: [] }), 'eth_chainId');
    } catch (error) {
      errors.push(`${endpoint.rpc.label}: eth_chainId: ${describeError(error)}`);
      return false;
    }
    endpoint.chainOk = chainId === this.expectedChainId;
    if (!endpoint.chainOk) {
      errors.push(`${endpoint.rpc.label}: wrong chain`);
      this.options.logger.error('chain: endpoint serves another chain, never used', { chain: this.chain, endpoint: endpoint.rpc.label, chainId: chainId.toString() });
    }
    return endpoint.chainOk;
  }

  private exhausted(method: string, errors: string[]): ChainReadError {
    const allWrong = this.endpoints.every((e) => e.chainOk === false);
    return new ChainReadError(this.chain, allWrong ? 'wrong-chain' : 'unavailable', `${method}: no endpoint answered (${errors.join('; ') || 'none'})`);
  }
}
