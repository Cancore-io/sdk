/**
 * One logical WebSocket session to filler-gateway `/v1` (protocol §3.1, §3.5
 * «Session»): connect only after login, keep the heartbeat, reconnect with
 * exponential backoff and jitter. Every frame is verified (`frames.ts`) before
 * anything reads it; `auth.ok`, `ping` and `pong` stay here, everything else
 * goes to the listener.
 *
 * Each connect first takes a valid bearer token from the REST login (shared
 * with the REST side, renewed before it expires) and offers it on the upgrade
 * as the subprotocols `cancore-filler.v1` + `bearer.<token>`; a failed login
 * is retried with backoff. filler-gateway authenticates the upgrade itself and
 * sends `auth.ok` first. Until `auth.ok` the session sends nothing and `send`
 * refuses every frame (the caller falls back to REST or drops it). A close
 * before `auth.ok` — a refused upgrade shows up as an error and a close before
 * the open — drops the token, so the next attempt logs in again. The token is
 * never logged.
 */
import { FILLER_CLOSE_CODES, fillerWsProtocols, type AuthToken, type F2SMessage, type Hex } from '@cancore/contracts';
import { GatewayError, UnsupportedVersionError } from '../errors';
import type { Cancel, Clock, FillerSocket, Logger, WebSocketFactory } from '../runtime';
import type { Sealer, Unsealed } from './envelope';
import { gatewayErrorOf, verifyGatewayText, type VerifiedFrame } from './frames';

/** WebSocket close codes the SDK uses. */
export const CLOSE_NORMAL = 1000;
/** The peer went silent for `heartbeatMisses` intervals. */
export const CLOSE_HEARTBEAT = 4000;
/** No `auth.ok` within `loginTimeoutMs`. */
export const CLOSE_LOGIN_TIMEOUT = 4001;
/** The protocol version is not served; not retried. */
export const CLOSE_UNSUPPORTED_VERSION = 4002;

export interface ReconnectPolicy {
  /** First retry delay before jitter. Default 500 ms. */
  initialDelayMs: number;
  /** Ceiling of the delay before jitter. Default 30 s. */
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT: ReconnectPolicy = { initialDelayMs: 500, maxDelayMs: 30_000 };
export const DEFAULT_HEARTBEAT_MISSES = 3;
export const DEFAULT_LOGIN_TIMEOUT_MS = 15_000;

/**
 * Delay before reconnect number `attempt` (0-based): `min(max, initial × 2^attempt)`,
 * scaled by a jitter factor in [0.5, 1) — "equal jitter", so replicas that lost
 * one connection together do not come back together, and no retry is instant.
 */
export function backoffDelay(attempt: number, policy: ReconnectPolicy, random: () => number): number {
  const cap = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.min(attempt, 30));
  return Math.floor(cap * (0.5 + 0.5 * Math.min(Math.max(random(), 0), 0.999_999)));
}

/**
 * `connecting`: logging in over REST and opening the socket; `authenticating`:
 * open, waiting for `auth.ok`; `waiting`: a reconnect is scheduled.
 */
export type SessionState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'waiting' | 'stopped' | 'failed';

/** Where the session takes its bearer token from: the REST login (`GatewayRest`). */
export interface TokenSource {
  /** A token valid for at least the renewal margin; logs in (once for every caller) when there is none. */
  validToken(): Promise<AuthToken>;
  /** Forgets `token` when it is the one held; the next `validToken()` logs in again. */
  dropToken(token: string): void;
  /** Stops sharing a login that hangs, so the next `validToken()` starts a new one. */
  abandonLogin(): void;
}

export interface SessionListener {
  /** `auth.ok` arrived: the session is ready to send. */
  onReady(info: { heartbeatIntervalMs: number }): void;
  /** A ready session was lost; a reconnect is scheduled. */
  onDisconnected(info: { code: number; reason: string }): void;
  /** Every verified frame after `auth.ok` other than `auth.*`, `ping` and `pong` — `error` included. */
  onFrame(verified: VerifiedFrame): void;
  /** The session stopped for good (`UNSUPPORTED_VERSION`, on the socket or from the login); no reconnect follows. */
  onFatal(error: GatewayError): void;
}

