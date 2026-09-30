/**
 * The mock's state and its one way of speaking: `emit` builds an S→F message
 * (addressed with `fillerId`, timed with `sentAt` — D-C), signs it with the
 * TEST gateway key, logs it and sends it if the taker is connected. The
 * protocol logic is in session.ts, quoting.ts and ticketing.ts; transports in
 * wire.ts (WebSocket), rest.ts and control.ts.
 */
import { Clock } from './clock';
import type { LogEntry } from './conformance';
import { DEFAULT_FILLERS, epochAt, FIXTURE_T0 } from './fixtures';
import type { Epoch, FillerConfig } from './fixtures';
import { TEST_KEYS } from './keys';
import type { Hex } from './keys';
import { signGateway } from './protocol';
import { QuoteBook } from './quotes';
import type { Failure } from './quotes';
import type { Mode } from './scenario';
import { TicketBook } from './tickets';
import type { DrawAttempt } from './draws';

export interface MockConfig {
  env: string;
  /** Offer → acceptBy. */
  acceptByMs: number;
  /** δ_issue: `ticket.issued` is on time until acceptBy + this. */
  issueDelayMs: number;
  heartbeatMs: number;
  heartbeatMisses: number;
  /** MIN_TICKET_TTL of the destination. */
  minTicketTtlS: number;
  /** validUntil − validFrom of a normal ticket. */
  ticketTtlS: number;
  /** quote.request → windowCloseAt. */
  windowMs: number;
  quoteTtlMs: number;
  /** δ_drand (A-20). */
  deltaDrand: number;
  challengeTtlS: number;
  /** After validUntil, before ticket.expired. */
  finalityMs: number;
  clock: 'frozen' | 'real';
  /** Frozen clock start; default the fixture's t0. */
  clockBaseMs: number;
  fillers: FillerConfig[];
}

export const DEFAULT_CONFIG: Readonly<MockConfig> = {
  env: 'mock',
  acceptByMs: 3000,
  issueDelayMs: 3000,
  heartbeatMs: 15000,
  heartbeatMisses: 3,
  minTicketTtlS: 60,
  ticketTtlS: 180,
  windowMs: 1000,
  quoteTtlMs: 30000,
  deltaDrand: 6,
  challengeTtlS: 60,
  finalityMs: 1000,
  clock: 'frozen',
  clockBaseMs: FIXTURE_T0 * 1000,
  fillers: [...DEFAULT_FILLERS],
};

export interface Conn {
  fillerId?: string;
  challenge?: { nonce: Hex; expiresAt: string };
  heartbeat?: { outstanding?: string; sentIn?: number; missed: number };
  closed: boolean;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export type Body = { type: string } & Record<string, unknown>;
export type Signed = Body & { sig: Hex };

export interface DrawRecordBody {
  orderHash: Hex;
  source: string;
  openRef: string;
  t0: string;
  epochId: string;
  deltaDrand: number;
  attempts: DrawAttempt[];
}

export const errorBody = (f: Failure, re?: unknown): Body => ({ type: 'error', code: f.code, message: f.message, ...(typeof re === 'string' ? { re } : {}) });

export class MockGateway {
  readonly clock: Clock;
  readonly fillers: Map<string, FillerConfig>;
  mode: Mode = 'HAPPY';
  quotes = new QuoteBook();
  tickets = new TicketBook();
  draws = new Map<string, DrawRecordBody>();
  /** The signed ticket.offer per `orderHash/attempt`, for the REST list. */
  offers = new Map<string, Signed>();
  /** The taker's quote and its signed ack, by quoteHash, for `GET /v1/filler/quotes`. */
  quoteEvidence = new Map<string, { quote: Record<string, unknown>; ack: Signed }>();
  entries: LogEntry[] = [];
  conns = new Set<Conn>();
  live = new Map<string, Conn>();
  tokens = new Map<string, { fillerId: string; expiresAt: number }>();
  restChallenges = new Map<string, number>();
  epoch!: Epoch;
  /** Clock time of the last reset: the session's order opens here. */
  baseMs = 0;
  private seq = 0;
  private counter = 0;

  constructor(readonly cfg: MockConfig) {
    this.clock = new Clock({ mode: cfg.clock, baseMs: cfg.clockBaseMs });
    this.fillers = new Map(cfg.fillers.map((f) => [f.fillerId, f]));
    this.reset();
  }

  /** Everything back to the start: HAPPY, the base time, no state, no connection. */
  reset(): void {
    for (const c of this.conns) c.close(1012, 'mock reset');
    this.conns.clear();
    this.live.clear();
    this.clock.reset(this.cfg.clockBaseMs);
    this.baseMs = this.clock.now();
    this.mode = 'HAPPY';
    this.quotes = new QuoteBook();
    this.tickets = new TicketBook();
    this.draws.clear();
    this.offers.clear();
    this.quoteEvidence.clear();
    this.entries = [];
    this.tokens.clear();
    this.restChallenges.clear();
    this.epoch = epochAt(Math.floor(this.baseMs / 1000), [...this.fillers.values()]);
  }

  now = () => this.clock.now();
  nowS = () => Math.floor(this.clock.now() / 1000);
  nextId = (prefix: string) => `${prefix}-${++this.counter}`;

  record(dir: LogEntry['dir'], via: LogEntry['via'], fillerId: string | undefined, msg: Record<string, unknown>): void {
    this.entries.push({ seq: this.seq++, at: this.now(), dir, via, ...(fillerId ? { fillerId } : {}), msg });
  }

  /**
   * One S→F message: addressed, timed, signed by the gateway key (or, with
   * `badSig`, by the foreign key — BAD_GATEWAY_SIG), logged, and sent on
   * `conn` or else on the taker's live socket, if any.
   */
  emit(to: { fillerId?: string; conn?: Conn; via?: LogEntry['via'] }, body: Body, opts: { badSig?: boolean } = {}): Signed {
    const msg = { ...body, ...(to.fillerId ? { fillerId: to.fillerId } : {}), sentAt: this.now() };
    const signed = signGateway(msg, (opts.badSig ? TEST_KEYS.foreignSigner : TEST_KEYS.gateway).privateKey) as Signed;
    this.record('S2F', to.via ?? 'ws', to.fillerId, signed);
    const conn = to.conn ?? (to.fillerId ? this.live.get(to.fillerId) : undefined);
    if (conn && !conn.closed) conn.send(JSON.stringify(signed));
    return signed;
  }

  /** A public record (draw, epoch): signed, not addressed, not timed. */
  signRecord<T extends Record<string, unknown>>(body: T) {
    return signGateway(body, TEST_KEYS.gateway.privateKey);
  }

  info() {
    return { env: this.cfg.env, gateway: TEST_KEYS.gateway.address, ticketSigners: [TEST_KEYS.ticketSigner.address], protocolVersion: '1' };
  }
}
