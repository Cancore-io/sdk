/**
 * BUG-1396, a quote and the window of its request against the real filler-gateway of the intent stand: the
 * router's minInput read runs beside the hook, not before it; a second request reads no minInput from the chain;
 * and a quote that would reach filler-gateway after `windowCloseAt` is not sent but logged `late`. The RPC is
 * the stand's anvil behind a wrapper that counts the router's minInput calls and can hold them back, as a cold
 * RPC pool does. trading is played on the Redis Streams (test/stand/filler-gateway.ts).
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/BUG-1396-quote-window.stand.int.test.ts
 */
import { encodeCantonAmount } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { FillerQuoteRequest } from '../src/filler/quotes';
import type { EvmRpc, EvmRpcRequest } from '../src/filler/rpc';
import type { StoredQuote } from '../src/filler/store';
import { InMemoryFillerStore } from '../src/filler/testing';
import { env } from './stand/canton-ledger';
import { command, cursor, eventsAfter, GATEWAY_KEYS, httpRpc, sleep, standChain, standFiller, standRouter, standSuite, STREAMS, until, type StandFiller } from './stand/filler-gateway';

const QUOTE_TTL_MS = 30_000;
const AMOUNT_OUT = encodeCantonAmount('5');
/** dev quotes in 3 s windows (`intent_route_quote_params.window_ms`); one more second covers the stand's Redis hop. */
const WINDOW_MS = 4_000;
const MIN_INPUT_SELECTOR = `0x${bytesToHex(keccak_256(utf8ToBytes('minInput(address)'))).slice(0, 8)}`;

/** The stand's anvil, with the router's minInput calls counted and, while `minInputDelayMs` is set, held back. */
function minInputProbe(rpc: EvmRpc) {
  const probe = {
    calls: 0,
    minInputDelayMs: 0,
    rpc: {
      label: rpc.label,
      async request<T>(request: EvmRpcRequest): Promise<T> {
        const call = request.method === 'eth_call' ? (request.params?.[0] as { to?: string; data?: string } | undefined) : undefined;
        if (call?.to?.toLowerCase() === standRouter() && call.data?.startsWith(MIN_INPUT_SELECTOR)) {
          probe.calls++;
          if (probe.minInputDelayMs > 0) await sleep(probe.minInputDelayMs);
        }
        return rpc.request<T>(request);
      },
    } satisfies EvmRpc,
  };
  return probe;
}

interface Plan {
  hookDelayMs?: number;
  hookAnswersAtMs?: number;
  recordFinishesAtMs?: number;
}

