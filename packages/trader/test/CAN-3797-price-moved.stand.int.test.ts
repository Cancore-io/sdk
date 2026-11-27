/**
 * CAN-3797, price-moved declines against the real filler-gateway of the intent stand: a hook that refuses an order
 * only because its price moved answers PRICE_MOVED with its mid and shift, and the SDK puts that claim on the signed
 * decline — a declining `quote.reconfirm.reply` and a `ticket.decline` at stage «offer». filler-gateway verifies the
 * envelope over the claim and takes the decline; a claim the protocol does not accept is dropped and the decline goes
 * plain. trading is played on the Redis Streams (test/stand/filler-gateway.ts).
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/CAN-3797-price-moved.stand.int.test.ts
 */
import { encodeCantonAmount, type Hex, type QuoteReconfirmReply, type TicketDecline } from '@cancore/contracts';
import type { ReconfirmDecision } from '../src/filler/price-moved';
import type { TicketOfferDecision } from '../src/filler/tickets/desk';
import { InMemoryFillerStore } from '../src/filler/testing';
import type { WebSocketFactory } from '../src/filler/runtime';
import { env } from './stand/canton-ledger';
import { command, cursor, eventsAfter, GATEWAY_KEYS, nativeWebSocket, offerCommand, ofOrder, standChain, standFiller, standOrder, standSuite, STREAMS, until, type StandFiller } from './stand/filler-gateway';

const AMOUNT_OUT = encodeCantonAmount('5');
const MID_E18 = 998_500_000_000_000_000n;

