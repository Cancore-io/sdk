import { runConnectCeremony } from './connect';
import {
  RpcCode,
  rpcError,
  type CancoreSession,
  type Cip0103Provider,
  type FetchLike,
  type ProviderListener,
  type ProviderRpcError,
  type RequestArgs,
  type StreamLike,
  type WindowLike,
} from './types';

/**
 * A CIP-0103 provider for a Cancore wallet, remote (asynchronous) profile.
 *
 * Why this exists at all, given `@canton-network/core-provider-dapp` already
 * ships a `DappAsyncProvider` for exactly this transport: its `HttpTransport`
 * throws the whole JSON-RPC envelope — `{jsonrpc, id, error: {code, …}}` — so
 * what a dApp catches has no numeric `code` at the top, which is the one thing
 * EIP-1193 and CIP-0103 promise. Every error handler written against the
 * standard misses. It also adopts a session token from ANY `postMessage`
 * carrying `SPLICE_WALLET_IDP_AUTH_SUCCESS` without reading `event.origin`,
 * which lets any frame on the dApp's page repoint the provider at another
 * wallet. Both are upstream's to fix; neither is something we can ship over.
 *
 * What this is NOT: a second implementation of the wallet. The methods are the
 * server's (`apps/trading/src/dapp-rpc`); this is the client that reaches them,
 * plus the consent ceremony that gets a grant in the first place.
 */

/** The CIP's ten, and our three vendor extensions. Anything else is -32601 here. */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'status',
  'connect',
  'isConnected',
  'disconnect',
  'getActiveNetwork',
  'listAccounts',
  'getPrimaryAccount',
  'signMessage',
  'prepareExecute',
  // Answered `4200 Unsupported Method` by the wallet, on purpose (CAN-776 §2.2,
  // CAN-842): a server-side provider MUST NOT proxy ledger reads per the CIP,
  // and handing out an access token is worse. Kept in the list so the refusal
  // comes from the wallet with the code the spec names, rather than from here.
  'ledgerApi',
  'cancore_streamTicket',
  'cancore_getTxOutcome',
  'cancore_getMessageSignature',
]);

/** Event names as they travel on the SSE wire (CAN-776 PR-2). */
const STREAM_EVENTS = ['connected', 'statusChanged', 'accountsChanged', 'txChanged', 'messageSignature'];

/** The stream has no replay buffer; a reconnect storm would only make that worse. */
const STREAM_RETRY_MS = 3000;

export interface CancoreProviderOptions {
  /** Wallet origin, e.g. `https://app-dev.cancore.app`. */
  host: string;
  /** Name shown on the consent screen. */
  appName?: string;
  /** Scopes to request. Default is the read-only pair; add `wallet:sign` to sign. */
  scopes?: string[];
  /** A grant the dApp already holds — skips the ceremony. */
  session?: CancoreSession;
  win?: WindowLike;
  fetchImpl?: FetchLike;
  openStream?: (url: string) => StreamLike;
  /** Test seam: `setTimeout`, so a retry does not hold a suite open. */
  schedule?: (run: () => void, ms: number) => void;
}

export class CancoreProvider implements Cip0103Provider {
  private readonly listeners = new Map<string, ProviderListener[]>();
  private readonly options: CancoreProviderOptions;
  private session: CancoreSession | null;
  private stream: StreamLike | null = null;
  private streaming = false;
  private closed = false;
  private nextId = 1;

  constructor(options: CancoreProviderOptions) {
    this.options = options;
    this.session = options.session ?? null;
  }

  async request(args: RequestArgs): Promise<unknown> {
    const { method, params } = args;
    if (!KNOWN_METHODS.has(method)) {
      throw rpcError(RpcCode.METHOD_NOT_FOUND, `Method ${method} not found`);
    }
    if (method !== 'connect') return this.send(method, params);

    // Synchronous up to here: `window.open` must still be inside the click.
    const ceremony = this.session ? null : this.beginCeremony();
    if (ceremony) this.session = await ceremony;
    // Before the RPC, never after: `connect` answers on the stream
    // (`statusChanged` + `connected`), and a stream opened afterwards has
    // already missed them.
    await this.listen();
    return this.send('connect', params);
  }

