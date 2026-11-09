/**
 * CAN-1852, quotes against the real filler-gateway of the intent stand: the payout the hook is handed, the signed
 * quote filler-gateway counts, the requests the SDK leaves unquoted, the boundary of `validUntil`, and reconfirms —
 * at the same price, at a changed one, and after a restart on the same store. trading is played on the Redis
 * Streams (test/stand/filler-gateway.ts): `quote.request` and `quote.reconfirm` in, `quote.received` and
 * `quote.reconfirm.reply` out.
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/CAN-1852-quotes.stand.int.test.ts
 */
import { encodeCantonAmount, type Hex } from '@cancore/contracts';
import { RouterReader } from '../src/filler/chain/router';
import { ChainClient } from '../src/filler/chain/client';
import type { FillerQuoteRequest, FillerReconfirm } from '../src/filler/quotes';
import { InMemoryFillerStore } from '../src/filler/testing';
import { env } from './stand/canton-ledger';
import { command, cursor, eventsAfter, GATEWAY_KEYS, httpRpc, sleep, standChain, standFiller, standOrder, standRouter, standSuite, STREAMS, until, type StandFiller } from './stand/filler-gateway';

const QUOTE_TTL_MS = 30_000;
const AMOUNT_OUT = encodeCantonAmount('5');

