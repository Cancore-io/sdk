/**
 * `@cancore/contracts/networks` — the chains Cancore settles on, by the ids the
 * API uses (`sourceNetwork`, `targetNetwork` in an order are these keys).
 *
 * Three kinds, because three address formats and three signing models:
 * `evm` (0x…, EIP-155 chain id), `tron` (base58, same Solidity, no chain id in
 * the EVM sense), `canton` (party ids, no addresses at all). A caller that
 * branches on `kind` instead of on the id keeps working when a chain is added.
 *
 * Contract addresses live next door in `DEPLOYMENTS`, keyed by environment —
 * dev, testnet and mainnet each have their own HTLC — and `BYTECODE_HASHES`
 * (from `.`) is how a deployment at any of those addresses is verified.
 */

export type NetworkKind = 'evm' | 'tron' | 'canton';

export interface Network {
  /** The id the Cancore API uses for this chain. */
  id: string;
  kind: NetworkKind;
  name: string;
  /** EIP-155 chain id; absent for Tron and Canton. */
  chainId?: number;
  /** Where a transaction or address of this chain can be looked at. */
  explorerUrl?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  testnet: boolean;
}

export const NETWORKS: Readonly<Record<string, Network>> = {
  canton: { id: 'canton', kind: 'canton', name: 'Canton', testnet: false },
  ethereum: {
    id: 'ethereum', kind: 'evm', name: 'Ethereum', chainId: 1, explorerUrl: 'https://etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, testnet: false,
  },
  sepolia: {
    id: 'sepolia', kind: 'evm', name: 'Sepolia', chainId: 11155111, explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 }, testnet: true,
  },
  bnb: {
    id: 'bnb', kind: 'evm', name: 'BNB Chain', chainId: 56, explorerUrl: 'https://bscscan.com',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, testnet: false,
  },
  bnb_testnet: {
    id: 'bnb_testnet', kind: 'evm', name: 'BNB Testnet', chainId: 97, explorerUrl: 'https://testnet.bscscan.com',
    nativeCurrency: { name: 'Test BNB', symbol: 'tBNB', decimals: 18 }, testnet: true,
  },
  arbitrum: {
    id: 'arbitrum', kind: 'evm', name: 'Arbitrum One', chainId: 42161, explorerUrl: 'https://arbiscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, testnet: false,
  },
  arbitrum_sepolia: {
    id: 'arbitrum_sepolia', kind: 'evm', name: 'Arbitrum Sepolia', chainId: 421614, explorerUrl: 'https://sepolia.arbiscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, testnet: true,
  },
  robinhood: {
    id: 'robinhood', kind: 'evm', name: 'Robinhood Chain', chainId: 4663, explorerUrl: 'https://robinhoodchain.blockscout.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, testnet: false,
  },
  robinhood_testnet: {
    id: 'robinhood_testnet', kind: 'evm', name: 'Robinhood Testnet', chainId: 46630, explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, testnet: true,
  },
  tron_nile: { id: 'tron_nile', kind: 'tron', name: 'Tron Nile', explorerUrl: 'https://nile.tronscan.org', testnet: true },
  tron_shasta: { id: 'tron_shasta', kind: 'tron', name: 'Tron Shasta', explorerUrl: 'https://shasta.tronscan.org', testnet: true },
};

/** `eth` is an older alias of `ethereum` still seen in order payloads. */
export const NETWORK_ALIASES: Readonly<Record<string, string>> = { eth: 'ethereum' };

export function networkOf(id: string): Network | undefined {
  return NETWORKS[NETWORK_ALIASES[id] ?? id];
}

export function networkKindOf(id: string): NetworkKind | undefined {
  return networkOf(id)?.kind;
}

/** The network for an EIP-155 chain id, e.g. from a wallet's `eth_chainId`. */
export function networkByChainId(chainId: number): Network | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}
