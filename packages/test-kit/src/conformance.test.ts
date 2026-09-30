import { assertTakerReaction, issuedLate, TAKER_EXPECTATIONS, TakerConformanceError } from './conformance';
import type { LogEntry } from './conformance';
import { MODES } from './scenario';
import type { Mode } from './scenario';

const H = '0x' + '11'.repeat(32);
const ACCEPT_BY = 1_000_000;
let seq = 0;
const s2f = (msg: Record<string, unknown>): LogEntry => ({ seq: seq++, at: ACCEPT_BY - 2_000, dir: 'S2F', via: 'ws', fillerId: 'acme-markets', msg });
const f2s = (msg: Record<string, unknown>, via: 'ws' | 'rest' = 'ws'): LogEntry => ({ seq: seq++, at: ACCEPT_BY - 1_000, dir: 'F2S', via, fillerId: 'acme-markets', msg });

const offer = s2f({ type: 'ticket.offer', orderHash: H, attempt: 0, acceptBy: ACCEPT_BY });
const intent = (via: 'ws' | 'rest' = 'ws') => f2s({ type: 'ticket.intent', orderHash: H, attempt: 0 }, via);
const ack = (receivedAt = ACCEPT_BY - 1_000) => s2f({ type: 'ticket.intent.ack', orderHash: H, attempt: 0, receivedAt });
const issued = s2f({ type: 'ticket.issued', orderHash: H, attempt: 0 });
const receipt = f2s({ type: 'ticket.receipt', orderHash: H, attempt: 0 });
const fill = f2s({ type: 'fill.reported', orderHash: H, attempt: 0 });
const decline = (reason: string, detail?: string) => f2s({ type: 'ticket.decline', orderHash: H, attempt: 0, reason, ...(detail ? { detail } : {}) });
const authResponse = f2s({ type: 'auth.response', fillerId: 'acme-markets' });
const unsupported = s2f({ type: 'error', code: 'UNSUPPORTED_VERSION' });

const DECLINES: Partial<Record<Mode, string>> = {
  LATE_ISSUED: 'TICKET_ISSUED_LATE',
  FOREIGN_TICKET_SIG: 'TICKET_SIGNER_UNKNOWN',
  FIELD_MISMATCH: 'TICKET_MISMATCH',
  SHORT_TTL: 'TICKET_TTL_TOO_SHORT',
  BEYOND_DEADLINE: 'TICKET_BEYOND_DEADLINE',
  WRONG_DRAW: 'DRAW_MISMATCH',
};

/** A scripted taker that reacts as protocol v1 requires, and one that does not. */
const scripts = {
  HAPPY: { good: [offer, intent(), ack(), issued, receipt, fill], bad: [offer, intent(), ack(), issued, decline('OTHER')] },
  ...(Object.fromEntries(
    Object.entries(DECLINES).map(([mode, reason]) => [
      mode,
      { good: [offer, intent(), ack(), issued, decline(reason)], bad: [offer, intent(), ack(), issued, receipt, fill] },
    ]),
  ) as Record<string, { good: LogEntry[]; bad: LogEntry[] }>),
  BAD_GATEWAY_SIG: { good: [offer], bad: [offer, intent()] },
  UNSUPPORTED_VERSION: { good: [authResponse, unsupported], bad: [authResponse, unsupported, authResponse, unsupported] },
  DROP_CONNECTION: { good: [offer, intent('rest'), ack()], bad: [offer] },
  NO_ISSUED: { good: [offer, intent(), ack()], bad: [offer, intent(), ack(), receipt, fill] },
  CANTON_DESTINATION: { good: [offer, intent(), ack(), issued, decline('OTHER', 'O-5: no Canton receipt')], bad: [offer, intent(), ack(), issued, receipt] },
  UNKNOWN_S2F_TYPE: { good: [s2f({ type: 'future.info' }), offer, intent()], bad: [s2f({ type: 'future.info' }), offer] },
} as Record<Mode, { good: LogEntry[]; bad: LogEntry[] }>;

test('every mode has an expectation that names its rule and the reaction', () => {
  expect(Object.keys(TAKER_EXPECTATIONS).sort()).toEqual([...MODES].sort());
  for (const e of Object.values(TAKER_EXPECTATIONS)) {
    expect(e.rule).toMatch(/\S/);
    expect(e.reaction).toMatch(/\S/);
  }
  expect(TAKER_EXPECTATIONS.LATE_ISSUED.decline).toBe('TICKET_ISSUED_LATE');
});

describe.each(MODES.map((m) => [m]))('%s', (mode) => {
  test('a conforming taker passes', () => {
    expect(() => assertTakerReaction(scripts[mode].good, mode)).not.toThrow();
  });

  test('a non-conforming taker fails with a reason', () => {
    expect(() => assertTakerReaction(scripts[mode].bad, mode)).toThrow(TakerConformanceError);
  });
});

test('a decline with the wrong reason fails and says which reason was expected', () => {
  expect(() => assertTakerReaction([offer, intent(), ack(), issued, decline('OTHER')], 'SHORT_TTL')).toThrow(/TICKET_TTL_TOO_SHORT/);
});

test('an intent acked after acceptBy does not count as the REST recovery of DROP_CONNECTION', () => {
  expect(() => assertTakerReaction([offer, intent('rest'), ack(ACCEPT_BY + 1)], 'DROP_CONNECTION')).toThrow(TakerConformanceError);
});

test('a ticket mode without any ticket.offer in the log fails loudly', () => {
  expect(() => assertTakerReaction([], 'LATE_ISSUED')).toThrow(/no ticket.offer/);
});

test('the check can be narrowed to one taker', () => {
  const zetaOffer: LogEntry = { ...offer, seq: seq++, fillerId: 'zeta-liquidity' };
  expect(() => assertTakerReaction([zetaOffer, offer, intent()], 'UNKNOWN_S2F_TYPE', { fillerId: 'acme-markets' })).not.toThrow();
  expect(() => assertTakerReaction([zetaOffer, offer, intent()], 'UNKNOWN_S2F_TYPE', { fillerId: 'zeta-liquidity' })).toThrow(TakerConformanceError);
});

describe('issuedLate — B13 rows 3–4 (S-2: acceptBy + δ_issue is on time)', () => {
  test('at acceptBy + δ_issue the ticket is not late', () => {
    expect(issuedLate(ACCEPT_BY + 3_000, ACCEPT_BY, 3_000)).toBe(false);
  });

  test('one millisecond later it is late', () => {
    expect(issuedLate(ACCEPT_BY + 3_001, ACCEPT_BY, 3_000)).toBe(true);
  });
});