  on(event: string, listener: ProviderListener): this {
    const bucket = this.listeners.get(event);
    if (bucket) bucket.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  removeListener(event: string, listener: ProviderListener): this {
    const bucket = this.listeners.get(event);
    if (bucket) this.listeners.set(event, bucket.filter((known) => known !== listener));
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const bucket = this.listeners.get(event);
    if (!bucket || bucket.length === 0) return false;
    for (const listener of [...bucket]) listener(...args);
    return true;
  }

  /** Drops the stream. The grant stays valid — `disconnect` is what revokes it. */
  close(): void {
    this.closed = true;
    this.stream?.close();
    this.stream = null;
  }

  private beginCeremony(): Promise<CancoreSession> {
    const win = this.options.win ?? (globalThis as { window?: WindowLike }).window;
    if (!win) {
      return Promise.reject(
        rpcError(RpcCode.DISCONNECTED, 'Connecting needs a browser window for the consent screen'),
      );
    }
    return runConnectCeremony({
      host: this.options.host,
      appName: this.options.appName ?? 'A dApp',
      scopes: this.options.scopes ?? ['wallet:connect', 'wallet:accounts'],
      win,
    });
  }

  private async send(method: string, params: unknown): Promise<unknown> {
    const session = this.session;
    if (!session) {
      throw rpcError(RpcCode.DISCONNECTED, 'No Cancore grant yet — call connect first');
    }
    const call = { jsonrpc: '2.0', id: this.nextId++, method, params };
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

    let response;
    try {
      response = await fetchImpl(session.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify(call),
      });
    } catch (cause) {
      throw rpcError(RpcCode.DISCONNECTED, 'The Cancore wallet could not be reached', String(cause));
    }

    const body = (await response.json().catch(() => null)) as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    } | null;

    const failure = readRpcError(body);
    if (failure) throw failure;
    if (!response.ok) {
      throw rpcError(RpcCode.INTERNAL, `The wallet answered HTTP ${response.status} with no RPC error`);
    }
    return body?.result;
  }

  /**
   * Opens the event stream, once.
   *
   * The credential in the URL is a one-shot 30-second ticket, not the grant:
   * `EventSource` cannot set headers, so whatever authenticates the stream ends
   * up in access logs and `Referer`. That also means the browser's own
   * reconnect — which replays the same spent ticket — cannot work, so a dropped
   * stream is re-opened here with a fresh one.
   */
  private async listen(): Promise<void> {
    if (this.stream || this.streaming || this.closed) return;
    const openStream = this.options.openStream ?? defaultStream;
    if (!openStream) return;
    this.streaming = true;
    try {
      const issued = (await this.send('cancore_streamTicket', undefined)) as { ticket?: unknown };
      if (typeof issued?.ticket !== 'string') return;
      const url = `${this.session!.rpcUrl}/events?token=${encodeURIComponent(issued.ticket)}`;
      const stream = openStream(url);
      for (const name of STREAM_EVENTS) {
        stream.addEventListener(name, (event) => this.emit(name, parseFrame(event.data)));
      }
      stream.addEventListener('error', () => this.reopen());
      this.stream = stream;
    } finally {
      this.streaming = false;
    }
  }

  private reopen(): void {
    if (this.closed) return;
    this.stream?.close();
    this.stream = null;
    const schedule = this.options.schedule ?? setTimeout;
    schedule(() => {
      void this.listen();
    }, STREAM_RETRY_MS);
  }
}

function defaultStream(url: string): StreamLike {
  const Source = (globalThis as { EventSource?: new (url: string) => StreamLike }).EventSource;
  if (!Source) throw rpcError(RpcCode.INTERNAL, 'This runtime has no EventSource');
  return new Source(url);
}

/** A frame that is not JSON is handed over as the string it is, never dropped. */
function parseFrame(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/** The whole point: the code the wallet sent, where EIP-1193 says it goes. */
function readRpcError(body: {
  error?: { code?: unknown; message?: unknown; data?: unknown };
} | null): ProviderRpcError | null {
  const error = body?.error;
  if (!error || typeof error.code !== 'number') return null;
  const message = typeof error.message === 'string' ? error.message : 'The wallet refused the request';
  return rpcError(error.code, message, error.data);
}
