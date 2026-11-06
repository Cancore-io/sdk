/**
 * CAN-1861, the ticket desk against the real filler-gateway of the intent stand: the hook's declines, the checks
 * of an issued EVM-form ticket that refuse it, an offer delivered twice, a hook that never answers, a foreign
 * ticket signature and the expiries. trading is played on the Redis Streams (test/stand/filler-gateway.ts); the
 * full path to the receipt is TC-SDK-1861-INT-01 in canton-delivery.stand.int.test.ts.
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/CAN-1861-tickets.stand.int.test.ts
 */
import { FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, fillerIdHash, type Hex, type TicketIntentMessage } from '@cancore/contracts';
import { hashOrder } from '../src/filler/chain/hashes';
import { OFFER_DECLINE_REASONS, type TicketOfferDecision } from '../src/filler/tickets/desk';
import { createTestTypedDataSigner } from '../src/filler/testing';
import { env } from './stand/canton-ledger';
import { command, cursor, eventsAfter, GATEWAY_KEYS, httpRpc, offerCommand, ofOrder, sleep, standChain, standFiller, standOrder, standRouter, standSuite, STREAMS, until, type StandFiller, type StandFillerOptions } from './stand/filler-gateway';

/** The stand's ticket signer: anvil's default mnemonic, index 16 (TICKETSIGNER of the runbook) — a test key. */
const STAND_TICKET_SIGNER_KEY: Hex = '0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0';
/** Any other key: what filler-gateway must not pass off as Cancore's. */
const FOREIGN_KEY: Hex = `0x${'4d'.repeat(32)}`;

