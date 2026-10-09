/**
 * Test doubles for the injected interfaces: a clock you advance by hand, an
 * EVM RPC you script, a WebSocket factory whose sockets you feed crafted
 * frames (sdk.md S15: the SDK's reaction to a wrong filler-gateway is tested
 * by feeding frames, with no test server), a signer over a test key, and
 * sinks that record what the SDK logged and emitted.
 */
import { FILLER_WS_BEARER_PREFIX, FILLER_WS_SUBPROTOCOL, hashTypedData, type Hex, type TypedDataInput } from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { FillerEvent, EventSink } from '../events';
import type { EvmRpc, EvmRpcRequest } from '../rpc';
import { gatewayMessageDigest } from '../protocol/frames';
import type { Cancel, Clock, FillerSocket, FillerSocketHandlers, HttpFetch, HttpRequest, LogFields, Logger, WebSocketFactory } from '../runtime';
import { addressOfPublicKey, type TypedDataSigner } from '../signer';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** A clock that moves only when told to. Scheduled callbacks run, in time order, inside `advance`. */
export class FakeClock implements Clock {
  private current: number;
  private sequence = 0;
  private timers: Array<{ at: number; seq: number; callback: () => void }> = [];

  constructor(startMs = 1_790_000_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  schedule(delayMs: number, callback: () => void): Cancel {
    const timer = { at: this.current + Math.max(0, delayMs), seq: this.sequence++, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** Moves time forward by `ms`, running every callback that falls due, including ones scheduled meanwhile. */
  advance(ms: number): void {
    const until = this.current + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = due.at;
      due.callback();
    }
    this.current = until;
  }

  /** Callbacks scheduled and not yet run. */
  get pending(): number {
    return this.timers.length;
  }
}

// ---------------------------------------------------------------------------
// EVM RPC
// ---------------------------------------------------------------------------

export type RpcHandler = (params: readonly unknown[]) => unknown;

/** An `EvmRpc` answering from per-method handlers; an unscripted method rejects. Every call is recorded. */
export class FakeEvmRpc implements EvmRpc {
  readonly calls: EvmRpcRequest[] = [];
  private readonly handlers = new Map<string, RpcHandler>();

  constructor(readonly label = 'fake') {}

  /** Answers `method` with `result`, or with what `result(params)` returns or throws. */
  on(method: string, result: RpcHandler | unknown): this {
    this.handlers.set(method, typeof result === 'function' ? (result as RpcHandler) : () => result);
    return this;
  }

  /** Makes `method` reject with `error`. */
  fail(method: string, error: unknown): this {
    this.handlers.set(method, () => {
      throw error;
    });
    return this;
  }

  async request<T = unknown>(request: EvmRpcRequest): Promise<T> {
    this.calls.push({ method: request.method, params: [...(request.params ?? [])] });
    const handler = this.handlers.get(request.method);
    if (!handler) throw new Error(`FakeEvmRpc(${this.label}): no handler for ${request.method}`);
    return (await handler(request.params ?? [])) as T;
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/**
 * One fake connection. The test plays filler-gateway: `open()` (or `refuse()`
 * the upgrade), then `receive(frame)` — `auth.ok` first, as filler-gateway does.
 */
export class FakeSocket implements FillerSocket {
  /** Frames the SDK sent, as text. */
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;

  constructor(
    readonly url: string,
    private readonly handlers: FillerSocketHandlers,
    /** The subprotocols the SDK offered on the upgrade. */
    readonly protocols: readonly string[] = [],
  ) {}

  /** The bearer token offered on the upgrade (`bearer.<token>`), when exactly one was offered next to `cancore-filler.v1`. */
  get token(): string | undefined {
    const bearers = this.protocols.filter((p) => p.startsWith(FILLER_WS_BEARER_PREFIX));
    if (!this.protocols.includes(FILLER_WS_SUBPROTOCOL) || bearers.length !== 1) return undefined;
    return bearers[0]!.slice(FILLER_WS_BEARER_PREFIX.length);
  }

  /** filler-gateway refuses the upgrade with a plain HTTP `status`: an error, then a close, and never an open. */
  refuse(status: number): void {
    if (this.closed) throw new Error('FakeSocket: refuse after close');
    this.handlers.onError(new Error(`Unexpected server response: ${status}`));
    this.close(1006, '');
  }

  send(text: string): void {
    if (this.closed) throw new Error('FakeSocket: send after close');
    this.sent.push(text);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.handlers.onClose(code, reason);
  }

  /** The SDK's sent frames, parsed. */
  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  open(): void {
    this.handlers.onOpen();
  }

  /** Delivers one frame; an object is serialised, a string is delivered byte for byte. */
  receive(frame: string | object): void {
    if (this.closed) throw new Error('FakeSocket: receive after close');
    this.handlers.onMessage(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** The server or the network drops the connection. */
  drop(code = 1006, reason = 'dropped'): void {
    this.close(code, reason);
  }

  error(error: unknown): void {
    this.handlers.onError(error);
  }
}

/** A `WebSocketFactory` that hands out `FakeSocket`s; `sockets` lists every connection in order. */
export function createFakeWebSocketFactory(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url, handlers, protocols) => {
    const socket = new FakeSocket(url, handlers, [...protocols]);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------

/**
 * A `TypedDataSigner` over a private key the test supplies — the reference
 * behaviour of the contract: 65 bytes, low-s, `v ∈ {27, 28}`. Test keys only;
 * a filler node builds its signers from `.env`.
 */
export function createTestTypedDataSigner(privateKey: Hex): TypedDataSigner {
  const key = hexToBytes(privateKey.slice(2));
  const address = addressOfPublicKey(secp256k1.getPublicKey(key, false));
  return {
    address,
    async signTypedData(input: TypedDataInput): Promise<Hex> {
      const signature = secp256k1.sign(hexToBytes(hashTypedData(input).slice(2)), key, { lowS: true });
      return `0x${bytesToHex(signature.toCompactRawBytes())}${(27 + signature.recovery).toString(16)}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Logger and events
// ---------------------------------------------------------------------------

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: LogFields;
}

/** A `Logger` that keeps every entry in `entries`. */
export function createRecordingLogger(): Logger & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at = (level: LogEntry['level']) => (message: string, fields?: LogFields) => {
    entries.push(fields === undefined ? { level, message } : { level, message, fields });
  };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** An `EventSink` that keeps every event in `events`. */
export function createRecordingEventSink(): EventSink & { readonly events: FillerEvent[] } {
  const events: FillerEvent[] = [];
  return { events, emit: (event) => void events.push(event) };
}

// ---------------------------------------------------------------------------
// filler-gateway frames
// ---------------------------------------------------------------------------

/** A crafted filler-gateway → filler frame body: `type` plus whatever fields the test wants. */
export type FrameBody = { type: string } & Record<string, unknown>;

/**
 * Signs crafted filler-gateway → filler frames with a test key, the way
 * filler-gateway does (`GatewayMessage{keccak256(JCS(frame without sig))}` in
 * the protocol domain). Feed the result to `FakeSocket.receive` or serve it
 * from a fake `HttpFetch` (sdk.md S15). Test keys only.
 */
export interface TestGatewaySigner {
  readonly address: Hex;
  /** `body` with `sentAt` (unless given) and `sig` added. */
  frame<T extends FrameBody>(body: T): T & { sentAt: number; sig: Hex };
  /** Signs `body` exactly as given (no `sentAt` added); any `sig` in it is replaced. */
  sign<T extends FrameBody>(body: T): T & { sig: Hex };
}

export function createTestGatewaySigner(privateKey: Hex, clock: Clock = { now: () => 1_790_000_000_000, schedule: () => () => undefined }): TestGatewaySigner {
  const key = hexToBytes(privateKey.slice(2));
  const address = addressOfPublicKey(secp256k1.getPublicKey(key, false));
  const sign = <T extends FrameBody>(body: T): T & { sig: Hex } => {
    const { sig: _sig, ...unsigned } = body;
    const digest = gatewayMessageDigest(unsigned);
    const signature = secp256k1.sign(hexToBytes(digest.slice(2)), key, { lowS: true });
    const sig: Hex = `0x${bytesToHex(signature.toCompactRawBytes())}${(27 + signature.recovery).toString(16)}`;
    return { ...(unsigned as T), sig };
  };
  return {
    address,
    sign,
    frame: <T extends FrameBody>(body: T) => sign({ sentAt: clock.now(), ...body }) as unknown as T & { sentAt: number; sig: Hex },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface RecordedRequest extends HttpRequest {
  url: string;
}

/** A route's answer; `headers` are served lower-cased (`Retry-After` → `retry-after`). */
export interface FakeAnswer {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

export type FakeRoute = (request: RecordedRequest) => FakeAnswer | Promise<FakeAnswer>;

/**
 * An `HttpFetch` answering from routes keyed `"METHOD /path"` (query string
 * ignored for matching); an unrouted request answers 404. Every request is
 * recorded in `requests`. A route's `body` is serialised with `JSON.stringify`
 * unless it is already a string.
 */
export function createFakeFetch(routes: Record<string, FakeRoute> = {}): { fetch: HttpFetch; requests: RecordedRequest[]; routes: Record<string, FakeRoute> } {
  const requests: RecordedRequest[] = [];
  const fetch: HttpFetch = async (url, request) => {
    const recorded: RecordedRequest = { url, ...request };
    requests.push(recorded);
    const { pathname } = new URL(url);
    const route = routes[`${request.method} ${pathname}`];
    const answer: FakeAnswer = route ? await route(recorded) : { status: 404, body: { type: 'error', code: 'NOT_FOUND', message: `no route ${pathname}` } };
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    const headers = new Map(Object.entries(answer.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    return { status: answer.status, headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null }, text: async () => text };
  };
  return { fetch, requests, routes };
}

// ---------------------------------------------------------------------------
// filler-gateway login
// ---------------------------------------------------------------------------

export interface FakeGatewayLoginOptions {
  fillerId: string;
  clock: Clock;
  /** Lifetime of an issued token. Default one hour. */
  tokenTtlMs?: number;
  /** `heartbeatIntervalMs` of the `auth.ok` that `accept` sends. Default 60 s. */
  heartbeatIntervalMs?: number;
}

/**
 * filler-gateway's login, for a test: the REST routes `GET
 * /v1/filler/auth/challenge?fillerId=` (a signed challenge addressed to that
 * fillerId; 400 unsigned without one) and `POST /v1/filler/auth` (a fresh token
 * per login, `tok-1`, `tok-2`, …), and `accept(socket)`, which holds an upgrade
 * to the rules — `cancore-filler.v1` plus exactly one `bearer.<token>` of a
 * live issued token — then opens it and sends the signed `auth.ok` first; any
 * other upgrade is refused (400 or 401). Spread `routes` into
 * `createFakeFetch`. It checks no signature of the filler: the SDK's login is
 * tested on its own.
 */
export function createFakeGatewayLogin(gateway: TestGatewaySigner, options: FakeGatewayLoginOptions) {
  const ttlMs = options.tokenTtlMs ?? 3_600_000;
  /** Every token issued, with its expiry; `revoke` deletes one. */
  const tokens = new Map<string, number>();
  let challenges = 0;
  const routes: Record<string, FakeRoute> = {
    'GET /v1/filler/auth/challenge': (request) => {
      const fillerId = new URL(request.url).searchParams.get('fillerId');
      if (!fillerId) return { status: 400, body: { type: 'error', code: 'BAD_REQUEST', message: 'fillerId is required' } };
      challenges++;
      return {
        status: 200,
        body: gateway.frame({ type: 'auth.challenge', id: `g-challenge-${challenges}`, fillerId, nonce: `0x${challenges.toString(16).padStart(64, '0')}`, expiresAt: String(Math.floor(options.clock.now() / 1000) + 30) }),
      };
    },
    'POST /v1/filler/auth': () => {
      const token = `tok-${tokens.size + 1}`;
      const expiresAt = options.clock.now() + ttlMs;
      tokens.set(token, expiresAt);
      return { status: 200, body: { token, expiresAt } };
    },
  };
  const accept = (socket: FakeSocket): boolean => {
    const token = socket.token;
    if (token === undefined) {
      socket.refuse(400);
      return false;
    }
    const expiresAt = tokens.get(token);
    if (expiresAt === undefined || expiresAt <= options.clock.now()) {
      socket.refuse(401);
      return false;
    }
    socket.open();
    socket.receive(gateway.frame({ type: 'auth.ok', id: `g-ok-${token}`, fillerId: options.fillerId, heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000 }));
    return true;
  };
  return {
    routes,
    accept,
    /** Tokens issued so far, in order. */
    issued: (): string[] => [...tokens.keys()],
    /** Challenges handed out so far. */
    challenges: (): number => challenges,
    /** filler-gateway forgets a token (expired early, key changed): the next upgrade with it is refused 401. */
    revoke: (token: string): void => void tokens.set(token, 0),
  };
}
