/**
 * EVM JSON-RPC, injected. One `EvmRpc` is one endpoint; a chain is given
 * several (`EvmRpcMap`), and the SDK decides how to use them — quorum reads,
 * failover, confirmation depth (CAN-1846). The interface is EIP-1193 `request`,
 * so any client adapts in a line: ethers `provider.send(method, params)`, a viem
 * transport, or a bare `fetch` to the endpoint.
 */
import type { EvmChainId } from './chains';

export interface EvmRpcRequest {
  method: string;
  params?: readonly unknown[];
}

export interface EvmRpc {
  /**
   * A name for logs and metrics, e.g. `alchemy-eth`. Never the URL: provider
   * URLs carry API keys.
   */
  readonly label: string;
  /** Rejects with the JSON-RPC error (`code`, `message`, `data`) or a transport error. */
  request<T = unknown>(request: EvmRpcRequest): Promise<T>;
}

/** The endpoints of every EVM chain the filler works on; at least one per chain. */
export type EvmRpcMap = { readonly [chain: EvmChainId]: readonly EvmRpc[] };
