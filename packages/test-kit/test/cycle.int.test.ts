import { TEST_KEYS } from '../src/index';
import { assertTakerReaction } from '../src/conformance';
import type { LogEntry } from '../src/conformance';
import { weightsRoot } from '../src/draws';
import type { EpochLeaf } from '../src/draws';
import { recover } from '../src/keys';
import type { Hex } from '../src/keys';
import { drawOutcome, fillerQuoteDigest, fillTicketDigest, ticketIntentDigest } from '../src/protocol';
import { validateMessage } from '../src/validate';
import { advance, advanceTo, ctl, intentFor, KINDS, login, now, quoteFor, receiptFor, rest, restLogin, signedByGateway, startMock } from './helpers';
import type { Frame, MockHandle } from './helpers';

const TTL = 30_000;

describe.each(KINDS)('ticket cycle (%s mock)', (kind) => {
  let mock: MockHandle;
  beforeAll(async () => {
    mock = await startMock(kind);
  });
  afterAll(() => mock.close());
  beforeEach(() => ctl(mock, '/__mock/reset', {}));

  async function rfq(body: Record<string, unknown> = {}) {
    return (await ctl<{ requestId: string; windowCloseAt: number; quoteTtlMs: number }>(mock, '/__mock/rfq', body)).body;
  }
  const validUntilFor = (req: Frame) => String(Math.ceil(((req.windowCloseAt as number) + (req.quoteTtlMs as number)) / 1000) + 60);

  test('B1: quote → offer → intent → issued → receipt → expired FILLED → settled, every S→F frame signed and schema-valid', async () => {
    const { taker } = await login(mock);
    const gateway = (await rest<{ gateway: string; ticketSigners: string[] }>(mock, 'GET', '/v1/gateway')).body;
    await rfq({ quoteTtlMs: TTL });
    const request = await taker.next('quote.request');
    const q = taker.send(quoteFor(request, 'acme-markets', { nonce: '1', amountOut: '1200250000', validUntil: validUntilFor(request) }));
    const qAck = await taker.next('quote.ack');
    expect(qAck).toMatchObject({ re: q.id, requestId: request.requestId, status: 'COUNTED', quoteHash: fillerQuoteDigest(q as never) });

    await advanceTo(mock, (request.windowCloseAt as number) + 1);
    const offer = await taker.next('ticket.offer');
    expect(offer).toMatchObject({ fillerId: 'acme-markets', attempt: 0, amountOut: '1200250000' });
    expect(offer.acceptBy).toBe((await now(mock)) + 3_000);

    const intent = taker.send(intentFor(offer));
    const iAck = await taker.next('ticket.intent.ack');
    expect(iAck).toMatchObject({ re: intent.id, orderHash: offer.orderHash, attempt: 0, intentHash: ticketIntentDigest(intent as never) });
    const issued = await taker.next('ticket.issued');
    const ticket = issued.ticket as Record<string, unknown>;
    expect(issued).toMatchObject({ form: 'evm', orderHash: offer.orderHash, attempt: 0 });
    expect(ticket).toEqual({ orderHash: offer.orderHash, filler: TEST_KEYS.acmeFiller.address, attempt: 0, validFrom: offer.validFrom, validUntil: offer.validUntil });
    expect(gateway.ticketSigners).toContain(recover(fillTicketDigest(ticket as never), issued.ticketSig as Hex));

    taker.send(receiptFor(issued));
    taker.send({ type: 'fill.reported', orderHash: offer.orderHash, attempt: 0, txRef: `0x${'ef'.repeat(32)}` });
    await advanceTo(mock, (Number(offer.validUntil) + 2) * 1000);
    expect(await taker.next('ticket.expired')).toMatchObject({ orderHash: offer.orderHash, attempt: 0, result: 'FILLED' });
    const settled = await taker.next('order.settled');
    expect(settled).toMatchObject({ orderHash: offer.orderHash, penaltyWithheld: '0' });
    expect(BigInt(settled.payout as string) + BigInt(settled.fee as string)).toBe(BigInt((offer.order as { inputAmount: string }).inputAmount));

    const order = taker.frames.map((f) => f.type).filter((t) => ['ticket.offer', 'ticket.intent.ack', 'ticket.issued', 'ticket.expired', 'order.settled'].includes(t));
    expect(order).toEqual(['ticket.offer', 'ticket.intent.ack', 'ticket.issued', 'ticket.expired', 'order.settled']);
    for (const f of taker.frames) {
      expect([f.type, recoverOrNull(f)]).toEqual([f.type, gateway.gateway]);
      expect([f.type, typeof f.sentAt]).toEqual([f.type, 'number']);
      if (f.type !== 'auth.challenge') expect([f.type, f.fillerId]).toEqual([f.type, 'acme-markets']);
      expect([f.type, validateMessage(f)]).toEqual([f.type, null]);
    }
    const log = (await ctl<{ log: LogEntry[] }>(mock, '/__mock/log')).body.log;
    expect(() => assertTakerReaction(log, 'HAPPY')).not.toThrow();
    await taker.close();
  });

  test('A8 / S-11: the draw record names the offered taker, recomputes, and the epoch record rebuilds weightsRoot', async () => {
    const { taker, epoch } = await login(mock);
    const offer = (await ctl<Frame>(mock, '/__mock/offer', { fillerId: 'acme-markets' })).body;
    const record = (await rest<Record<string, unknown>>(mock, 'GET', `/v1/draws/${offer.orderHash}`)).body;
    expect(signedByGateway(record as Frame)).toBe(true);
    const attempt = (record.attempts as { attempt: number; drandRandomness: Hex; candidates: { fillerId: string; weight: string }[]; r: string; winnerFillerId: string }[])[0]!;
    expect(attempt.winnerFillerId).toBe('acme-markets');
    expect(drawOutcome(attempt.drandRandomness, offer.orderHash as Hex, 0, attempt.candidates)).toEqual({ r: attempt.r, winnerFillerId: 'acme-markets' });
    const epochRecord = (await rest<{ weightsRoot: string; leaves: EpochLeaf[] }>(mock, 'GET', `/v1/draws/epochs/${epoch.epochId}`)).body;
    expect(signedByGateway(epochRecord as unknown as Frame)).toBe(true);
    expect(epochRecord.weightsRoot).toBe(epoch.weightsRoot);
    expect(weightsRoot(epochRecord.leaves)).toBe(epoch.weightsRoot);
    expect((await rest(mock, 'GET', '/v1/draws/0x1234')).status).toBe(404);
    await taker.close();
  });

  test('B13 row 1: an intent exactly at acceptBy is acked', async () => {
    const { taker } = await login(mock);
    const offer = await offerTo(taker);
    await advanceTo(mock, offer.acceptBy as number);
    taker.send(intentFor(offer));
    expect(await taker.next('ticket.intent.ack')).toMatchObject({ receivedAt: offer.acceptBy });
    await taker.close();
  });

  test('B7 / B13 row 2: an intent 1 ms after acceptBy is TICKET_CLOSED on WS and 409 on REST; no ticket is issued', async () => {
    const { taker } = await login(mock);
    const offer = await offerTo(taker);
    await advanceTo(mock, (offer.acceptBy as number) + 1);
    const late = taker.send(intentFor(offer));
    expect(await taker.next('error')).toMatchObject({ code: 'TICKET_CLOSED', re: late.id });
    const token = await restLogin(mock);
    const res = await rest(mock, 'POST', `/v1/filler/tickets/${offer.orderHash}/0/intent`, { id: 'r-1', ...intentFor(offer) }, token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ type: 'error', code: 'TICKET_CLOSED', fillerId: 'acme-markets' });
    expect(signedByGateway(res.body as Frame)).toBe(true);
    await advance(mock, 10_000);
    expect(taker.frames.some((f) => f.type === 'ticket.issued')).toBe(false);
    await taker.close();
  });

  test('B10: the same intent twice gets the identical ack and one ticket', async () => {
    const { taker } = await login(mock);
    const offer = await offerTo(taker);
    const intent = intentFor(offer);
    taker.send(intent);
    const first = await taker.next('ticket.intent.ack');
    await advance(mock, 500);
    taker.send(intent);
    const second = await taker.next('ticket.intent.ack');
    expect([second.intentHash, second.receivedAt]).toEqual([first.intentHash, first.receivedAt]);
    await taker.next('ticket.issued');
    await advance(mock, 1_000);
    taker.send({ type: 'ping' });
    await taker.next('pong');
    expect(taker.frames.filter((f) => f.type === 'ticket.issued')).toHaveLength(1);
    await taker.close();
  });

  test('B11: a quote with nonce 2 replaces nonce 1 in the window; the draw uses it', async () => {
    const { taker } = await login(mock);
    await rfq({ quoteTtlMs: TTL });
    const request = await taker.next('quote.request');
    taker.send(quoteFor(request, 'acme-markets', { nonce: '1', amountOut: '100', validUntil: validUntilFor(request) }));
    expect(await taker.next('quote.ack')).toMatchObject({ status: 'COUNTED' });
    taker.send(quoteFor(request, 'acme-markets', { nonce: '2', amountOut: '90', validUntil: validUntilFor(request) }));
    expect(await taker.next('quote.ack')).toMatchObject({ status: 'COUNTED' });
    await advanceTo(mock, (request.windowCloseAt as number) + 1);
    expect(await taker.next('ticket.offer')).toMatchObject({ amountOut: '90' });
    const token = await restLogin(mock);
    const list = await rest<{ items: { quote: { nonce: string }; ack: Frame; status: string }[] }>(mock, 'GET', '/v1/filler/quotes', undefined, token);
    expect(list.body.items.every((i) => signedByGateway(i.ack) && i.ack.type === 'quote.ack')).toBe(true);
    expect(list.body.items.map((i) => [i.quote.nonce, i.status])).toEqual([
      ['1', 'REPLACED'],
      ['2', 'WON'],
    ]);
    await taker.close();
  });

  test('B12: a quote after windowCloseAt is acked with receivedAt > windowCloseAt and status LATE', async () => {
    const { taker } = await login(mock);
    await rfq({ quoteTtlMs: TTL });
    const request = await taker.next('quote.request');
    await advanceTo(mock, (request.windowCloseAt as number) + 1);
    taker.send(quoteFor(request, 'acme-markets', { nonce: '1', amountOut: '100', validUntil: validUntilFor(request) }));
    const ack = await taker.next('quote.ack');
    expect(ack.status).toBe('LATE');
    expect(ack.receivedAt as number).toBeGreaterThan(request.windowCloseAt as number);
    const token = await restLogin(mock);
    const list = await rest<{ items: { status: string }[] }>(mock, 'GET', '/v1/filler/quotes', undefined, token);
    expect(list.body.items.map((i) => i.status)).toEqual(['LATE']);
    expect(taker.frames.some((f) => f.type === 'ticket.offer')).toBe(false);
    await taker.close();
  });

  test.each([
    ['B13 row 5: validUntil × 1000 = B → COUNTED', 0, 'COUNTED'],
    ['B13 row 6: validUntil × 1000 = B − 1 ms → SHORT_TTL', 1, 'SHORT_TTL'],
  ])('%s', async (_name, shift, status) => {
    const { taker } = await login(mock);
    const X = Math.floor((await now(mock)) / 1000) + 40; // validUntil, s
    await rfq({ windowCloseAt: X * 1000 - TTL + shift, quoteTtlMs: TTL });
    const request = await taker.next('quote.request');
    taker.send(quoteFor(request, 'acme-markets', { nonce: '1', amountOut: '100', validUntil: String(X) }));
    expect(await taker.next('quote.ack')).toMatchObject({ status });
    await taker.close();
  });

  test('an unknown requestId is UNKNOWN_REQUEST; a quote signed by the wrong key is BAD_SIGNATURE', async () => {
    const { taker } = await login(mock);
    await rfq({ quoteTtlMs: TTL });
    const request = await taker.next('quote.request');
    taker.send(quoteFor({ ...request, requestId: 'req-unknown' }, 'acme-markets', { nonce: '1', amountOut: '1', validUntil: validUntilFor(request) }));
    expect(await taker.next('error')).toMatchObject({ code: 'UNKNOWN_REQUEST' });
    const forged = quoteFor(request, 'acme-markets', { nonce: '1', amountOut: '1', validUntil: validUntilFor(request) });
    taker.send({ ...forged, sig: quoteFor(request, 'zeta-liquidity', { nonce: '1', amountOut: '1', validUntil: validUntilFor(request) }).sig });
    expect(await taker.next('error')).toMatchObject({ code: 'BAD_SIGNATURE' });
    await taker.close();
  });

  test('B13 rows 7–8 over the wire: a fill one second after validUntil, with a receipt, expires NO_SHOW', async () => {
    const { taker } = await login(mock);
    const offer = await offerTo(taker);
    taker.send(intentFor(offer));
    const issued = await taker.next('ticket.issued');
    taker.send(receiptFor(issued));
    await advanceTo(mock, (Number(offer.validUntil) + 1) * 1000);
    taker.send({ type: 'fill.reported', orderHash: offer.orderHash, attempt: 0, txRef: `0x${'ab'.repeat(32)}` });
    await advance(mock, 2_000);
    expect(await taker.next('ticket.expired')).toMatchObject({ result: 'NO_SHOW' });
    expect(taker.frames.some((f) => f.type === 'order.settled')).toBe(false);
    await taker.close();
  });

  async function offerTo(taker: { next(type: string): Promise<Frame> }) {
    await ctl(mock, '/__mock/offer', { fillerId: 'acme-markets' });
    return taker.next('ticket.offer');
  }
});

function recoverOrNull(f: Frame) {
  try {
    return signedByGateway(f) ? TEST_KEYS.gateway.address : 'not the gateway';
  } catch {
    return null;
  }
}
