import type { Hex } from '@cancore/contracts';
import { isEvmChainId } from './chains';
import type { FillerChains } from './chain';
import type { MinInputSource } from './quotes';
import type { Clock } from './runtime';

/**
 * How long a source router's `minInput` read is reused for quotes. A stale floor is
 * not a money risk: `openFor` reverts on-chain when the router raised it since (T-16).
 */
export const MIN_INPUT_CACHE_TTL_MS = 60_000;

/** The source routers' `minInput` per (chain, router, token), read at most once per TTL; a failed read is never kept. */
export class MinInputCache {
  private readonly reads = new Map<string, { minInput: bigint; readAtMs: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number = MIN_INPUT_CACHE_TTL_MS,
  ) {}

  async get(key: { chain: string; router: string; token: string }, read: () => Promise<bigint>): Promise<bigint> {
    const id = `${key.chain}|${key.router.toLowerCase()}|${key.token.toLowerCase()}`;
    const kept = this.reads.get(id);
    if (kept && this.clock.now() - kept.readAtMs < this.ttlMs) return kept.minInput;
    const minInput = await read();
    this.reads.set(id, { minInput, readAtMs: this.clock.now() });
    return minInput;
  }
}

/** T-16: the source router's own floor, read at the head and reused for `MIN_INPUT_CACHE_TTL_MS`. */
export function routerMinInputSource(chains: Pick<FillerChains, 'get'>, cache: MinInputCache): MinInputSource {
  return async (chain, token) => {
    if (!isEvmChainId(chain)) return undefined; // a Canton source has no router floor
    const source = chains.get(chain);
    // N-12: an EVM source this filler has no router for is one it cannot verify or settle on — no quote.
    if (!source) throw new Error(`no router configured for the source ${chain}`);
    if (typeof token !== 'string') return undefined;
    return cache.get({ chain, router: source.router.address, token }, () => source.router.minInput(token as Hex));
  };
}