export interface SessionOptions {
  /** `wss://<filler-gateway host>/v1`. */
  url: string;
  fillerId: string;
  gatewaySigner: Hex;
  /** The bearer token of every connect. */
  tokens: TokenSource;
  /** Seals every frame the session sends itself (`ping`, `pong`) with the message key. */
  seal: Sealer;
  webSocket: WebSocketFactory;
  clock: Clock;
  logger: Logger;
  /** `[0, 1)`; the jitter source. */
  random: () => number;
  /** Frame ids, unique across this filler's sessions (protocol §3.1). */
  nextId: () => string;
  reconnect: ReconnectPolicy;
  /** Missed heartbeat intervals before the session is closed and reopened. Default 3. */
  heartbeatMisses: number;
  /** How long a connect — the REST login and the socket — may take to reach `auth.ok`. Default 15 s. */
  loginTimeoutMs: number;
}

/** What may arrive before `auth.ok`: `auth.ok` itself, and an `error` before filler-gateway closes. */
const PRE_AUTH_TYPES: ReadonlySet<string> = new Set(['auth.ok', 'error']);
/** Closes after which the token no longer works: a new login follows. */
const TOKEN_DEAD_CLOSES: ReadonlySet<number> = new Set([FILLER_CLOSE_CODES.KEY_CHANGED, FILLER_CLOSE_CODES.NOT_ACTIVE]);
/** Sent frame ids remembered to name the frame a `RATE_LIMITED` refuses (`re`). */
const SENT_TYPES_KEPT = 256;

export class GatewaySession {
  private current: SessionState = 'idle';
  private socket: FillerSocket | undefined;
  /** Bumped on every connection; callbacks of an older connection are ignored. */
  private generation = 0;
  private attempt = 0;
  private lastInboundMs = 0;
  private heartbeatIntervalMs = 0;
  private timers: Cancel[] = [];
  /** The token offered on the current connection; dropped when it closes before `auth.ok`. */
  private offeredToken: string | undefined;
  /** End of the last rate-limit wait filler-gateway named (`error RATE_LIMITED.retryAfterMs`), unix ms. */
  private rateLimitedUntilMs = 0;
  private readonly sentTypes = new Map<string, string>();

  constructor(
    private readonly options: SessionOptions,
    private readonly listener: SessionListener,
  ) {}

  get state(): SessionState {
    return this.current;
  }

  get ready(): boolean {
    return this.current === 'ready';
  }

  /** Opens the first connection. Calling it again does nothing. */
  start(): void {
    if (this.current !== 'idle') return;
    this.connect();
  }

  /** Closes the connection and cancels every timer; no reconnect follows. Idempotent. */
  stop(): void {
    if (this.current === 'stopped' || this.current === 'failed') return;
    this.current = 'stopped';
    this.closeSocket(CLOSE_NORMAL, 'filler stopping');
  }

  /**
   * Sends one sealed filler → filler-gateway frame on the ready session. Returns
   * false — and sends nothing — before `auth.ok`, while reconnecting and after `stop()`.
   */
  send(frame: F2SMessage): boolean {
    if (this.current !== 'ready' || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.options.logger.warn('filler-gateway: send failed', { type: frame.type, error: this.redact(error) });
      return false;
    }
    this.sentTypes.set(frame.id, frame.type);
    if (this.sentTypes.size > SENT_TYPES_KEPT) this.sentTypes.delete(this.sentTypes.keys().next().value!);
    return true;
  }

  /** The type of a recently sent frame by its `id` (what an `error.re` names), if it is remembered. */
  sentType(id: string): string | undefined {
    return this.sentTypes.get(id);
  }

  // -------------------------------------------------------------------------

  /** Takes a valid token from the REST login, then opens the socket with it. */
  private connect(): void {
    const generation = ++this.generation;
    this.current = 'connecting';
    this.clearTimers();
    this.offeredToken = undefined;
    const connecting = () => generation === this.generation && this.current === 'connecting';
    this.timers.push(
      this.options.clock.schedule(this.options.loginTimeoutMs, () => {
        if (generation !== this.generation || this.current === 'ready') return;
        this.options.logger.warn('filler-gateway: no auth.ok in time, reconnecting', { timeoutMs: this.options.loginTimeoutMs });
        if (this.socket) this.closeSocket(CLOSE_LOGIN_TIMEOUT, 'login timeout');
        else if (this.current === 'connecting') {
          // The REST login hangs: the next connect must not wait on it again.
          this.options.tokens.abandonLogin();
          this.scheduleReconnect();
        }
      }),
    );
    this.options.tokens.validToken().then(
      (token) => {
        if (connecting()) this.open(token, generation);
      },
      (error: unknown) => {
        if (connecting()) this.loginFailed(error);
      },
    );
  }

