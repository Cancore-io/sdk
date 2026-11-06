/**
 * CAN-2151, the signed envelope against the real filler-gateway of the intent stand: every frame the SDK seals —
 * `quote`, `ticket.intent`, `ticket.decline`, `routes.set` — is taken by filler-gateway (none comes back
 * BAD_SIGNATURE); frames signed by a key the SDK does not pin are dropped before any hook; and a ticket issued for
 * another delivery key than the SDK's own intent is refused by filler-gateway and never reaches the checks.
 * `ticket.receipt` is TC-SDK-2151-INT-01 in canton-delivery.stand.int.test.ts. trading is played on the Redis
 * Streams (test/stand/filler-gateway.ts).
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/CAN-2151-envelope.stand.int.test.ts
 */
import { encodeCantonAmount, FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, fillerIdHash, type Hex, type TicketIntentMessage } from '@cancore/contracts';
import { createFillerRoutes } from '../src/filler/routes';
import { createTestTypedDataSigner } from '../src/filler/testing';
import { env } from './stand/canton-ledger';
import { command, cursor, eventsAfter, GATEWAY_KEYS, offerCommand, ofOrder, sleep, standChain, standFiller, standOrder, standSuite, STREAMS, until } from './stand/filler-gateway';

/** The stand's ticket signer: anvil's default mnemonic, index 16 (TICKETSIGNER of the runbook) — a test key. */
const STAND_TICKET_SIGNER_KEY: Hex = '0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0';

standSuite('CAN-2151: the signed envelope against the real filler-gateway', GATEWAY_KEYS, () => {
  test('TC-SDK-2151-INT-01: quote, ticket.intent, ticket.decline and routes.set sealed by the SDK are each taken by filler-gateway', async () => {
    const accept = standOrder(2151_01);
    const decline = standOrder(2151_02);
    const stand = standFiller({
      quote: async (r) => ({ amountOut: encodeCantonAmount('5'), validUntil: BigInt(Math.ceil((r.windowCloseAt + r.quoteTtlMs) / 1000) + 60) }),
      offer: async (o) => (o.orderHash.toLowerCase() === accept.orderHash ? 'accept' : { decline: 'RISK_LIMIT' }),
    });
    await stand.filler.start();
    try {
      const fromQuotes = await cursor(STREAMS.quotes);
      const fromTickets = await cursor(STREAMS.ticketEvents);
      const requestId = `can-2151-${Date.now().toString(36)}`;
      await command(STREAMS.quoteRequests, 'quote.request', {
        requestId, route: { src: standChain(), dst: env('CANTON_CHAIN') }, inputToken: env('INPUT_TOKEN_ADDRESS').toLowerCase(), inputAmount: '1050000000000000000',
        outputAsset: { admin: env('CNRX_ADMIN_PARTY'), id: 'CNRX' }, feeBps: 30, fillDeadlineHint: String(Math.floor(Date.now() / 1000) + 1_800),
        windowCloseAt: Date.now() + 8_000, quoteTtlMs: 30_000, fillerIds: [env('STAND_FILLER_ID')],
      });
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(accept));
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(decline));

      await until('quote.received', async () => (await eventsAfter(STREAMS.quotes, fromQuotes, (e) => e.kind === 'quote.received' && e.data.requestId === requestId))[0], 30_000, stand.diagnostics);
      await until('ticket.intent', async () => (await eventsAfter(STREAMS.ticketEvents, fromTickets, (e) => ofOrder(accept.orderHash)(e) && e.kind === 'ticket.intent'))[0], 30_000, stand.diagnostics);
      await until('ticket.declined', async () => (await eventsAfter(STREAMS.ticketEvents, fromTickets, (e) => ofOrder(decline.orderHash)(e) && e.kind === 'ticket.declined'))[0], 30_000, stand.diagnostics);
      const routes = createFillerRoutes({ gatewayUrl: env('FILLER_GATEWAY_WS_URL'), fillerId: env('STAND_FILLER_ID'), gatewaySigner: env('FILLER_GATEWAY_SIGNER') as Hex, messageSigner: createTestTypedDataSigner(env('STAND_FILLER_MESSAGE_KEY') as Hex) });
      const before = await routes.state();
      const after = await routes.set(before.routes.filter((r) => r.active).map(({ src, dst }) => ({ src, dst })));
      expect(after.routes).toEqual(before.routes);
      expect(stand.logger.entries.filter((l) => JSON.stringify(l).includes('BAD_SIGNATURE'))).toEqual([]);
    } finally {
      await stand.filler.stop();
    }
  }, 180_000);

  test('TC-SDK-2151-INT-02: the SDK pins another filler-gateway key — the stand’s signed frames are dropped: no session, the offer never reaches the hook', async () => {
    let asked = 0;
    const stand = standFiller({ gatewaySigner: createTestTypedDataSigner(`0x${'6a'.repeat(32)}`).address, offer: async () => (asked++, 'accept') });
    const started = stand.filler.start().then(() => 'started' as const, () => 'refused' as const);
    try {
      expect(await Promise.race([started, sleep(15_000).then(() => 'not-started' as const)])).not.toBe('started');
      const o = standOrder(2151_03);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
      await sleep(10_000);
      expect(asked).toBe(0);
      expect(await stand.store.withOrder(o.orderHash, (tx) => tx.getTicket(0))).toBeUndefined();
      expect(stand.logger.entries.some((l) => /verif/i.test(`${l.message} ${JSON.stringify(l.fields ?? {})}`))).toBe(true);
    } finally {
      await stand.filler.stop();
    }
  }, 120_000);

  test('TC-SDK-2151-INT-04: an issue naming another delivery key than the SDK’s intent — refused by filler-gateway; the SDK never sees ticket.issued', async () => {
    const stand = standFiller({ offer: async () => 'accept' });
    await stand.filler.start();
    try {
      const base = standOrder(2151_04);
      const o = { ...base, order: { ...base.order } };
      const from = await cursor(STREAMS.ticketEvents);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
      const acked = await until('the intent acked', async () => {
        const t = await stand.store.withOrder(o.orderHash, (tx) => tx.getTicket(0));
        return t?.intentAck ? t : undefined;
      }, 60_000, stand.diagnostics);
      const intent = acked.intent as TicketIntentMessage;
      const otherKey = '0x00000000000000000000000000000000000c2151' as Hex;
      const ticket = { orderHash: o.orderHash, fillerId: fillerIdHash(env('STAND_FILLER_ID')), deliveryKey: otherKey, repayTo: intent.repayTo, attempt: 0, validFrom: String(o.nowS), validUntil: String(o.nowS + 900) };
      const ticketSig = await createTestTypedDataSigner(STAND_TICKET_SIGNER_KEY).signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
      await command(STREAMS.tickets, 'ticket.issue', { orderHash: o.orderHash, attempt: 0, ticketSig, deliveryKey: otherKey, repayTo: intent.repayTo });
      await until('the issue refused', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(o.orderHash)(e) && e.kind === 'ticket.issue.refused'))[0], 30_000, stand.diagnostics);
      await sleep(3_000);
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.issued');
      expect((await stand.store.withOrder(o.orderHash, (tx) => tx.getTicket(0)))?.state).toBe('intent-acked');
    } finally {
      await stand.filler.stop();
    }
  }, 120_000);
});