standSuite('CAN-1852: quotes against the real filler-gateway', GATEWAY_KEYS, () => {
  const requests = new Map<string, FillerQuoteRequest>();
  /** What the hook answers per requestId: `validUntil` in unix s, or null for no quote. */
  const answers = new Map<string, (r: FillerQuoteRequest) => { amountOut: bigint; validUntil: bigint } | null>();
  const reconfirms: FillerReconfirm[] = [];
  const store = new InMemoryFillerStore();
  let stand: StandFiller;
  let counter = 0;

  const start = async () => {
    stand = standFiller({
      store,
      quote: async (r) => {
        requests.set(r.requestId, r);
        const answer = answers.get(r.requestId);
        return answer ? answer(r) : { amountOut: AMOUNT_OUT, validUntil: BigInt(Math.ceil((r.windowCloseAt + r.quoteTtlMs) / 1000) + 60) };
      },
      // Stands behind the price it quoted, and no other (T-20).
      reconfirm: async (r) => {
        reconfirms.push(r);
        return BigInt(r.amountOut) === AMOUNT_OUT;
      },
    });
    await stand.filler.start();
  };
  beforeAll(start, 120_000);
  afterAll(async () => {
    await stand?.filler.stop();
  });

  /** A `quote.request` to this filler alone, its window closing on a whole second. */
  async function request(over: { inputAmount?: string; windowCloseAt?: number } = {}) {
    const requestId = `can-1852-${Date.now().toString(36)}-${++counter}`;
    const windowCloseAt = over.windowCloseAt ?? Math.ceil(Date.now() / 1000) * 1000 + 8_000;
    const from = await cursor(STREAMS.quotes);
    const body = {
      requestId,
      route: { src: standChain(), dst: env('CANTON_CHAIN') },
      inputToken: env('INPUT_TOKEN_ADDRESS').toLowerCase(),
      inputAmount: over.inputAmount ?? '1050000000000000000',
      outputAsset: { admin: env('CNRX_ADMIN_PARTY'), id: 'CNRX' },
      feeBps: 500,
      fillDeadlineHint: String(Math.floor(Date.now() / 1000) + 1_800),
      windowCloseAt,
      quoteTtlMs: QUOTE_TTL_MS,
      fillerIds: [env('STAND_FILLER_ID')],
    };
    return { requestId, windowCloseAt, from, send: () => command(STREAMS.quoteRequests, 'quote.request', body) };
  }
  const received = (requestId: string, from: string) => eventsAfter(STREAMS.quotes, from, (e) => e.kind === 'quote.received' && e.data.requestId === requestId);
  const skipped = (requestId: string) => stand.events.events.find((e) => e.type === 'stage' && e.stage === 'quote.skipped' && (e as { requestId?: string }).requestId === requestId);

  let firstQuote: { requestId: string; nonce: bigint } | undefined;

  test('TC-SDK-1852-INT-01: T = 1.05e18 at feeBps 500 — the hook is handed payout 1e18; the signed quote is COUNTED by filler-gateway and stored with its ack', async () => {
    const r = await request();
    await r.send();
    const quote = await until('quote.received', async () => (await received(r.requestId, r.from))[0], 30_000, stand.diagnostics);
    expect(requests.get(r.requestId)).toMatchObject({ payout: 10n ** 18n, fee: 5n * 10n ** 16n, feeBps: 500 });
    expect(quote.data).toMatchObject({ fillerId: env('STAND_FILLER_ID'), amountOut: AMOUNT_OUT.toString(), status: 'COUNTED' });
    expect(String(quote.data.sig)).toMatch(/^0x[0-9a-f]{130}$/);
    const stored = await until('the ack on the stored quote', async () => {
      const quotes = await store.quotes.listQuotes(r.requestId);
      return quotes.length === 1 && quotes[0]!.ack ? quotes : undefined;
    }, 15_000, stand.diagnostics);
    expect(stored[0]!.quoteHash).toBe(String(quote.data.quoteHash).toLowerCase());
    firstQuote = { requestId: r.requestId, nonce: BigInt(String(quote.data.nonce)) };
  }, 120_000);

  test('TC-SDK-1852-INT-02: a reconfirm at the quoted price — accepted, signed, with a nonce above the quote’s', async () => {
    if (!firstQuote) throw new Error('TC-SDK-1852-INT-01 left no quote');
    const o = standOrder(1852_02);
    const order = { ...o.order, minReceived: AMOUNT_OUT.toString() };
    const from = await cursor(STREAMS.quotes);
    await command(STREAMS.quoteRequests, 'quote.reconfirm', { fillerId: env('STAND_FILLER_ID'), orderHash: o.orderHash, requestId: firstQuote.requestId, order, replyBy: Date.now() + 15_000 });
    const reply = await until('quote.reconfirm.reply', async () => (await eventsAfter(STREAMS.quotes, from, (e) => e.kind === 'quote.reconfirm.reply' && e.data.orderHash === o.orderHash))[0], 30_000, stand.diagnostics);
    expect(reply.data).toMatchObject({ accept: true, amountOut: AMOUNT_OUT.toString() });
    expect(BigInt(String(reply.data.nonce))).toBeGreaterThan(firstQuote.nonce);
    firstQuote = { ...firstQuote, nonce: BigInt(String(reply.data.nonce)) };
  }, 120_000);

  test('TC-SDK-1852-INT-03: nothing is quoted — the window already closed, validUntil one second short, below the router’s minInput, the hook answers null', async () => {
    const minInput = await new RouterReader(standChain(), standRouter(), new ChainClient({ chain: standChain(), endpoints: [httpRpc(env('EVM_RPC_URL'))], maxHeadLagBlocks: 5, logger: stand.logger })).minInput(env('INPUT_TOKEN_ADDRESS').toLowerCase() as Hex);
    expect(minInput).toBeGreaterThan(0n);

    const late = await request({ windowCloseAt: Date.now() - 1_000 });
    const short = await request();
    answers.set(short.requestId, (q) => ({ amountOut: AMOUNT_OUT, validUntil: BigInt((q.windowCloseAt + q.quoteTtlMs) / 1000 - 1) }));
    const below = await request({ inputAmount: (minInput - 1n).toString() });
    const none = await request();
    answers.set(none.requestId, () => null);
    for (const r of [late, short, below, none]) await r.send();
    await sleep(15_000);
    for (const r of [late, short, below, none]) expect(await received(r.requestId, r.from)).toEqual([]);
    expect(skipped(short.requestId)).toMatchObject({ detail: expect.objectContaining({ reason: 'short-ttl' }) });
    expect(skipped(below.requestId)).toMatchObject({ detail: expect.objectContaining({ reason: 'below-min-input' }) });
    expect(skipped(none.requestId)).toMatchObject({ detail: expect.objectContaining({ reason: 'declined' }) });
    expect(requests.has(below.requestId)).toBe(false);
  }, 120_000);

  test('TC-SDK-1852-INT-04: a reconfirm at a changed price — declined, no signature, no nonce', async () => {
    if (!firstQuote) throw new Error('TC-SDK-1852-INT-01 left no quote');
    const o = standOrder(1852_04);
    const order = { ...o.order, minReceived: (AMOUNT_OUT + 1n).toString() };
    const from = await cursor(STREAMS.quotes);
    await command(STREAMS.quoteRequests, 'quote.reconfirm', { fillerId: env('STAND_FILLER_ID'), orderHash: o.orderHash, requestId: firstQuote.requestId, order, replyBy: Date.now() + 15_000 });
    const reply = await until('quote.reconfirm.reply', async () => (await eventsAfter(STREAMS.quotes, from, (e) => e.kind === 'quote.reconfirm.reply' && e.data.orderHash === o.orderHash))[0], 30_000, stand.diagnostics);
    expect(reply.data.accept).toBe(false);
    expect(reply.data.sig).toBeUndefined();
    expect(reply.data.nonce).toBeUndefined();
  }, 120_000);

  test('TC-SDK-1852-INT-05: after a restart on the same store, a reconfirm of the same request is signed with a nonce above every earlier one', async () => {
    if (!firstQuote) throw new Error('TC-SDK-1852-INT-01 left no quote');
    await stand.filler.stop();
    await start();
    const o = standOrder(1852_05);
    const order = { ...o.order, minReceived: AMOUNT_OUT.toString() };
    const from = await cursor(STREAMS.quotes);
    await command(STREAMS.quoteRequests, 'quote.reconfirm', { fillerId: env('STAND_FILLER_ID'), orderHash: o.orderHash, requestId: firstQuote.requestId, order, replyBy: Date.now() + 15_000 });
    const reply = await until('quote.reconfirm.reply', async () => (await eventsAfter(STREAMS.quotes, from, (e) => e.kind === 'quote.reconfirm.reply' && e.data.orderHash === o.orderHash))[0], 30_000, stand.diagnostics);
    expect(reply.data.accept).toBe(true);
    expect(BigInt(String(reply.data.nonce))).toBeGreaterThan(firstQuote.nonce);
  }, 180_000);

  test('TC-SDK-1852-INT-06: validUntil × 1000 exactly windowCloseAt + quoteTtlMs counts; a request without imbalanceHint reaches the hook without one', async () => {
    const r = await request();
    answers.set(r.requestId, (q) => ({ amountOut: AMOUNT_OUT, validUntil: BigInt((q.windowCloseAt + q.quoteTtlMs) / 1000) }));
    await r.send();
    const quote = await until('quote.received', async () => (await received(r.requestId, r.from))[0], 30_000, stand.diagnostics);
    expect(quote.data).toMatchObject({ status: 'COUNTED', validUntil: String((r.windowCloseAt + QUOTE_TTL_MS) / 1000) });
    expect(requests.get(r.requestId)).not.toHaveProperty('imbalanceHint');
  }, 120_000);
});