  private loginFailed(error: unknown): void {
    if (error instanceof UnsupportedVersionError) {
      this.fail(error);
      return;
    }
    const retryAfterMs = error instanceof GatewayError ? error.retryAfterMs : undefined;
    this.options.logger.warn('filler-gateway: login failed, retrying', { error: this.redact(error), retryAfterMs });
    this.scheduleReconnect(retryAfterMs);
  }

  private open(token: AuthToken, generation: number): void {
    const live = () => generation === this.generation;
    this.offeredToken = token.token;
    try {
      this.socket = this.options.webSocket(
        this.options.url,
        {
          onOpen: () => live() && this.onOpen(),
          onMessage: (text) => live() && this.onMessage(text),
          onClose: (code, reason) => live() && this.onClose(code, reason),
          onError: (error) => live() && this.onError(error),
        },
        fillerWsProtocols(token.token),
      );
    } catch (error) {
      // Possibly the token itself (a browser refuses a subprotocol it cannot send): log in afresh next time.
      this.options.logger.warn('filler-gateway: connect failed', { error: this.redact(error) });
      this.socket = undefined;
      this.forgetOfferedToken();
      this.scheduleReconnect();
    }
  }

  private onOpen(): void {
    if (this.current === 'connecting') this.current = 'authenticating';
    this.lastInboundMs = this.options.clock.now();
  }

  private onMessage(text: string): void {
    const check = verifyGatewayText(text, { gatewaySigner: this.options.gatewaySigner, fillerId: this.options.fillerId });
    if (!check.ok) {
      this.options.logger.warn('filler-gateway: frame dropped', { reason: check.reason, type: check.type });
      return;
    }
    const { frame } = check.verified;
    this.lastInboundMs = this.options.clock.now();

    if (this.current !== 'ready') {
      if (!PRE_AUTH_TYPES.has(frame.type)) {
        this.options.logger.warn('filler-gateway: frame before auth.ok dropped', { type: frame.type });
        return;
      }
      if (frame.type === 'auth.ok') this.onAuthOk(frame);
      else this.handleGatewayError(check.verified, 'login');
      return;
    }

    switch (frame.type) {
      case 'ping':
        if (typeof frame.id === 'string') void this.sealAndSend({ type: 'pong', id: this.options.nextId(), re: frame.id });
        return;
      case 'pong':
      case 'auth.ok':
      // never sent on the socket (the login is REST only); not evidence of anything
      case 'auth.challenge':
        return;
      case 'error':
        if (this.handleGatewayError(check.verified, 'session')) return;
        this.listener.onFrame(check.verified);
        return;
      default:
        this.listener.onFrame(check.verified);
    }
  }

  /** Returns true when the error ended the session for good. */
  private handleGatewayError(verified: VerifiedFrame, phase: 'login' | 'session'): boolean {
    const error = gatewayErrorOf(verified.frame);
    if (error instanceof UnsupportedVersionError) {
      this.fail(error);
      return true;
    }
    if (error.code === 'RATE_LIMITED' && error.retryAfterMs !== undefined) {
      // Kept for a 4029 close that may follow: the reconnect waits at least this long.
      this.rateLimitedUntilMs = Math.max(this.rateLimitedUntilMs, this.options.clock.now() + error.retryAfterMs);
    }
    if (phase === 'login') {
      // filler-gateway closes the socket next; the close schedules the retry.
      this.options.logger.error('filler-gateway: refused before auth.ok', { code: error.code, message: error.message });
    }
    return false;
  }

  /** `UNSUPPORTED_VERSION`: no reconnect can help until the SDK is upgraded. */
  private fail(error: GatewayError): void {
    this.options.logger.error('filler-gateway: protocol version not served; not reconnecting', { code: error.code, message: error.message });
    this.current = 'failed';
    this.closeSocket(CLOSE_UNSUPPORTED_VERSION, 'UNSUPPORTED_VERSION');
    this.listener.onFatal(error);
  }

  /** Seals a frame of the session's own (`ping`, `pong`) and sends it if the session is still ready. */
  private async sealAndSend(message: Unsealed): Promise<void> {
    let sealed: F2SMessage;
    try {
      sealed = await this.options.seal(message);
    } catch (error) {
      this.options.logger.warn('filler-gateway: message key failed on an envelope', { type: message.type, error: String(error) });
      return;
    }
    this.send(sealed);
  }

