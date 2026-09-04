/**
 * The wire this connector speaks, typed once (CAN-779).
 *
 * Every seam a test replaces lives here as a structural type rather than a DOM
 * lib type: the package has to run in node (the conformance harness) as well as
 * a browser, and `lib.dom` narrows `window.open` to something no fake satisfies.
 */

/** EIP-1193 error, the shape CIP-0103 inherits: a NUMERIC `code` at the top. */
export interface ProviderRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RequestArgs {
  method: string;
  params?: unknown;
}

export type ProviderListener = (...args: unknown[]) => void;

/** What a dApp holds. `on`/`removeListener` chain, `emit` answers whether anyone heard. */
export interface Cip0103Provider {
  request(args: RequestArgs): Promise<unknown>;
  on(event: string, listener: ProviderListener): Cip0103Provider;
  emit(event: string, ...args: unknown[]): boolean;
  removeListener(event: string, listener: ProviderListener): Cip0103Provider;
}

/** The grant the consent ceremony hands over, plus where to spend it. */
export interface CancoreSession {
  /** Opaque `cs_…` app-session grant. Bound to the dApp's origin by the backend. */
  token: string;
  /** Absolute URL of `POST /dapp/rpc`, as told to us by the wallet itself. */
  rpcUrl: string;
  scopes: string[];
  expiresAt: string;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The slice of `EventSource` we use. */
export interface StreamLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

/** The slice of `Window` the ceremony needs — opener side. */
export interface WindowLike {
  open(url: string, target: string, features: string): PopupLike | null;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

export interface PopupLike {
  postMessage(message: unknown, targetOrigin: string): void;
  close(): void;
  readonly closed: boolean;
}

export interface MessageEventLike {
  origin: string;
  source: unknown;
  data: unknown;
}

/**
 * Every error code CIP-0103 defines, with the CIP's own names.
 *
 * All of them, not just the five this connector raises itself: a dApp switching
 * on what the WALLET answered — `4200` for a method the provider declines,
 * `4100` for one the user never authorised, `-32005` for a limit — otherwise
 * writes the number by hand, and a number written by hand is a number nobody
 * can grep for when the meaning changes.
 *
 * Raised locally by this library: `METHOD_NOT_FOUND` (a name outside the CIP's
 * set, refused before the wire), `RESOURCE_UNAVAILABLE` (the consent window
 * went unanswered), `INTERNAL` (a wallet reply that is not an RPC answer),
 * `USER_REJECTED` and `DISCONNECTED`. The rest arrive from the wallet.
 */
export const RpcCode = {
  // EIP-1193 provider errors, as the CIP adopts them.
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  DISCONNECTED: 4900,
  CHAIN_DISCONNECTED: 4901,
  // JSON-RPC 2.0.
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // CIP-0103's own reserved range.
  INVALID_INPUT: -32000,
  RESOURCE_NOT_FOUND: -32001,
  RESOURCE_UNAVAILABLE: -32002,
  TRANSACTION_REJECTED: -32003,
  METHOD_NOT_SUPPORTED: -32004,
  LIMIT_EXCEEDED: -32005,
} as const;

export function rpcError(code: number, message: string, data?: unknown): ProviderRpcError {
  return data === undefined ? { code, message } : { code, message, data };
}
