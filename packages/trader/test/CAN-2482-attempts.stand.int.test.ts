/**
 * CAN-2482, one attempt per order, against the real filler-gateway of the intent stand: the first offer reaches
 * the hook once and its intent is acked; an offer of another attempt — after the first expired, or while it is
 * still open — is refused by filler-gateway (S-7) and never reaches the SDK; a reconfirm reaches only the filler
 * the order names. trading is played on the Redis Streams (test/stand/filler-gateway.ts).
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/CAN-2482-attempts.stand.int.test.ts
 */
import type { Hex, TicketOffer } from '@cancore/contracts';
import type { FillerReconfirm } from '../src/filler/quotes';
import { env } from './stand/canton-ledger';
import {
  command,
  cursor,
  eventsAfter,
  GATEWAY_KEYS,
  issueEvmTicket,
  offerCommand,
  ofOrder,
  sleep,
  STAND_TICKET_SIGNER_KEY,
  standChain,
  standEvmOrder,
  standFiller,
  standOrder,
  standSuite,
  STREAMS,
  until,
  type StandFiller,
} from './stand/filler-gateway';

standSuite('CAN-2482: one attempt per order against the real filler-gateway', [...GATEWAY_KEYS, 'STAND_FILLER2_ID'], () => {
  const offers: TicketOffer[] = [];
  const reconfirms: FillerReconfirm[] = [];
  let stand: StandFiller;

  beforeAll(async () => {
    stand = standFiller({
      offer: async (offer) => {
        offers.push(offer);
        return 'accept';
      },
      reconfirm: async (reconfirm) => {
        reconfirms.push(reconfirm);
        return true;
      },
    });
    await stand.filler.start();
  }, 120_000);

  afterAll(async () => {
    await stand?.filler.stop();
  });

  const hookCalls = (orderHash: Hex) => offers.filter((o) => o.orderHash.toLowerCase() === orderHash).length;
  const ticket = (orderHash: Hex, attempt: number) => stand.store.withOrder(orderHash, (tx) => tx.getTicket(attempt));

  /** Offers attempt 0 of a fresh order and waits for filler-gateway's ack of the SDK's intent. */
  async function offeredAndAcked(salt: number) {
    const o = standOrder(salt);
    const from = await cursor(STREAMS.ticketEvents);
    await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
    const acked = await until('the intent acked', async () => ((await ticket(o.orderHash, 0))?.intentAck ? ticket(o.orderHash, 0) : undefined), 60_000, stand.diagnostics);
    return { ...o, from, acked: acked! };
  }

  const refusedS7 = async (orderHash: Hex, from: string, attempt: number) =>
    until(`filler-gateway refused attempt ${attempt} (S-7)`, async () => {
      const refused = await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(orderHash)(e) && e.kind === 'ticket.offer.refused' && e.data.attempt === attempt);
      return refused[0];
    }, 30_000, stand.diagnostics);

  test('TC-SDK-2482-INT-01: the first offer of an order reaches the hook once; the intent is acked by filler-gateway', async () => {
    const o = await offeredAndAcked(1);
    expect(hookCalls(o.orderHash)).toBe(1);
    expect(o.acked.state).toBe('intent-acked');
    const kinds = (await eventsAfter(STREAMS.ticketEvents, o.from, ofOrder(o.orderHash))).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['ticket.offered', 'ticket.intent']));
    expect(kinds).not.toContain('ticket.declined');
  }, 120_000);

  test('TC-SDK-2482-INT-02: attempt 2 after attempt 0 expired — refused by filler-gateway (S-7), no hook, nothing stored for it', async () => {
    // filler-gateway expires an issued ticket only: attempt 0 is issued, declined by the SDK (never opened), then expired.
    const o = standEvmOrder(2);
    const issuedFrom = await issueEvmTicket(stand, o, STAND_TICKET_SIGNER_KEY);
    await until('attempt 0 declined at filler-gateway', async () => (await eventsAfter(STREAMS.ticketEvents, issuedFrom, (e) => ofOrder(o.orderHash)(e) && e.kind === 'ticket.declined'))[0], 60_000, stand.diagnostics);
    await command(STREAMS.tickets, 'ticket.expire', { orderHash: o.orderHash, attempt: 0, result: 'NO_SHOW_UNCONFIRMED' });
    await until('attempt 0 expired in the SDK', async () => ((await ticket(o.orderHash, 0))?.state === 'expired' ? true : undefined), 60_000, stand.diagnostics);

    const from = await cursor(STREAMS.ticketEvents);
    await command(STREAMS.tickets, 'ticket.offer', offerCommand(o, { attempt: 2, destination: standChain(), form: 'evm' }));
    expect((await refusedS7(o.orderHash, from, 2)).data).toMatchObject({ rule: 'S-7' });
    await sleep(3_000);
    expect(hookCalls(o.orderHash)).toBe(1);
    expect(await ticket(o.orderHash, 2)).toBeUndefined();
  }, 180_000);

  test('TC-SDK-2482-INT-03: attempt 1 while attempt 0 is at INTENT — refused by filler-gateway (S-7); attempt 0 unchanged', async () => {
    const o = await offeredAndAcked(3);
    const before = await ticket(o.orderHash, 0);
    const from = await cursor(STREAMS.ticketEvents);
    await command(STREAMS.tickets, 'ticket.offer', offerCommand(o, { attempt: 1 }));
    expect((await refusedS7(o.orderHash, from, 1)).data).toMatchObject({ rule: 'S-7' });
    await sleep(3_000);
    expect(hookCalls(o.orderHash)).toBe(1);
    expect(await ticket(o.orderHash, 1)).toBeUndefined();
    expect(await ticket(o.orderHash, 0)).toMatchObject({ state: before!.state, intentAck: before!.intentAck });
  }, 180_000);

  test('TC-SDK-2482-INT-04: a reconfirm of its own order — the hook once, a signed accept recorded by filler-gateway before replyBy', async () => {
    const o = standOrder(4);
    const replyBy = Date.now() + 15_000;
    const from = await cursor(STREAMS.quotes);
    await command(STREAMS.quoteRequests, 'quote.reconfirm', { fillerId: env('STAND_FILLER_ID'), orderHash: o.orderHash, requestId: `can-2482-${o.orderHash.slice(2, 14)}`, order: o.order, replyBy });
    const reply = await until('quote.reconfirm.reply', async () => (await eventsAfter(STREAMS.quotes, from, (e) => ofOrder(o.orderHash)(e) && e.kind === 'quote.reconfirm.reply'))[0], 30_000, stand.diagnostics);
    expect(reply.data).toMatchObject({ fillerId: env('STAND_FILLER_ID'), accept: true, amountOut: o.order.minReceived });
    expect(reply.data.sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(Number(reply.data.receivedAt)).toBeLessThanOrEqual(replyBy);
    expect(reconfirms.filter((r) => r.orderHash.toLowerCase() === o.orderHash)).toHaveLength(1);
  }, 120_000);

  test('TC-SDK-2482-INT-05: a reconfirm of an order that names the second filler — asked of it, or of this filler: no hook here, no reply from this filler', async () => {
    const other = standOrder(5, env('STAND_FILLER2_ID'));
    const from = await cursor(STREAMS.quotes);
    const requestId = `can-2482-${other.orderHash.slice(2, 14)}`;
    await command(STREAMS.quoteRequests, 'quote.reconfirm', { fillerId: env('STAND_FILLER2_ID'), orderHash: other.orderHash, requestId, order: other.order, replyBy: Date.now() + 10_000 });
    // filler-gateway asks only the picked filler (FS-14): this one asked for the second filler's order is refused.
    await command(STREAMS.quoteRequests, 'quote.reconfirm', { fillerId: env('STAND_FILLER_ID'), orderHash: other.orderHash, requestId, order: other.order, replyBy: Date.now() + 10_000 });
    await until('the reconfirm to this filler refused', async () => (await eventsAfter(STREAMS.quotes, from, (e) => e.kind === 'command.rejected' && e.data.kind === 'quote.reconfirm'))[0], 30_000);
    await sleep(10_000);
    expect(reconfirms.filter((r) => r.orderHash.toLowerCase() === other.orderHash)).toHaveLength(0);
    const replies = await eventsAfter(STREAMS.quotes, from, (e) => ofOrder(other.orderHash)(e) && e.kind === 'quote.reconfirm.reply' && e.data.fillerId === env('STAND_FILLER_ID'));
    expect(replies).toHaveLength(0);
  }, 120_000);
});
