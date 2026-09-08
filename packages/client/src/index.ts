/**
 * `@cancore/client` — a typed client for the Cancore API.
 *
 * Two entries, one seam: you inject the request function that carries your
 * credential, the client adds routes, bodies and one error type. Nothing here
 * holds a key or signs; where a step needs a signature, the client hands you a
 * hash and takes the signature back.
 */
export { createHttp, CancoreApiError } from './http';
export type { ClientOptions, FetchLike, Http } from './http';
export { createSwapClient, swap, TERMINAL_ORDER_STATUSES, TrackTimeoutError } from './swap';
export type {
  CreateOrderInput,
  CreatePairOrderInput,
  Executed,
  ListOrdersQuery,
  Order,
  OrderStatus,
  OrderUser,
  Page,
  Quote,
  SwapClient,
  SwapStatus,
  TrackOptions,
} from './swap';
export { createBridgeClient, bridge } from './bridge';
export type {
  BridgeClient,
  BridgeCostEstimate,
  BridgeHistoryItem,
  BridgeHistoryQuery,
  BridgeLimits,
  BridgeOperation,
  BurnInput,
  MintInput,
  OnboardingStatus,
  PreparedHashSigner,
  PreparedInteractive,
  PrepareInteractiveInput,
} from './bridge';

import { createBridgeClient, type BridgeClient } from './bridge';
import { createHttp, type ClientOptions } from './http';
import { createSwapClient, type SwapClient } from './swap';

export interface CancoreClient {
  swap: SwapClient;
  bridge: BridgeClient;
}

export function createClient(options: ClientOptions): CancoreClient {
  const http = createHttp(options);
  return { swap: createSwapClient(http), bridge: createBridgeClient(http) };
}
