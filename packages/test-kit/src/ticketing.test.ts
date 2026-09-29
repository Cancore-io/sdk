import { DEFAULT_CONFIG, MockGateway } from './gateway';
import { sign, TEST_KEYS } from './keys';
import { ticketIntentDigest } from './protocol';
import type { Hex } from './keys';
import { offerFixture, onIntent } from './ticketing';

const offersOf = (gw: MockGateway) => gw.entries.filter((e) => e.dir === 'S2F' && e.msg.type === 'ticket.offer').map((e) => e.msg as Record<string, unknown> & { order: { fillDeadline: string } });

/** S-1 and S-3 of an offered ticket. */
function expectLegal(gw: MockGateway, offer: ReturnType<typeof offersOf>[number]) {
  const from = Number(offer.validFrom);
  const until = Number(offer.validUntil);
  expect(until - from).toBeGreaterThanOrEqual(gw.cfg.minTicketTtlS);
  expect(until).toBeLessThan(Number(offer.order.fillDeadline));
  expect(from).toBe(gw.nowS());
}

describe('HAPPY offers a legal ticket however far the clock moved (S-1, S-3)', () => {
  test.each([0, 60_000, 530_000, 560_000, 11 * 60_000, 2 * 3_600_000])('clock advanced %p ms', (ms) => {
    const gw = new MockGateway({ ...DEFAULT_CONFIG });
    gw.clock.advance(ms);
    offerFixture(gw, 'acme-markets');
    const offers = offersOf(gw);
    expect(offers).toHaveLength(1);
    expectLegal(gw, offers[0]!);
  });

  test('at the default clock the session fixture order is offered unchanged', () => {
    const gw = new MockGateway({ ...DEFAULT_CONFIG });
    offerFixture(gw, 'acme-markets');
    expect(offersOf(gw)[0]!.order).toMatchObject({ createdAt: '1790000000', fillDeadline: '1790000600' });
  });
});

test('NO_ISSUED stops re-offering an order that can no longer fit a legal ticket', () => {
  const gw = new MockGateway({ ...DEFAULT_CONFIG });
  gw.mode = 'NO_ISSUED';
  // 61 s left before fillDeadline − 1: one legal ticket fits now, none after acceptBy + δ_issue.
  gw.clock.advance((1790000538 - 1790000012) * 1000);
  const offer = offerFixture(gw, 'acme-markets');
  const body = { orderHash: offer.orderHash as Hex, attempt: offer.attempt as number, validFrom: String(offer.validFrom), validUntil: String(offer.validUntil) };
  expect(onIntent(gw, 'acme-markets', { ...body, sig: sign(ticketIntentDigest(body), TEST_KEYS.acmeFiller.privateKey) })).toMatchObject({ ok: true });
  gw.clock.advance(gw.cfg.acceptByMs + gw.cfg.issueDelayMs + 60_000);
  const offers = offersOf(gw);
  expect(offers).toHaveLength(1);
  expect(gw.draws.get(String(offer.orderHash))!.attempts[0]!.closedBy).toBe('OFFER_TIMEOUT');
});
