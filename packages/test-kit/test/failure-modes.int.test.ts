import { TEST_KEYS } from '../src/index';
import { assertTakerReaction, issuedLate, TAKER_EXPECTATIONS } from '../src/conformance';
import type { LogEntry } from '../src/conformance';
import { recover } from '../src/keys';
import type { Hex } from '../src/keys';
import { drawOutcome, fillTicketDigest } from '../src/protocol';
import type { Mode } from '../src/scenario';
import { advanceTo, ctl, intentFor, KINDS, login, rest, restLogin, signedByGateway, startMock } from './helpers';
import type { Frame, MockHandle, Taker } from './helpers';

interface Config {
  acceptByMs: number;
  issueDelayMs: number;
  minTicketTtlS: number;
}

describe.each(KINDS)('failure modes (%s mock)', (kind) => {
  let mock: MockHandle;
  let config: Config;
  beforeAll(async () => {
    mock = await startMock(kind);
    config = (await ctl<{ config: Config }>(mock, '/__mock/health')).body.config;
  });
  afterAll(() => mock.close());
  beforeEach(() => ctl(mock, '/__mock/reset', {}));

  async function offered(mode: Mode) {
    await ctl(mock, '/__mock/scenario', { mode });
    const session = await login(mock);
    await ctl(mock, '/__mock/offer', { fillerId: 'acme-markets' });
    const offer = await session.taker.next('ticket.offer');
    return { ...session, offer };
  }

  async function issuedIn(mode: Mode) {
    const s = await offered(mode);
    const intent = s.taker.send(intentFor(s.offer));
    await s.taker.next('ticket.intent.ack');
    if (mode === 'LATE_ISSUED') await advanceTo(mock, (s.offer.acceptBy as number) + config.issueDelayMs + 1);
    const issued = await s.taker.next('ticket.issued');
    return { ...s, intent, issued };
  }

  /** The scripted conforming reaction, then the harness over the mock's own log. */
  async function declineAndAssert(taker: Taker, offer: Frame, mode: Mode, detail?: string) {
    taker.send({ type: 'ticket.decline', orderHash: offer.orderHash, attempt: offer.attempt, reason: TAKER_EXPECTATIONS[mode].decline, ...(detail ? { detail } : {}) });
    taker.send({ type: 'ping' });
    await taker.next('pong');
    const log = (await ctl<{ log: LogEntry[] }>(mock, '/__mock/log')).body.log;
    expect(() => assertTakerReaction(log, mode)).not.toThrow();
    await taker.close();
  }

  const ticketOf = (issued: Frame) => issued.ticket as { orderHash: Hex; filler: Hex; attempt: number; validFrom: string; validUntil: string };

  test('B3 LATE_ISSUED: ticket.issued is sent after acceptBy + δ_issue', async () => {
    const { taker, offer, issued } = await issuedIn('LATE_ISSUED');
    expect(issuedLate(issued.sentAt as number, offer.acceptBy as number, config.issueDelayMs)).toBe(true);
    expect(issued.sentAt).toBe((offer.acceptBy as number) + config.issueDelayMs + 1);
    await declineAndAssert(taker, offer, 'LATE_ISSUED');
  });

  test('B3 FOREIGN_TICKET_SIG: ticketSig recovers to a key outside ticketSigners', async () => {
    const { taker, offer, issued } = await issuedIn('FOREIGN_TICKET_SIG');
    const signers = (await rest<{ ticketSigners: string[] }>(mock, 'GET', '/v1/gateway')).body.ticketSigners;
    const signer = recover(fillTicketDigest(ticketOf(issued)), issued.ticketSig as Hex);
    expect(signer).toBe(TEST_KEYS.foreignSigner.address);
    expect(signers).not.toContain(signer);
    expect(signedByGateway(issued)).toBe(true);
    await declineAndAssert(taker, offer, 'FOREIGN_TICKET_SIG');
  });

  test('B3 FIELD_MISMATCH: the ticket differs from the intent', async () => {
    const { taker, offer, issued, intent } = await issuedIn('FIELD_MISMATCH');
    const t = ticketOf(issued);
    expect(t.validUntil !== intent.validUntil || t.filler !== TEST_KEYS.acmeFiller.address).toBe(true);
    expect(recover(fillTicketDigest(t), issued.ticketSig as Hex)).toBe(TEST_KEYS.ticketSigner.address);
    await declineAndAssert(taker, offer, 'FIELD_MISMATCH');
  });

  test('B3 SHORT_TTL: validUntil − validFrom < MIN_TICKET_TTL', async () => {
    const { taker, offer, issued } = await issuedIn('SHORT_TTL');
    const t = ticketOf(issued);
    expect(Number(t.validUntil) - Number(t.validFrom)).toBeLessThan(config.minTicketTtlS);
    await declineAndAssert(taker, offer, 'SHORT_TTL');
  });

  test('B3 BEYOND_DEADLINE: validUntil ≥ order.fillDeadline', async () => {
    const { taker, offer, issued } = await issuedIn('BEYOND_DEADLINE');
    const t = ticketOf(issued);
    expect(BigInt(t.validUntil) >= BigInt((offer.order as { fillDeadline: string }).fillDeadline)).toBe(true);
    expect(Number(t.validUntil) - Number(t.validFrom)).toBeGreaterThanOrEqual(config.minTicketTtlS);
    await declineAndAssert(taker, offer, 'BEYOND_DEADLINE');
  });

  test('B3 WRONG_DRAW: the offer goes to a taker the published draw does not name', async () => {
    const { taker, offer } = await offered('WRONG_DRAW');
    const record = (await rest<{ attempts: { attempt: number; drandRandomness: Hex; candidates: { fillerId: string; weight: string }[]; r: string; winnerFillerId: string }[] }>(mock, 'GET', `/v1/draws/${offer.orderHash}`)).body;
    const a = record.attempts.find((x) => x.attempt === offer.attempt)!;
    expect(drawOutcome(a.drandRandomness, offer.orderHash as Hex, a.attempt, a.candidates)).toEqual({ r: a.r, winnerFillerId: a.winnerFillerId });
    expect(a.winnerFillerId).not.toBe('acme-markets');
    await declineAndAssert(taker, offer, 'WRONG_DRAW');
  });

  test('B4 BAD_GATEWAY_SIG: the offer sig does not recover to the published gateway', async () => {
    const { taker, offer } = await offered('BAD_GATEWAY_SIG');
    expect(signedByGateway(offer)).toBe(false);
    taker.send({ type: 'ping' });
    await taker.next('pong');
    const log = (await ctl<{ log: LogEntry[] }>(mock, '/__mock/log')).body.log;
    expect(() => assertTakerReaction(log, 'BAD_GATEWAY_SIG')).not.toThrow();
    await taker.close();
  });

  test('B6 DROP_CONNECTION: the socket drops after the offer; REST recovers it before acceptBy', async () => {
    const { taker, offer } = await offered('DROP_CONNECTION');
    await taker.closed;
    const token = await restLogin(mock);
    const list = await rest<{ items: Frame[]; nextCursor: string | null }>(mock, 'GET', '/v1/filler/tickets?status=OFFERED', undefined, token);
    expect(list.body.items.map((i) => [i.type, i.orderHash])).toEqual([['ticket.offer', offer.orderHash]]);
    expect(list.body.items.every(signedByGateway)).toBe(true);
    const res = await rest<Frame>(mock, 'POST', `/v1/filler/tickets/${offer.orderHash}/${offer.attempt}/intent`, { id: 'r-1', ...intentFor(offer) }, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'ticket.intent.ack', orderHash: offer.orderHash });
    expect(res.body.receivedAt as number).toBeLessThanOrEqual(offer.acceptBy as number);
    expect(signedByGateway(res.body)).toBe(true);
    const issued = await rest<{ items: Frame[] }>(mock, 'GET', '/v1/filler/tickets?status=ISSUED', undefined, token);
    expect(issued.body.items.map((i) => i.type)).toEqual(['ticket.issued']);
    const log = (await ctl<{ log: LogEntry[] }>(mock, '/__mock/log')).body.log;
    expect(() => assertTakerReaction(log, 'DROP_CONNECTION')).not.toThrow();
  });

  test('REST without a bearer is 401; a foreign ticket is 404 UNKNOWN_TICKET', async () => {
    const { taker, offer } = await offered('HAPPY');
    expect((await rest(mock, 'GET', '/v1/filler/tickets?status=OFFERED')).status).toBe(401);
    const zeta = await restLogin(mock, 'zeta-liquidity');
    const res = await rest(mock, 'POST', `/v1/filler/tickets/${offer.orderHash}/0/intent`, { id: 'r-2', ...intentFor(offer, 'zeta-liquidity') }, zeta);
    expect(res).toMatchObject({ status: 404, body: { code: 'UNKNOWN_TICKET' } });
    const decline = await rest(mock, 'POST', `/v1/filler/tickets/${offer.orderHash}/0/decline`, { id: 'r-3', type: 'ticket.decline', orderHash: offer.orderHash, attempt: 0, reason: 'NO_INVENTORY' }, await restLogin(mock));
    expect(decline).toEqual({ status: 200, body: {} });
    await taker.close();
  });

  test('V-2: an unknown decline reason is accepted (as OTHER), not refused', async () => {
    const { taker, offer } = await offered('HAPPY');
    taker.send({ type: 'ticket.decline', orderHash: offer.orderHash, attempt: offer.attempt, reason: 'FUTURE_REASON' });
    taker.send({ type: 'ping' });
    await taker.next('pong');
    expect(taker.frames.some((f) => f.type === 'error')).toBe(false);
    const token = await restLogin(mock);
    expect((await rest<{ items: Frame[] }>(mock, 'GET', '/v1/filler/tickets?status=OFFERED', undefined, token)).body.items).toEqual([]);
    await taker.close();
  });

  test('B9 NO_ISSUED: nothing arrives by acceptBy + δ_issue; the next offer is attempt + 1', async () => {
    const { taker, offer } = await offered('NO_ISSUED');
    taker.send(intentFor(offer));
    await taker.next('ticket.intent.ack');
    await advanceTo(mock, (offer.acceptBy as number) + config.issueDelayMs + 1);
    const next = await taker.next('ticket.offer');
    expect(next).toMatchObject({ orderHash: offer.orderHash, attempt: (offer.attempt as number) + 1 });
    expect(taker.frames.some((f) => f.type === 'ticket.issued')).toBe(false);
    const log = (await ctl<{ log: LogEntry[] }>(mock, '/__mock/log')).body.log;
    expect(() => assertTakerReaction(log, 'NO_ISSUED')).not.toThrow();
    await taker.close();
  });

  test('B14 CANTON_DESTINATION: ticket.issued in Canton form with a whole-second validUntil', async () => {
    const { taker, offer, issued } = await issuedIn('CANTON_DESTINATION');
    expect(issued).toMatchObject({ form: 'canton', orderHash: offer.orderHash, deliveryOrderCid: expect.any(String), validUntil: offer.validUntil });
    expect(String(issued.validUntil)).toMatch(/^[1-9][0-9]*$/);
    expect(issued.ticket).toBeUndefined();
    await declineAndAssert(taker, offer, 'CANTON_DESTINATION', 'O-5: Canton-destination receipt undefined');
  });

  test('A4 UNKNOWN_S2F_TYPE: a signed future.info and an offer with an extra field "x"', async () => {
    const { taker, offer } = await offered('UNKNOWN_S2F_TYPE');
    const info = taker.frames.find((f) => f.type === 'future.info');
    expect(info && signedByGateway(info)).toBe(true);
    expect(offer.x).toBeDefined();
    expect(signedByGateway(offer)).toBe(true);
    taker.send(intentFor(offer));
    await taker.next('ticket.intent.ack');
    const log = (await ctl<{ log: LogEntry[] }>(mock, '/__mock/log')).body.log;
    expect(() => assertTakerReaction(log, 'UNKNOWN_S2F_TYPE')).not.toThrow();
    await taker.close();
  });
});