standSuite('BUG-1396: the quote fits the request window', GATEWAY_KEYS, () => {
  const plans = new Map<string, Plan>();
  const store = new InMemoryFillerStore();
  const probe = minInputProbe(httpRpc(env('EVM_RPC_URL')));
  let stand: StandFiller;
  let counter = 0;

  const recordQuote = store.quotes.recordQuote.bind(store.quotes);
  store.quotes.recordQuote = async (quote: StoredQuote) => {
    const finishesAt = plans.get(quote.requestId)?.recordFinishesAtMs;
    if (finishesAt !== undefined) await sleep(Math.max(0, finishesAt - Date.now()));
    return recordQuote(quote);
  };

  beforeAll(async () => {
    stand = standFiller({
      store,
      rpc: [probe.rpc],
      quote: async (r: FillerQuoteRequest) => {
        const plan = plans.get(r.requestId) ?? {};
        if (plan.hookDelayMs !== undefined) await sleep(plan.hookDelayMs);
        if (plan.hookAnswersAtMs !== undefined) await sleep(Math.max(0, plan.hookAnswersAtMs - Date.now()));
        return { amountOut: AMOUNT_OUT, validUntil: BigInt(Math.ceil((r.windowCloseAt + r.quoteTtlMs) / 1000) + 60) };
      },
    });
    await stand.filler.start();
  }, 120_000);
  afterAll(async () => {
    await stand?.filler.stop();
  });

  async function request(plan: (windowCloseAt: number) => Plan = () => ({})) {
    const requestId = `bug-1396-${Date.now().toString(36)}-${++counter}`;
    const windowCloseAt = Date.now() + WINDOW_MS;
    plans.set(requestId, plan(windowCloseAt));
    const from = await cursor(STREAMS.quotes);
    const body = {
      requestId,
      route: { src: standChain(), dst: env('CANTON_CHAIN') },
      inputToken: env('INPUT_TOKEN_ADDRESS').toLowerCase(),
      inputAmount: '1050000000000000000',
      outputAsset: { admin: env('CNRX_ADMIN_PARTY'), id: 'CNRX' },
      feeBps: 500,
      fillDeadlineHint: String(Math.floor(Date.now() / 1000) + 1_800),
      windowCloseAt,
      quoteTtlMs: QUOTE_TTL_MS,
      fillerIds: [env('STAND_FILLER_ID')],
    };
    await command(STREAMS.quoteRequests, 'quote.request', body);
    return { requestId, windowCloseAt, from };
  }
  const received = (requestId: string, from: string) => eventsAfter(STREAMS.quotes, from, (e) => e.kind === 'quote.received' && e.data.requestId === requestId);
  const counted = (r: { requestId: string; from: string }) => until('quote.received', async () => (await received(r.requestId, r.from))[0], 30_000, stand.diagnostics);
  const logged = (message: string, requestId: string) => stand.logger.entries.find((l) => l.message === message && l.fields?.requestId === requestId)?.fields;

  test('TC-INT-1396-01: minInput read and hook each longer than half the window run side by side — the quote is COUNTED, elapsedMs < minInputMs + hookMs', async () => {
    probe.minInputDelayMs = WINDOW_MS / 2;
    try {
      const r = await request(() => ({ hookDelayMs: WINDOW_MS / 2 + 200 }));
      const quote = await counted(r);
      expect(quote.data).toMatchObject({ fillerId: env('STAND_FILLER_ID'), amountOut: AMOUNT_OUT.toString(), status: 'COUNTED' });
      const timings = logged('quotes: quote sent', r.requestId) as unknown as { minInputMs: number; hookMs: number; elapsedMs: number };
      expect(timings.minInputMs).toBeGreaterThanOrEqual(WINDOW_MS / 2);
      expect(timings.hookMs).toBeGreaterThanOrEqual(WINDOW_MS / 2 + 200);
      expect(timings.elapsedMs).toBeLessThan(timings.minInputMs + timings.hookMs);
    } finally {
      probe.minInputDelayMs = 0;
    }
  }, 120_000);

  test('TC-INT-1396-02: two requests in a row — the second reads no minInput from the chain and is COUNTED', async () => {
    const first = await request();
    expect((await counted(first)).data).toMatchObject({ status: 'COUNTED' });
    const callsBefore = probe.calls;
    const second = await request();
    expect((await counted(second)).data).toMatchObject({ status: 'COUNTED' });
    expect(probe.calls - callsBefore).toBe(0);
  }, 120_000);

  test('TC-INT-1396-03: the hook answers after windowCloseAt — nothing is sent, the request is logged late after the hook', async () => {
    const r = await request((closeAt) => ({ hookAnswersAtMs: closeAt + 300 }));
    await sleep(r.windowCloseAt + 5_000 - Date.now());
    expect(await received(r.requestId, r.from)).toEqual([]);
    expect(logged('quotes: request not quoted', r.requestId)).toMatchObject({ reason: 'late', after: 'hook' });
    expect(logged('quotes: quote sent', r.requestId)).toBeUndefined();
  }, 120_000);

  test('TC-INT-1396-04: windowCloseAt passes while the quote is recorded — nothing is sent, the request is logged late after record, not as sent', async () => {
    const r = await request((closeAt) => ({ recordFinishesAtMs: closeAt + 300 }));
    await sleep(r.windowCloseAt + 5_000 - Date.now());
    expect(await received(r.requestId, r.from)).toEqual([]);
    expect(logged('quotes: request not quoted', r.requestId)).toMatchObject({ reason: 'late', after: 'record', stored: true });
    expect(logged('quotes: quote sent', r.requestId)).toBeUndefined();
  }, 120_000);
});