standSuite('CAN-1861: the ticket desk against the real filler-gateway', GATEWAY_KEYS, () => {
  const decisions = new Map<Hex, () => Promise<TicketOfferDecision>>();
  const asked = new Map<Hex, number>();
  const offerHook: StandFillerOptions['offer'] = async (offer) => {
    const orderHash = offer.orderHash.toLowerCase() as Hex;
    asked.set(orderHash, (asked.get(orderHash) ?? 0) + 1);
    return (decisions.get(orderHash) ?? (async () => 'accept'))();
  };
  let stand: StandFiller;

  const ticket = (s: StandFiller, orderHash: Hex, attempt = 0) => s.store.withOrder(orderHash, (tx) => tx.getTicket(attempt));
  const declined = (orderHash: Hex, from: string) =>
    until('ticket.declined at filler-gateway', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(orderHash)(e) && e.kind === 'ticket.declined'))[0], 60_000, () => stand?.diagnostics() ?? '');

  /** An EVM → EVM order on the stand chain, EVM-form ticket: what the SDK reads on the stand router. */
  const evmOrder = (salt: number) => {
    const { nowS, order: base } = standOrder(salt);
    const order = {
      ...base,
      destination: `0x${BigInt(env('EVM_CHAIN_ID')).toString(16).padStart(64, '0')}` as Hex,
      outputAsset: `0x${'00'.repeat(12)}${env('INPUT_TOKEN_ADDRESS').slice(2).toLowerCase()}` as Hex,
      recipient: `0x${'00'.repeat(12)}${'61'.repeat(20)}` as Hex,
    };
    return { nowS, order, orderHash: hashOrder(order, { chainId: BigInt(env('EVM_CHAIN_ID')), router: standRouter() }) };
  };

  /** Offers an EVM-form ticket of `o`, waits for the intent ack, issues it signed by `signerKey`; returns the cursor. */
  async function issueEvm(s: StandFiller, o: { order: ReturnType<typeof standOrder>['order']; orderHash: Hex; nowS: number }, signerKey: Hex) {
    const from = await cursor(STREAMS.ticketEvents);
    await command(STREAMS.tickets, 'ticket.offer', offerCommand(o, { destination: standChain(), form: 'evm' }));
    const acked = await until('the intent acked', async () => ((await ticket(s, o.orderHash))?.intentAck ? ticket(s, o.orderHash) : undefined), 60_000, s.diagnostics);
    const intent = acked!.intent as TicketIntentMessage;
    const fillTicket = {
      orderHash: o.orderHash, fillerId: fillerIdHash(env('STAND_FILLER_ID')), deliveryKey: intent.deliveryKey, repayTo: intent.repayTo, attempt: 0, validFrom: String(o.nowS), validUntil: String(o.nowS + 900),
    };
    const ticketSig = await createTestTypedDataSigner(signerKey).signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: fillTicket });
    await command(STREAMS.tickets, 'ticket.issue', { orderHash: o.orderHash, attempt: 0, ticketSig, deliveryKey: intent.deliveryKey, repayTo: intent.repayTo });
    return from;
  }
  describe('one filler pinned to the stand', () => {
    beforeAll(async () => {
      expect(env('TICKET_SIGNERS').toLowerCase()).toContain(createTestTypedDataSigner(STAND_TICKET_SIGNER_KEY).address.toLowerCase());
      stand = standFiller({ offer: offerHook });
      await stand.filler.start();
    }, 120_000);
    afterAll(async () => {
      await stand?.filler.stop();
    });

    test.each(OFFER_DECLINE_REASONS.map((r, i) => [r, i] as const))('TC-SDK-1861-INT-02: the hook declines with %s — ticket.decline reaches filler-gateway with it, no intent', async (reason, i) => {
      const o = standOrder(100 + i);
      decisions.set(o.orderHash, async () => ({ decline: reason }));
      const from = await cursor(STREAMS.ticketEvents);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason });
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.intent');
      expect(await ticket(stand, o.orderHash)).toMatchObject({ state: 'declined' });
    }, 120_000);

    test('TC-SDK-1861-INT-03: an issued EVM-form ticket of an order never opened — V-E2 refuses ESCROW_NOT_OPEN, the decline reaches filler-gateway, no receipt', async () => {
      const o = evmOrder(110);
      const from = await issueEvm(stand, o, STAND_TICKET_SIGNER_KEY);
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason: 'ESCROW_NOT_OPEN' });
      const kinds = (await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(['ticket.offered', 'ticket.intent', 'ticket.issued', 'ticket.declined']));
      expect(kinds).not.toContain('ticket.receipt');
    }, 120_000);

    test('TC-SDK-1861-INT-05: a ticket signed by a key filler-gateway does not hold is refused there and never reaches the SDK', async () => {
      const o = evmOrder(111);
      const from = await issueEvm(stand, o, FOREIGN_KEY);
      const refused = await until('the issue refused', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(o.orderHash)(e) && /refused$/.test(e.kind)))[0], 30_000, stand.diagnostics);
      expect(refused.kind).toMatch(/^ticket\.issue/);
      await sleep(3_000);
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.issued');
      expect((await ticket(stand, o.orderHash))?.state).toBe('intent-acked');
    }, 120_000);

    test('TC-SDK-1861-INT-06: the same offer delivered twice — one hook call, one intent', async () => {
      const o = standOrder(112);
      const from = await cursor(STREAMS.ticketEvents);
      const offer = offerCommand(o);
      await command(STREAMS.tickets, 'ticket.offer', offer);
      await command(STREAMS.tickets, 'ticket.offer', offer);
      await until('the intent acked', async () => ((await ticket(stand, o.orderHash))?.intentAck ? true : undefined), 60_000, stand.diagnostics);
      await sleep(3_000);
      expect(asked.get(o.orderHash)).toBe(1);
      const kinds = (await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind);
      expect(kinds.filter((k) => k === 'ticket.offered')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'ticket.intent')).toHaveLength(1);
    }, 120_000);

    test('TC-SDK-1861-INT-08: a hook that never answers — the SDK declines OTHER in time, and filler-gateway takes the decline', async () => {
      const o = standOrder(113);
      decisions.set(o.orderHash, () => new Promise<TicketOfferDecision>(() => undefined));
      const from = await cursor(STREAMS.ticketEvents);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o, { acceptBy: Date.now() + 8_000 }));
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason: 'OTHER' });
      expect((await ticket(stand, o.orderHash))?.state).toBe('declined');
    }, 120_000);

    test.each(['FILLED', 'NO_SHOW'])('TC-SDK-1861-INT-09: ticket.expired %s — the SDK records the attempt expired with the result', async (result) => {
      const o = standOrder(result === 'FILLED' ? 114 : 115);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
      await until('the intent acked', async () => ((await ticket(stand, o.orderHash))?.intentAck ? true : undefined), 60_000, stand.diagnostics);
      await command(STREAMS.tickets, 'ticket.expire', { orderHash: o.orderHash, attempt: 0, result });
      const expired = await until('expired', async () => {
        const t = await ticket(stand, o.orderHash);
        return t?.state === 'expired' ? t : undefined;
      }, 60_000, stand.diagnostics);
      expect(expired.expired).toMatchObject({ result });
      expect(stand.events.events.some((e) => e.type === 'stage' && e.stage === 'ticket.expired' && e.orderHash === o.orderHash && e.detail?.result === result)).toBe(true);
    }, 120_000);
  });

  test('TC-SDK-1861-INT-03: a filler that pins another ticket signer — the stand-signed ticket is refused TICKET_SIGNER_UNKNOWN, no receipt', async () => {
    const pinnedElsewhere = standFiller({ offer: offerHook, ticketSigners: [createTestTypedDataSigner(FOREIGN_KEY).address] });
    stand = pinnedElsewhere;
    await pinnedElsewhere.filler.start();
    try {
      const o = evmOrder(120);
      const from = await issueEvm(pinnedElsewhere, o, STAND_TICKET_SIGNER_KEY);
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason: 'TICKET_SIGNER_UNKNOWN' });
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.receipt');
    } finally {
      await pinnedElsewhere.filler.stop();
    }
  }, 180_000);

  test('TC-SDK-1861-INT-04: the chain RPC is a closed port — the checks cannot read, the ticket is declined, no receipt', async () => {
    const blind = standFiller({ offer: offerHook, rpc: [httpRpc('http://127.0.0.1:9')] });
    stand = blind;
    await blind.filler.start();
    try {
      const o = evmOrder(121);
      const from = await issueEvm(blind, o, STAND_TICKET_SIGNER_KEY);
      await declined(o.orderHash, from);
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.receipt');
      expect((await ticket(blind, o.orderHash))?.state).toBe('declined');
    } finally {
      await blind.filler.stop();
    }
  }, 180_000);
});
