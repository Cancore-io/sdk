/**
 * One logical WebSocket session to filler-gateway `/v1` (protocol §3.1, §3.5
 * «Session»): connect, log in by challenge, keep the heartbeat, reconnect with
 * exponential backoff and jitter. Every frame is verified (`frames.ts`) before
 * anything reads it; `auth.*`, `ping` and `pong` stay here, everything else
 * goes to the listener.
 *
 * Before `auth.ok` the session sends nothing but `auth.response`, and `send`
 * refuses every frame (the caller falls back to REST or drops it).
 */
import { FILLER_AUTH_TYPES, FILLER_PROTOCOL_DOMAIN, PROTOCOL_VERSION, type AuthResponse, type F2SMessage, type Hex } from '@cancore/contracts';
import { GatewayError, UnsupportedVersionError } from '../errors';
import type { Cancel, Clock, FillerSocket, Logger, WebSocketFactory } from '../runtime';
import { signTypedDataChecked, type QuoteSigner } from '../signer';
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

export type SessionState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'waiting' | 'stopped' | 'failed';

export interface SessionListener {
  /** `auth.ok` arrived: the session is ready to send. */
  onReady(info: { heartbeatIntervalMs: number }): void;
  /** A ready session was lost; a reconnect is scheduled. */
  onDisconnected(info: { code: number; reason: string }): void;
  /** Every verified frame after `auth.ok` other than `auth.*`, `ping` and `pong` — `error` included. */
  onFrame(verified: VerifiedFrame): void;
  /** The session stopped for good (`UNSUPPORTED_VERSION`); no reconnect follows. */
  onFatal(error: GatewayError): void;
}

export interface SessionOptions {
  /** `wss://<filler-gateway host>/v1`. */
  url: string;
  fillerId: string;
  gatewaySigner: Hex;
  quoteSigner: QuoteSigner;
  /** Seals every frame the session sends itself (`auth.response`, `ping`, `pong`) with the message key. */
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
  /** How long a connection may take to reach `auth.ok`. Default 15 s. */
  loginTimeoutMs: number;
}

const PRE_AUTH_TYPES: ReadonlySet<string> = new Set(['auth.challenge', 'auth.ok', 'error']);

export class GatewaySession {
  private current: SessionState = 'idle';
  private socket: FillerSocket | undefined;
  /** Bumped on every connection; callbacks of an older connection are ignored. */
  private generation = 0;
  private attempt = 0;
  private lastInboundMs = 0;
  private heartbeatIntervalMs = 0;
  private timers: Cancel[] = [];

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
      return true;
    } catch (error) {
      this.options.logger.warn('filler-gateway: send failed', { type: frame.type, error: String(error) });
      return false;
    }
  }

  // -------------------------------------------------------------------------

  private connect(): void {
    const generation = ++this.generation;
    this.current = 'connecting';
    this.clearTimers();
    const live = () => generation === this.generation;
    try {
      this.socket = this.options.webSocket(this.options.url, {
        onOpen: () => live() && this.onOpen(),
        onMessage: (text) => live() && this.onMessage(text, generation),
        onClose: (code, reason) => live() && this.onClose(code, reason),
        onError: (error) => live() && this.onError(error),
      });
    } catch (error) {
      this.options.logger.warn('filler-gateway: connect failed', { error: String(error) });
      this.socket = undefined;
      this.scheduleReconnect();
      return;
    }
    this.timers.push(
      this.options.clock.schedule(this.options.loginTimeoutMs, () => {
        if (live() && this.current !== 'ready') {
          this.options.logger.warn('filler-gateway: no auth.ok in time, reconnecting', { timeoutMs: this.options.loginTimeoutMs });
          this.closeSocket(CLOSE_LOGIN_TIMEOUT, 'login timeout');
        }
      }),
    );
  }

  private onOpen(): void {
    if (this.current === 'connecting') this.current = 'authenticating';
    this.lastInboundMs = this.options.clock.now();
  }

  private onMessage(text: string, generation: number): void {
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
      if (frame.type === 'auth.challenge') void this.answerChallenge(frame, generation);
      else if (frame.type === 'auth.ok') this.onAuthOk(frame);
      else this.handleGatewayError(check.verified, 'login');
      return;
    }

    switch (frame.type) {
      case 'ping':
        if (typeof frame.id === 'string') void this.sealAndSend({ type: 'pong', id: this.options.nextId(), re: frame.id });
        return;
      case 'pong':
      case 'auth.challenge':
      case 'auth.ok':
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
      this.options.logger.error('filler-gateway: protocol version not served; not reconnecting', { code: error.code, message: error.message });
      this.current = 'failed';
      this.closeSocket(CLOSE_UNSUPPORTED_VERSION, 'UNSUPPORTED_VERSION');
      this.listener.onFatal(error);
      return true;
    }
    if (phase === 'login') {
      // filler-gateway closes the socket after a failed login; the close schedules the retry.
      this.options.logger.error('filler-gateway: login refused', { code: error.code, message: error.message });
    }
    return false;
  }

  private async answerChallenge(frame: VerifiedFrame['frame'], generation: number): Promise<void> {
    const { nonce, expiresAt } = frame;
    if (typeof nonce !== 'string' || typeof expiresAt !== 'string' || !/^(0|[1-9][0-9]*)$/.test(expiresAt)) {
      this.options.logger.warn('filler-gateway: malformed auth.challenge dropped');
      return;
    }
    if (Number(expiresAt) * 1000 <= this.options.clock.now()) {
      this.options.logger.warn('filler-gateway: auth.challenge already expired; waiting for the login timeout', { expiresAt });
      return;
    }
    let sig: Hex;
    try {
      sig = await signTypedDataChecked(this.options.quoteSigner, {
        domain: FILLER_PROTOCOL_DOMAIN,
        types: FILLER_AUTH_TYPES,
        primaryType: 'FillerAuth',
        message: { fillerId: this.options.fillerId, nonce, expiresAt },
      });
    } catch (error) {
      this.options.logger.error('filler-gateway: quote signer failed on FillerAuth', { error: String(error) });
      if (generation === this.generation) this.closeSocket(CLOSE_NORMAL, 'signer failed');
      return;
    }
    let response: AuthResponse;
    try {
      response = await this.options.seal<AuthResponse>({
        type: 'auth.response',
        id: this.options.nextId(),
        keyAddress: this.options.quoteSigner.address.toLowerCase() as Hex,
        protocolVersion: PROTOCOL_VERSION,
        sig,
      });
    } catch (error) {
      this.options.logger.error('filler-gateway: message key failed on the auth.response envelope', { error: String(error) });
      if (generation === this.generation) this.closeSocket(CLOSE_NORMAL, 'signer failed');
      return;
    }
    if (generation !== this.generation || this.current !== 'authenticating') return;
    this.socket?.send(JSON.stringify(response));
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
    if (wasReady) this.listener.onDisconnected({ code, reason });
    this.scheduleReconnect();
  }

  private onError(error: unknown): void {
    // The adapter reports the close next; closing here covers an adapter that does not.
    this.options.logger.warn('filler-gateway: socket error', { error: String(error) });
    this.closeSocket(1006, 'socket error');
  }

  private scheduleReconnect(): void {
    if (this.current === 'stopped' || this.current === 'failed') return;
    this.current = 'waiting';
    const delayMs = backoffDelay(this.attempt++, this.options.reconnect, this.options.random);
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