standSuite('CAN-3797: price-moved declines against the real filler-gateway', GATEWAY_KEYS, () => {
  const reconfirmAnswers = new Map<Hex, ReconfirmDecision>();
  const offerAnswers = new Map<Hex, TicketOfferDecision>();
  const store = new InMemoryFillerStore();
  let stand: StandFiller;
  let requestId: string | undefined;
  /** Every frame the SDK put on the socket to filler-gateway: what is asserted is what went on the wire. */
  const wire: Record<string, unknown>[] = [];
  const recording: WebSocketFactory = (url, handlers, protocols) => {
    const socket = nativeWebSocket(url, handlers, protocols);
    return {
      send: (text: string) => {
        wire.push(JSON.parse(text) as Record<string, unknown>);
        socket.send(text);
      },
      close: (code?: number, reason?: string) => socket.close(code, reason),
    };
  };

  beforeAll(async () => {
    stand = standFiller({
      store,
      quote: async (r) => ({ amountOut: AMOUNT_OUT, validUntil: BigInt(Math.ceil((r.windowCloseAt + r.quoteTtlMs) / 1000) + 60) }),
      reconfirm: async (r) => reconfirmAnswers.get(r.orderHash.toLowerCase() as Hex) ?? true,
      offer: async (o) => offerAnswers.get(o.orderHash.toLowerCase() as Hex) ?? 'accept',
      webSocket: recording,
    });
    await stand.filler.start();
    requestId = await quoted();
  }, 120_000);
  afterAll(async () => {
    await stand?.filler.stop();
  });

  /** A counted quote of this filler: a reconfirm names its request. */
  async function quoted(): Promise<string> {
    const id = `can-3797-${Date.now().toString(36)}`;
    const from = await cursor(STREAMS.quotes);
    await command(STREAMS.quoteRequests, 'quote.request', {
      requestId: id,
      route: { src: standChain(), dst: env('CANTON_CHAIN') },
      inputToken: env('INPUT_TOKEN_ADDRESS').toLowerCase(),
      inputAmount: '1050000000000000000',
      outputAsset: { admin: env('CNRX_ADMIN_PARTY'), id: 'CNRX' },
      feeBps: 500,
      fillDeadlineHint: String(Math.floor(Date.now() / 1000) + 1_800),
      windowCloseAt: Math.ceil(Date.now() / 1000) * 1000 + 8_000,
      quoteTtlMs: 30_000,
      fillerIds: [env('STAND_FILLER_ID')],
    });
    await until('quote.received', async () => (await eventsAfter(STREAMS.quotes, from, (e) => e.kind === 'quote.received' && e.data.requestId === id))[0], 30_000, stand.diagnostics);
    return id;
  }

  /** The declining reply the SDK signed and sent, and filler-gateway's event for it. */
  async function reconfirmReply(seed: number, answer: ReconfirmDecision): Promise<{ event: Record<string, unknown>; sent: Partial<QuoteReconfirmReply> }> {
    if (!requestId) throw new Error('no counted quote to reconfirm');
    const o = standOrder(seed);
    reconfirmAnswers.set(o.orderHash, answer);
    const from = await cursor(STREAMS.quotes);
    await command(STREAMS.quoteRequests, 'quote.reconfirm', { fillerId: env('STAND_FILLER_ID'), orderHash: o.orderHash, requestId, order: { ...o.order, minReceived: AMOUNT_OUT.toString() }, replyBy: Date.now() + 15_000 });
    const event = await until('quote.reconfirm.reply', async () => (await eventsAfter(STREAMS.quotes, from, (e) => e.kind === 'quote.reconfirm.reply' && e.data.orderHash === o.orderHash))[0], 30_000, stand.diagnostics);
    const sent = wire.find((f) => f.type === 'quote.reconfirm.reply' && String(f.orderHash).toLowerCase() === o.orderHash);
    if (!sent) throw new Error('no quote.reconfirm.reply went on the wire');
    return { event: event.data, sent: sent as Partial<QuoteReconfirmReply> };
  }

  test('TC-SDK-3797-INT-01: the reconfirm hook answers PRICE_MOVED — the signed decline carries reason, midE18 and shiftBps, and filler-gateway takes it', async () => {
    const { event, sent } = await reconfirmReply(3797_01, { decline: 'PRICE_MOVED', midE18: MID_E18, shiftBps: 12 });
    expect(event.accept).toBe(false);
    expect(sent).toMatchObject({ reason: 'PRICE_MOVED', midE18: MID_E18.toString(), shiftBps: 12 });
  }, 120_000);

  test('TC-SDK-3797-INT-02: a plain reconfirm decline carries no reason and no claim', async () => {
    const { event, sent } = await reconfirmReply(3797_02, false);
    expect(event.accept).toBe(false);
    expect(sent.reason).toBeUndefined();
    expect(sent.midE18).toBeUndefined();
    expect(sent.shiftBps).toBeUndefined();
  }, 120_000);

  test('TC-SDK-3797-INT-03: a claim that is no int32 shift is dropped — the reconfirm decline still goes, PRICE_MOVED without a claim', async () => {
    const { sent } = await reconfirmReply(3797_03, { decline: 'PRICE_MOVED', midE18: MID_E18, shiftBps: 1.5 });
    expect(sent).toMatchObject({ reason: 'PRICE_MOVED' });
    expect(sent.midE18).toBeUndefined();
    expect(sent.shiftBps).toBeUndefined();
  }, 120_000);

  async function offerDecline(seed: number, answer: TicketOfferDecision): Promise<{ event: Record<string, unknown>; sent: TicketDecline }> {
    const o = standOrder(seed);
    offerAnswers.set(o.orderHash, answer);
    const from = await cursor(STREAMS.ticketEvents);
    await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
    const event = await until('ticket.declined at filler-gateway', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(o.orderHash)(e) && e.kind === 'ticket.declined'))[0], 60_000, stand.diagnostics);
    const sent = (await stand.store.withOrder(o.orderHash, (tx) => tx.getTicket(0)))?.decline as TicketDecline | undefined;
    if (!sent) throw new Error('no decline stored for the offer');
    return { event: event.data, sent };
  }

  test('TC-SDK-3797-INT-04: the offer hook declines PRICE_MOVED with its claim — ticket.decline carries it at stage offer and filler-gateway takes it', async () => {
    const { event, sent } = await offerDecline(3797_04, { decline: 'PRICE_MOVED', detail: 'amountOut above the payout at the mid', midE18: MID_E18, shiftBps: 40 });
    expect(event).toMatchObject({ reason: 'PRICE_MOVED', stage: 'offer' });
    expect(sent).toMatchObject({ reason: 'PRICE_MOVED', midE18: MID_E18.toString(), shiftBps: 40 });
  }, 120_000);

  test('TC-SDK-3797-INT-05: a claim on another reason is not sent — NO_INVENTORY goes without midE18 and shiftBps', async () => {
    // A hook outside the type (plain JS) may still put a claim on another reason.
    const { event, sent } = await offerDecline(3797_05, { decline: 'NO_INVENTORY', midE18: MID_E18, shiftBps: 40 } as unknown as TicketOfferDecision);
    expect(event).toMatchObject({ reason: 'NO_INVENTORY' });
    expect(sent.midE18).toBeUndefined();
    expect(sent.shiftBps).toBeUndefined();
  }, 120_000);
});
