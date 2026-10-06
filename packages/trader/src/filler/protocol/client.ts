/**
 * The transport of filler protocol v1 for one replica: the WebSocket session,
 * the REST fallback, and the handling every verified filler-gateway → filler
 * frame gets before a protocol component (quotes, tickets, settlement) sees it.
 *
 * - **Evidence.** Every verified frame is journalled in the store as the
 *   verbatim bytes it arrived as (protocol §3.4, N-14), under the order lock
 *   when it names an order. `quote.ack` is attached to its quote and
 *   `ticket.intent.ack` to its ticket attempt (T-6); the arrival time of a
 *   `ticket.issued` is written on its attempt (V-T4).
 * - **Dispatch.** Then the frame goes to the handler registered for its type.
 *   A type with no handler is ignored (V-2). A frame can arrive twice — on two
 *   sessions, or over WebSocket and REST (S-16); handlers are idempotent
 *   against the store (T-10).
 * - **Fallback.** While the session is down the client polls
 *   `GET /v1/filler/tickets` and feeds the items through the same path, and
 *   ticket actions go out as `POST /v1/filler/tickets/…`. After every login it
 *   pulls once more, for whatever was sent while it was away.
 */
import type { F2SMessage, Hex, QuoteAck, TicketIntentAck } from '@cancore/contracts';
import { FillerStoppedError, type GatewayError } from '../errors';
import type { EventSink, FillerStage } from '../events';
import type { Clock, Logger } from '../runtime';
import type { EvidenceEntry, FillerStore } from '../store';
import { gatewayErrorOf, type VerifiedFrame } from './frames';
import type { GatewayRest, QuoteListItem, TicketAction } from './rest';
import type { Sealer } from './envelope';
import type { GatewaySession, SessionListener } from './session';

/** Which channel delivered a frame. */
export type FrameChannel = 'ws' | 'rest';

export interface Delivery extends VerifiedFrame {
  readonly channel: FrameChannel;
  /** False when the evidence journal already held these exact bytes: a redelivery. */
  readonly firstSeen: boolean;
}

export type FrameHandler = (delivery: Delivery) => Promise<void>;

export interface ClientOptions {
  store: FillerStore;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  /** How often to poll `GET /v1/filler/tickets` while the session is down. Default 2 s. */
  restPollIntervalMs: number;
  /** Seals a filler → filler-gateway message (`fillerId`, `sentAt`, `msgSig`) before it goes out on either channel. */
  seal: Sealer;
}

export const DEFAULT_REST_POLL_INTERVAL_MS = 2_000;

