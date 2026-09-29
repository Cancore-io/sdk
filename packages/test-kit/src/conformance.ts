/**
 * The conformance harness: what a protocol-v1 taker MUST do in each mode of
 * the mock, checked against the mock's own log of what went over the wire
 * (WS and REST). The mock only emits the violation; this is how a downstream
 * suite (trader/taker, filler node) asserts the reaction without re-deriving
 * the rules.
 */
import type { Mode } from './scenario';

export interface LogEntry {
  seq: number;
  /** Mock clock, ms. */
  at: number;
  dir: 'S2F' | 'F2S';
  via: 'ws' | 'rest';
  fillerId?: string;
  msg: Record<string, unknown>;
}

type Check = 'receipt' | 'decline' | 'no-intent' | 'single-auth' | 'rest-intent' | 'no-receipt' | 'intent';

export interface TakerExpectation {
  /** The protocol rule the mode violates or exercises. */
  rule: string;
  /** What the taker must do, in words. */
  reaction: string;
  /** The `ticket.decline.reason` expected, if the reaction is a decline. */
  decline?: string;
  /** Pattern the decline `detail` must match. */
  detail?: RegExp;
  check: Check;
}

const decline = (rule: string, reason: string): TakerExpectation => ({
  rule,
  reaction: `ticket.decline {${reason}}; no ticket.receipt, no fill`,
  decline: reason,
  check: 'decline',
});

export const TAKER_EXPECTATIONS: Readonly<Record<Mode, TakerExpectation>> = {
  HAPPY: { rule: 'protocol §3.5', reaction: 'ticket.intent, then ticket.receipt; no decline', check: 'receipt' },
  LATE_ISSUED: decline('S-2', 'TICKET_ISSUED_LATE'),
  FOREIGN_TICKET_SIG: decline('T-1', 'TICKET_SIGNER_UNKNOWN'),
  FIELD_MISMATCH: decline('S-5', 'TICKET_MISMATCH'),
  SHORT_TTL: decline('S-1', 'TICKET_TTL_TOO_SHORT'),
  BEYOND_DEADLINE: decline('S-3', 'TICKET_BEYOND_DEADLINE'),
  WRONG_DRAW: decline('S-11', 'DRAW_MISMATCH'),
  BAD_GATEWAY_SIG: { rule: 'S-10, T-6', reaction: 'drop the frame: no ticket.intent for the offer', check: 'no-intent' },
  UNSUPPORTED_VERSION: { rule: 'V-1', reaction: 'report to the operator; no reconnect loop (one auth.response)', check: 'single-auth' },
  DROP_CONNECTION: { rule: 'protocol §6', reaction: 'REST: GET /v1/filler/tickets + POST …/intent, acked before acceptBy', check: 'rest-intent' },
  NO_ISSUED: { rule: 'S-4', reaction: 'nothing: no ticket.receipt, no fill for the attempt', check: 'no-receipt' },
  CANTON_DESTINATION: { ...decline('O-5', 'OTHER'), reaction: 'ticket.decline {OTHER, detail "O-5"}; no EVM ticket.receipt', detail: /O-5/ },
  UNKNOWN_S2F_TYPE: { rule: 'V-2', reaction: 'ignore future.info and the extra field; act on the offer (ticket.intent)', check: 'intent' },
};

export class TakerConformanceError extends Error {
  override name = 'TakerConformanceError';
}

/** S-2: a `ticket.issued` sent after `acceptBy + δ_issue` is late; at it, it is on time. */
export const issuedLate = (sentAt: number, acceptBy: number, issueDelayMs: number) => sentAt > acceptBy + issueDelayMs;

type Finder = (type: string) => LogEntry[];

const CHECKS: Record<Exclude<Check, 'single-auth'>, (e: TakerExpectation, f2s: Finder, s2f: Finder, offer: LogEntry) => string[]> = {
  receipt: (_e, f2s) => [...need(f2s, 'ticket.intent'), ...need(f2s, 'ticket.receipt'), ...none(f2s, 'ticket.decline')],
  decline: (e, f2s) => [...declined(e, f2s), ...none(f2s, 'ticket.receipt'), ...none(f2s, 'fill.reported')],
  'no-intent': (_e, f2s) => [...none(f2s, 'ticket.intent'), ...none(f2s, 'ticket.receipt')],
  'no-receipt': (_e, f2s) => [...none(f2s, 'ticket.receipt'), ...none(f2s, 'fill.reported')],
  intent: (_e, f2s) => need(f2s, 'ticket.intent'),
  'rest-intent': (_e, f2s, s2f, offer) => {
    const viaRest = f2s('ticket.intent').some((x) => x.via === 'rest');
    const intime = s2f('ticket.intent.ack').some((x) => (x.msg.receivedAt as number) <= (offer.msg.acceptBy as number));
    return [...(viaRest ? [] : ['no ticket.intent over REST']), ...(intime ? [] : ['no ticket.intent.ack with receivedAt ≤ acceptBy'])];
  },
};

function need(f2s: Finder, type: string) {
  return f2s(type).length > 0 ? [] : [`no ${type}`];
}

function none(f2s: Finder, type: string) {
  return f2s(type).length === 0 ? [] : [`unexpected ${type}`];
}

function declined(e: TakerExpectation, f2s: Finder): string[] {
  const d = f2s('ticket.decline');
  if (d.length === 0) return [`no ticket.decline {${e.decline}}`];
  const hit = d.some((x) => x.msg.reason === e.decline && (!e.detail || e.detail.test(String(x.msg.detail ?? ''))));
  return hit ? [] : [`ticket.decline reason ${d.map((x) => x.msg.reason).join(', ')}, expected ${e.decline}${e.detail ? ` with detail ${e.detail}` : ''}`];
}

/**
 * Throws `TakerConformanceError` unless the log shows the reaction
 * `TAKER_EXPECTATIONS[mode]` requires, for the first `ticket.offer` in the log
 * (of `opts.fillerId` if given).
 */
export function assertTakerReaction(log: readonly LogEntry[], mode: Mode, opts: { fillerId?: string } = {}): void {
  const e = TAKER_EXPECTATIONS[mode];
  const entries = opts.fillerId ? log.filter((x) => x.fillerId === opts.fillerId) : log;
  const failures = e.check === 'single-auth' ? singleAuth(entries) : ticketFailures(e, entries);
  if (failures.length > 0) throw new TakerConformanceError(`${mode} (${e.rule}): expected ${e.reaction}; ${failures.join('; ')}`);
}

function singleAuth(entries: readonly LogEntry[]): string[] {
  const n = entries.filter((x) => x.dir === 'F2S' && x.msg.type === 'auth.response').length;
  return n <= 1 ? [] : [`${n} auth.response: a reconnect loop`];
}

function ticketFailures(e: TakerExpectation, entries: readonly LogEntry[]): string[] {
  const offer = entries.find((x) => x.dir === 'S2F' && x.msg.type === 'ticket.offer');
  if (!offer) return ['no ticket.offer in the log'];
  const same = (x: LogEntry) => x.msg.orderHash === offer.msg.orderHash && x.msg.attempt === offer.msg.attempt;
  const by = (dir: LogEntry['dir']) => (type: string) => entries.filter((x) => x.dir === dir && x.msg.type === type && same(x));
  return CHECKS[e.check as Exclude<Check, 'single-auth'>](e, by('F2S'), by('S2F'), offer);
}
