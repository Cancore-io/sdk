/**
 * `@cancore/contracts` — the Cancore EVM contracts as data.
 *
 * ABIs (`./abi`), the network registry (`./networks`), the EIP-712 voucher and
 * the release identity — no runtime code, no dependencies. What an integrator
 * needs to talk to the contracts without copying files out of our repositories,
 * and what our own frontend, backend and MCP server can stop carrying four
 * separate copies of.
 */
export * from './abi';
export * from './networks';
export * from './deployments';
export * from './eip712';
export { BYTECODE_HASHES, CONTRACTS_RELEASE } from './generated/meta';

/** Decode a revert's 4-byte selector into the custom error it names, if it is one of ours. */
export function describeRevert(selectorOrData: string, tables: ReadonlyArray<Readonly<Record<string, string>>>): string | undefined {
  const selector = selectorOrData.slice(0, 10).toLowerCase();
  for (const table of tables) {
    const hit = table[selector];
    if (hit) return hit;
  }
  return undefined;
}
