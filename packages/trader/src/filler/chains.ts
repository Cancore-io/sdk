/** CAIP-2 chain ids as protocol §3.1 encodes them. */

/** `eip155:<decimal chain id>`, no leading zero. */
export type EvmChainId = `eip155:${string}`;
/** `canton:<network>`, `<network>` ∈ `mainnet`, `testnet`, `devnet`. */
export type CantonChainId = `canton:${string}`;
export type Caip2 = EvmChainId | CantonChainId;

const EVM_CHAIN = /^eip155:[1-9][0-9]*$/;

export const isEvmChainId = (value: string): value is EvmChainId => EVM_CHAIN.test(value);

/** The numeric chain id of an `eip155:` CAIP-2 id. */
export function evmChainNumber(chain: EvmChainId): bigint {
  if (!isEvmChainId(chain)) throw new TypeError(`not an eip155 CAIP-2 chain id: ${chain}`);
  return BigInt(chain.slice('eip155:'.length));
}