const isHex32 = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isAttempt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export class FillerProtocolClient implements SessionListener {
  private readonly handlers = new Map<string, FrameHandler>();
  private readonly errorListeners: Array<(error: GatewayError) => void> = [];
  private readonly readyListeners: Array<() => void> = [];
  private session: GatewaySession | undefined;
  private rest: GatewayRest | undefined;
  private started: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private everReady = false;
  private stopped = false;
  private pollTimer: (() => void) | undefined;
  private syncing: Promise<void> | undefined;

  constructor(private readonly options: ClientOptions) {}

  /** Late binding: the session takes the client as its listener. */
  attach(session: GatewaySession, rest: GatewayRest): void {
    this.session = session;
    this.rest = rest;
  }

  /** Registers the one handler of a frame type (a later call replaces it). */
  on(type: string, handler: FrameHandler): void {
    this.handlers.set(type, handler);
  }

  /** Called with every `error` filler-gateway sends after login (logged regardless). */
  onGatewayError(listener: (error: GatewayError) => void): void {
    this.errorListeners.push(listener);
  }

  /** Called after every login (`auth.ok`), the first one included. */
  onLogin(listener: () => void): void {
    this.readyListeners.push(listener);
  }

  /** `GET /v1/filler/quotes?since=`: the quotes filler-gateway holds for this filler, acks verified. */
  listQuotes(sinceMs: number): Promise<QuoteListItem[]> {
    return this.requireRest().listQuotes(sinceMs);
  }

  get connected(): boolean {
    return this.session?.ready ?? false;
  }

  /**
   * Opens the session. Resolves at the first `auth.ok`; rejects with
   * `UnsupportedVersionError` when filler-gateway does not serve v1, and with
   * `FillerStoppedError` when `stop()` comes first. Until the first login the
   * session keeps retrying with backoff.
   */
  start(): Promise<void> {
    const session = this.requireSession();
    return new Promise<void>((resolve, reject) => {
      this.started = { resolve, reject };
      session.start();
    });
  }

  /** Closes the session and stops the REST poll. In-flight work stays in the store. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelPoll();
    this.session?.stop();
    this.settleStart(new FillerStoppedError());
    await this.syncing;
  }

  /** Adds the envelope (`fillerId`, `sentAt`, `msgSig` by the message key) to a message; `send` and `submitTicket` take only sealed ones. */
  get seal(): Sealer {
    return this.options.seal;
  }

  /**
   * Sends a frame with no REST route (`quote`, `quote.reconfirm.reply`,
   * `fill.reported`, `ping`) on the WebSocket session. Returns false when the
   * session is not ready: the frame is dropped, and the caller decides.
   */
  send(frame: F2SMessage): boolean {
    const sent = this.session?.send(frame) ?? false;
    if (!sent) this.options.logger.warn('filler-gateway: session not ready, frame not sent', { type: frame.type });
    return sent;
  }

  /**
   * Sends a ticket action: on the session when it is ready, otherwise as
   * `POST /v1/filler/tickets/{orderHash}/{attempt}/{action}`. The REST answer
   * to an intent (`ticket.intent.ack`) goes through the same handling as a
   * WebSocket frame. Sending the same message again is safe: filler-gateway
   * answers a repeated identical intent with the same ack (§3.5).
   */
  async submitTicket(request: TicketAction): Promise<FrameChannel> {
    if (this.session?.send(request.message)) return 'ws';
    const ack = await this.requireRest().postTicket(request);
    if (ack) await this.ingest(ack, 'rest');
    return 'rest';
  }

  /** Pulls `GET /v1/filler/tickets` (both statuses) and handles every item. One pull at a time. */
  syncTickets(): Promise<void> {
    this.syncing ??= (async () => {
      try {
        for (const status of ['OFFERED', 'ISSUED'] as const) {
          for (const item of await this.requireRest().listTickets(status)) await this.ingest(item, 'rest');
        }
      } catch (error) {
        this.options.logger.warn('filler-gateway REST: ticket pull failed', { error: String(error) });
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  // -- SessionListener -------------------------------------------------------

  onReady(info: { heartbeatIntervalMs: number }): void {
    this.cancelPoll();
    this.stage('authenticated', { heartbeatIntervalMs: info.heartbeatIntervalMs });
    this.everReady = true;
    this.settleStart();
    // Whatever was sent while no session was live.
    void this.syncTickets();
    for (const listener of this.readyListeners) this.safely(listener);
  }

  onDisconnected(info: { code: number; reason: string }): void {
    this.stage('disconnected', { code: info.code, reason: info.reason });
    this.schedulePoll(0);
  }

  onFrame(verified: VerifiedFrame): void {
    void this.ingest(verified, 'ws');
  }

  onFatal(error: GatewayError): void {
    this.cancelPoll();
    this.settleStart(error);
    for (const listener of this.errorListeners) this.safely(() => listener(error));
  }

  // -------------------------------------------------------------------------

  /** Journal, attach acks, dispatch. Never throws: a failure is logged and the frame is lost to this replica. */
  async ingest(verified: VerifiedFrame, channel: FrameChannel): Promise<void> {
    const { frame } = verified;
    try {
      const firstSeen = await this.journal(verified);
      if (frame.type === 'error') {
        const error = gatewayErrorOf(frame);
        this.options.logger.warn('filler-gateway: error', { code: error.code, re: error.re, message: error.message });
        for (const listener of this.errorListeners) this.safely(() => listener(error));
      }
      const handler = this.handlers.get(frame.type);
      if (!handler) {
        if (frame.type !== 'error') this.options.logger.debug('filler-gateway: frame type not handled, ignored', { type: frame.type });
        return;
      }
      await handler({ ...verified, channel, firstSeen });
    } catch (error) {
      this.options.logger.error('filler-gateway: frame handling failed', { type: frame.type, channel, error: String(error) });
    }
  }

  /**
   * Writes the frame to the evidence journal; attaches `quote.ack` to its
   * quote and `ticket.intent.ack` to its ticket attempt in the same order
   * transaction. Returns whether the bytes were new to the journal.
   */
  private async journal(verified: VerifiedFrame): Promise<boolean> {
    const { frame, raw, id } = verified;
    const orderHash = isHex32(frame.orderHash) ? (frame.orderHash.toLowerCase() as Hex) : undefined;
    const attempt = isAttempt(frame.attempt) ? frame.attempt : undefined;
    const entry: EvidenceEntry = {
      id,
      direction: 'from-gateway',
      type: frame.type,
      raw,
      atMs: this.options.clock.now(),
      ...(orderHash !== undefined ? { orderHash } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(typeof frame.requestId === 'string' ? { requestId: frame.requestId } : {}),
    };

    if (orderHash === undefined) {
      const fresh = await this.options.store.appendEvidence(entry);
      if (frame.type === 'quote.ack' && isHex32(frame.quoteHash)) {
        await this.options.store.quotes.recordAck({ ...(frame as unknown as QuoteAck), quoteHash: frame.quoteHash.toLowerCase() as Hex });
      }
      return fresh;
    }

    return this.options.store.withOrder(orderHash, async (tx) => {
      const fresh = await tx.appendEvidence(entry);
      if (frame.type === 'ticket.intent.ack' && attempt !== undefined) {
        const ticket = await tx.getTicket(attempt);
        if (ticket && !ticket.intentAck) {
          await tx.putTicket({
            ...ticket,
            intentAck: frame as unknown as TicketIntentAck,
            state: ticket.state === 'intent-sent' ? 'intent-acked' : ticket.state,
            updatedAtMs: await this.options.store.now(),
          });
        }
      }
      if (frame.type === 'ticket.issued' && attempt !== undefined) {
        // V-T4 measures when the ticket ARRIVED, not when it is checked: recorded at the first receipt, in this transaction.
        const ticket = await tx.getTicket(attempt);
        if (ticket && ticket.issuedAtMs === undefined) {
          await tx.putTicket({ ...ticket, issuedAtMs: this.options.clock.now(), updatedAtMs: await this.options.store.now() });
        }
      }
      return fresh;
    });
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped || this.pollTimer) return;
    this.pollTimer = this.options.clock.schedule(delayMs, () => {
      this.pollTimer = undefined;
      if (this.stopped || this.connected) return;
      void this.syncTickets().then(() => {
        if (!this.connected) this.schedulePoll(this.options.restPollIntervalMs);
      });
    });
  }

  private cancelPoll(): void {
    this.pollTimer?.();
    this.pollTimer = undefined;
  }

  private settleStart(error?: Error): void {
    const started = this.started;
    if (!started) return;
    this.started = undefined;
    if (error) {
      if (!this.everReady) started.reject(error);
    } else started.resolve();
  }

  private stage(stage: FillerStage, detail: Readonly<Record<string, string | number | boolean>>): void {
    this.safely(() => this.options.events.emit({ type: 'stage', stage, atMs: this.options.clock.now(), detail }));
  }

  private safely(run: () => unknown): void {
    try {
      const result = run();
      if (result instanceof Promise) result.catch((error: unknown) => this.options.logger.warn('event sink failed', { error: String(error) }));
    } catch (error) {
      this.options.logger.warn('listener failed', { error: String(error) });
    }
  }

  private requireSession(): GatewaySession {
    if (!this.session) throw new Error('FillerProtocolClient: attach() first');
    return this.session;
  }

  private requireRest(): GatewayRest {
    if (!this.rest) throw new Error('FillerProtocolClient: attach() first');
    return this.rest;
  }
}
