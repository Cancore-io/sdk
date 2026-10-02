/**
 * Clock, logger, the WebSocket factory and HTTP — everything the SDK would
 * otherwise reach for as a global. Injected so tests drive time and frames, and
 * so the package needs neither a global `WebSocket` (absent in Node 20, which
 * `engines` allows) nor Node types in its published declarations.
 */

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Cancels a scheduled callback; calling it twice, or after the callback ran, does nothing. */
export type Cancel = () => void;

/**
 * Process time. Deadlines on the wire (`windowCloseAt`, `acceptBy`, `replyBy`)
 * are compared against `now()`; nonce leases are NOT — they expire by store
 * time (`FillerStore.now()`), because replicas' clocks differ.
 */
export interface Clock {
  /** Unix milliseconds. */
  now(): number;
  /** Runs `callback` once after `delayMs`. */
  schedule(delayMs: number, callback: () => void): Cancel;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

/**
 * Structured logging. The SDK never passes signatures, signed payloads,
 * prepared transactions or key material in `message` or `fields` (sdk.md S8).
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const ignore = (): void => undefined;
export const silentLogger: Logger = { debug: ignore, info: ignore, warn: ignore, error: ignore };

// ---------------------------------------------------------------------------
// WebSocket to filler-gateway
// ---------------------------------------------------------------------------

/** Callbacks the SDK hands to the factory; the adapter calls them. */
export interface FillerSocketHandlers {
  onOpen(): void;
  /** One text frame, as received (protocol §3.1: one JSON object per UTF-8 text frame). */
  onMessage(text: string): void;
  /** Called once, whether the SDK, the server or the network closed it. */
  onClose(code: number, reason: string): void;
  onError(error: unknown): void;
}

/** One connection. `send` takes one text frame; `close` is idempotent. */
export interface FillerSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Opens a connection to `url` (`wss://<filler-gateway host>/v1`) and reports
 * on it through `handlers`. The SDK calls it on every (re)connect; one call,
 * one connection. With the `ws` package:
 *
 * ```ts
 * const webSocket: WebSocketFactory = (url, h) => {
 *   const ws = new WebSocket(url);
 *   ws.on('open', h.onOpen);
 *   ws.on('message', (data, isBinary) => { if (!isBinary) h.onMessage(data.toString('utf8')); });
 *   ws.on('close', (code, reason) => h.onClose(code, reason.toString('utf8')));
 *   ws.on('error', h.onError);
 *   return { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
 * };
 * ```
 */
export type WebSocketFactory = (url: string, handlers: FillerSocketHandlers) => FillerSocket;

// ---------------------------------------------------------------------------
// HTTP (REST fallback of filler-gateway, drand relays)
// ---------------------------------------------------------------------------

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export interface HttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

/**
 * The slice of `fetch` the SDK uses. The global `fetch` of Node 20+ fits it
 * as is and is the default; inject one to add a proxy, mTLS or a test double.
 */
export type HttpFetch = (url: string, request: HttpRequest) => Promise<HttpResponse>;