  private onAuthOk(frame: VerifiedFrame['frame']): void {
    const interval = frame.heartbeatIntervalMs;
    if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval <= 0) {
      this.options.logger.warn('filler-gateway: auth.ok without a usable heartbeatIntervalMs dropped');
      return;
    }
    this.clearTimers();
    this.current = 'ready';
    this.attempt = 0;
    this.heartbeatIntervalMs = interval;
    this.lastInboundMs = this.options.clock.now();
    this.scheduleHeartbeat(this.generation);
    this.listener.onReady({ heartbeatIntervalMs: interval });
  }

  /**
   * Every interval: if nothing arrived from filler-gateway for
   * `heartbeatMisses` intervals, close and reconnect; otherwise send a `ping`
   * (sealed like every filler → filler-gateway frame). filler-gateway pings too, and
   * any frame it sends counts as alive.
   */
  private scheduleHeartbeat(generation: number): void {
    this.timers.push(
      this.options.clock.schedule(this.heartbeatIntervalMs, () => {
        if (generation !== this.generation || this.current !== 'ready') return;
        const silentMs = this.options.clock.now() - this.lastInboundMs;
        if (silentMs >= this.heartbeatIntervalMs * this.options.heartbeatMisses) {
          this.options.logger.warn('filler-gateway: heartbeat missed, reconnecting', { silentMs, misses: this.options.heartbeatMisses });
          this.closeSocket(CLOSE_HEARTBEAT, 'heartbeat missed');
          return;
        }
        void this.sealAndSend({ type: 'ping', id: this.options.nextId() });
        this.scheduleHeartbeat(generation);
      }),
    );
  }

  private onClose(code: number, reason: string): void {
    const wasReady = this.current === 'ready';
    this.socket = undefined;
    this.clearTimers();
    if (this.current === 'stopped' || this.current === 'failed') return;
    this.options.logger.info('filler-gateway: connection closed', { code, reason });
    // Refused upgrade, or no auth.ok: the token may be what failed. A key change or a suspension kills it for sure.
    if (!wasReady || TOKEN_DEAD_CLOSES.has(code)) this.forgetOfferedToken();
    this.offeredToken = undefined;
    if (wasReady) this.listener.onDisconnected({ code, reason });
    let floorMs = 0;
    if (code === FILLER_CLOSE_CODES.RATE_LIMITED) {
      floorMs = Math.max(0, this.rateLimitedUntilMs - this.options.clock.now());
      this.options.logger.warn('filler-gateway: closed for sustained rate-limit excess; reconnecting after the cooldown', { retryAfterMs: floorMs });
    }
    this.scheduleReconnect(floorMs);
  }

  private onError(error: unknown): void {
    // The adapter reports the close next; closing here covers an adapter that does not.
    this.options.logger.warn('filler-gateway: socket error', { error: this.redact(error) });
    this.closeSocket(1006, 'socket error');
  }

  private forgetOfferedToken(): void {
    if (this.offeredToken !== undefined) this.options.tokens.dropToken(this.offeredToken);
    this.offeredToken = undefined;
  }

  /** An error as text for the log, with the bearer token cut out should an adapter have put it in. */
  private redact(error: unknown): string {
    const text = String(error);
    const token = this.offeredToken;
    return token ? text.split(token).join('<token>') : text;
  }

  /** Reconnects after the backoff delay, and never before `floorMs` (a rate-limit wait). */
  private scheduleReconnect(floorMs = 0): void {
    if (this.current === 'stopped' || this.current === 'failed') return;
    this.current = 'waiting';
    const delayMs = Math.max(backoffDelay(this.attempt++, this.options.reconnect, this.options.random), floorMs);
    const generation = ++this.generation;
    this.timers.push(
      this.options.clock.schedule(delayMs, () => {
        if (generation === this.generation && this.current === 'waiting') this.connect();
      }),
    );
  }

  /** Closes the socket; its `onClose` (synchronous or not) decides what follows. */
  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (!socket) {
      if (this.current === 'stopped' || this.current === 'failed') this.clearTimers();
      return;
    }
    try {
      socket.close(code, reason);
    } catch (error) {
      this.options.logger.warn('filler-gateway: close failed', { error: String(error) });
    }
    if (this.current === 'stopped' || this.current === 'failed') {
      // Ignore whatever the old socket reports from here on.
      this.generation++;
      this.socket = undefined;
      this.clearTimers();
    }
  }

  private clearTimers(): void {
    for (const cancel of this.timers.splice(0)) cancel();
  }
}
