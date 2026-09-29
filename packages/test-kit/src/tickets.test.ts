import { payout, TicketBook } from './tickets';
import type { OfferTerms } from './tickets';

const ACCEPT_BY = 1_790_000_003_000;
const VALID_UNTIL = 1_790_000_180;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const offer: OfferTerms = {
  orderHash: H(1),
  attempt: 0,
  order: { fillDeadline: '1790000600' },
  amountOut: '1000',
  validFrom: '1790000000',
  validUntil: String(VALID_UNTIL),
  acceptBy: ACCEPT_BY,
};
const intent = { orderHash: offer.orderHash, attempt: 0, validFrom: offer.validFrom, validUntil: offer.validUntil };
const hashes = { ticketHash: H(7), ticketSigHash: H(8) };

function issued(book = new TicketBook()) {
  const t = book.offer('acme-markets', offer);
  book.intent('acme-markets', intent, ACCEPT_BY - 1_000, H(2));
  book.issue(t, { form: 'evm' }, hashes);
  return { book, t };
}

describe('ticket.intent', () => {
  test('B13 row 1: an intent received exactly at acceptBy is acked', () => {
    const book = new TicketBook();
    book.offer('acme-markets', offer);
    expect(book.intent('acme-markets', intent, ACCEPT_BY, H(2))).toEqual({
      ok: true,
      value: { orderHash: offer.orderHash, attempt: 0, intentHash: H(2), receivedAt: ACCEPT_BY },
    });
  });

  test('B13 row 2 / B7: one millisecond after acceptBy it is TICKET_CLOSED and nothing is acked', () => {
    const book = new TicketBook();
    const t = book.offer('acme-markets', offer);
    expect(book.intent('acme-markets', intent, ACCEPT_BY + 1, H(2))).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
    expect(t.state).toBe('OFFERED');
    expect(t.ack).toBeUndefined();
  });

  test('B10: the same intent twice returns the identical ack and keeps one ticket', () => {
    const book = new TicketBook();
    book.offer('acme-markets', offer);
    const first = book.intent('acme-markets', intent, ACCEPT_BY - 2_000, H(2));
    const again = book.intent('acme-markets', intent, ACCEPT_BY - 1_000, H(2));
    expect(again).toEqual(first);
    expect(book.list('acme-markets', 'OFFERED')).toHaveLength(1);
  });

  test('a different intent after the ack is refused', () => {
    const book = new TicketBook();
    book.offer('acme-markets', offer);
    book.intent('acme-markets', intent, ACCEPT_BY - 2_000, H(2));
    expect(book.intent('acme-markets', { ...intent, validUntil: '1790000100' }, ACCEPT_BY - 1_000, H(3))).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
  });

  test('values that differ from the offer are BAD_REQUEST', () => {
    const book = new TicketBook();
    book.offer('acme-markets', offer);
    expect(book.intent('acme-markets', { ...intent, validFrom: '1790000001' }, ACCEPT_BY, H(2))).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  test("another taker's ticket, or no ticket, is UNKNOWN_TICKET", () => {
    const book = new TicketBook();
    book.offer('acme-markets', offer);
    expect(book.intent('zeta-liquidity', intent, ACCEPT_BY, H(2))).toMatchObject({ ok: false, code: 'UNKNOWN_TICKET' });
    expect(book.intent('acme-markets', { ...intent, attempt: 1 }, ACCEPT_BY, H(2))).toMatchObject({ ok: false, code: 'UNKNOWN_TICKET' });
  });
});

describe('offers and attempts', () => {
  test('attempt numbers strictly increase per order; a duplicate (orderHash, attempt) is refused', () => {
    const book = new TicketBook();
    expect(book.nextAttempt(offer.orderHash)).toBe(0);
    book.offer('acme-markets', offer);
    expect(book.nextAttempt(offer.orderHash)).toBe(1);
    expect(() => book.offer('zeta-liquidity', offer)).toThrow(/already/);
  });

  test('list returns OFFERED (offered or acked) and ISSUED tickets of one taker', () => {
    const { book } = issued();
    book.offer('acme-markets', { ...offer, attempt: 1 });
    expect(book.list('acme-markets', 'OFFERED').map((t) => t.offer.attempt)).toEqual([1]);
    expect(book.list('acme-markets', 'ISSUED').map((t) => t.offer.attempt)).toEqual([0]);
    expect(book.list('zeta-liquidity', 'ISSUED')).toEqual([]);
  });

  test('close ends an attempt that never got a ticket', () => {
    const book = new TicketBook();
    const t = book.offer('acme-markets', offer);
    book.close(t, 'TICKET_EXPIRED');
    expect(t).toMatchObject({ state: 'CLOSED', closedBy: 'TICKET_EXPIRED' });
    expect(book.intent('acme-markets', intent, ACCEPT_BY, H(2))).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
  });
});

describe('ticket.receipt', () => {
  test('accepted until validUntil (inclusive second), idempotent', () => {
    const { book, t } = issued();
    const r = { orderHash: offer.orderHash, attempt: 0, ...hashes };
    expect(book.receipt('acme-markets', r, VALID_UNTIL * 1000 + 999)).toEqual({ ok: true, value: undefined });
    expect(book.receipt('acme-markets', r, VALID_UNTIL * 1000 + 999)).toEqual({ ok: true, value: undefined });
    expect(t.state).toBe('RECEIPTED');
  });

  test('after validUntil it is TICKET_CLOSED', () => {
    const { book } = issued();
    expect(book.receipt('acme-markets', { orderHash: offer.orderHash, attempt: 0, ...hashes }, (VALID_UNTIL + 1) * 1000)).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
  });

  test('hashes that are not the issued ticket are BAD_REQUEST; a receipt before issue is TICKET_CLOSED', () => {
    const { book } = issued();
    expect(book.receipt('acme-markets', { orderHash: offer.orderHash, attempt: 0, ticketHash: H(9), ticketSigHash: H(8) }, ACCEPT_BY)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    const other = new TicketBook();
    other.offer('acme-markets', offer);
    expect(other.receipt('acme-markets', { orderHash: offer.orderHash, attempt: 0, ...hashes }, ACCEPT_BY)).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
    expect(other.receipt('acme-markets', { orderHash: H(5), attempt: 0, ...hashes }, ACCEPT_BY)).toMatchObject({ ok: false, code: 'UNKNOWN_TICKET' });
  });

  test('a Canton-form ticket has no EVM receipt (O-5): BAD_REQUEST', () => {
    const book = new TicketBook();
    const t = book.offer('acme-markets', offer);
    book.intent('acme-markets', intent, ACCEPT_BY, H(2));
    book.issue(t, { form: 'canton' });
    expect(book.receipt('acme-markets', { orderHash: offer.orderHash, attempt: 0, ...hashes }, ACCEPT_BY)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });
});

describe('ticket.decline', () => {
  test('at the offer stage and at the issued stage', () => {
    const book = new TicketBook();
    const a = book.offer('acme-markets', offer);
    expect(book.decline('acme-markets', { orderHash: offer.orderHash, attempt: 0, reason: 'NO_INVENTORY' })).toEqual({ ok: true, value: undefined });
    expect(a).toMatchObject({ state: 'DECLINED', decline: { reason: 'NO_INVENTORY', stage: 'offer' } });
    const { book: b2, t } = issued();
    b2.decline('acme-markets', { orderHash: offer.orderHash, attempt: 0, reason: 'TICKET_ISSUED_LATE' });
    expect(t).toMatchObject({ state: 'DECLINED', decline: { stage: 'issued' } });
  });

  test('a second decline, or a decline of a closed ticket, is TICKET_CLOSED; an unknown one UNKNOWN_TICKET', () => {
    const book = new TicketBook();
    book.offer('acme-markets', offer);
    const d = { orderHash: offer.orderHash, attempt: 0, reason: 'OTHER' };
    book.decline('acme-markets', d);
    expect(book.decline('acme-markets', d)).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
    expect(book.decline('acme-markets', { ...d, attempt: 3 })).toMatchObject({ ok: false, code: 'UNKNOWN_TICKET' });
  });
});

describe('ticket.expired result — B13 rows 7–8', () => {
  const fill = { orderHash: offer.orderHash, attempt: 0, txRef: H(99) };

  test('a fill reported at validUntil is FILLED', () => {
    const { book, t } = issued();
    book.fillReported('acme-markets', fill, VALID_UNTIL * 1000);
    expect(book.expire(t)).toEqual({ result: 'FILLED' });
    expect(t.state).toBe('EXPIRED');
  });

  test('a fill one second after validUntil, with a receipt, is NO_SHOW', () => {
    const { book, t } = issued();
    book.receipt('acme-markets', { orderHash: offer.orderHash, attempt: 0, ...hashes }, ACCEPT_BY);
    book.fillReported('acme-markets', fill, (VALID_UNTIL + 1) * 1000);
    expect(book.expire(t)).toEqual({ result: 'NO_SHOW' });
  });

  test('no fill and no receipt is NO_SHOW_UNCONFIRMED (S-4: never an on-chain penalty)', () => {
    const { book, t } = issued();
    expect(book.expire(t)).toEqual({ result: 'NO_SHOW_UNCONFIRMED' });
  });

  test('a ticket declined at the issued stage expires EXEMPT, the gateway being at fault', () => {
    const { book, t } = issued();
    book.decline('acme-markets', { orderHash: offer.orderHash, attempt: 0, reason: 'TICKET_SIGNER_UNKNOWN' });
    expect(book.expire(t)).toEqual({ result: 'EXEMPT', exemptReason: 'GATEWAY_FAULT' });
  });

  test('a fill report on an unknown or already expired ticket is refused', () => {
    const { book, t } = issued();
    expect(book.fillReported('acme-markets', { ...fill, attempt: 5 }, ACCEPT_BY)).toMatchObject({ ok: false, code: 'UNKNOWN_TICKET' });
    book.expire(t);
    expect(book.fillReported('acme-markets', fill, ACCEPT_BY)).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
  });
});

test('inclusive fee: payout = ⌊T × 10000 / (10000 + feeBps)⌋, fee = T − payout (protocol §3.11 hand vector)', () => {
  expect(payout('105', 500)).toEqual({ payout: '100', fee: '5' });
  expect(payout('12505000000000', 30)).toEqual({ payout: '12467597208374', fee: '37402791626' });
});
