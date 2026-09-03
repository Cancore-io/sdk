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

/** CIP-0103 codes this connector produces on its own, without asking the wallet. */
export const RpcCode = {
  METHOD_NOT_FOUND: -32601,
  TIMED_OUT: -32002,
  INTERNAL: -32603,
  USER_REJECTED: 4001,
  DISCONNECTED: 4900,
} as const;

export function rpcError(code: number, message: string, data?: unknown): ProviderRpcError {
  return data === undefined ? { code, message } : { code, message, data };
}
