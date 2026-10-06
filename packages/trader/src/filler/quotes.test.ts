import {
  FILLER_PROTOCOL_DOMAIN,
  FILLER_QUOTE_TYPES,
  hashFillerMessage,
  hashTypedData,
  requestIdHash,
  type F2SMessage,
  type Hex,
  type QuoteMessage,
  type QuoteReconfirmReply,
} from '@cancore/contracts';
import { createFiller } from './filler';
import type { Delivery, FillerProtocolClient } from './protocol/client';
import { createSealer, type Sealer } from './protocol/envelope';
import type { QuoteListItem } from './protocol/rest';
import { cantonFillerPayout, evmFillerPayout, QuoteDesk, type FillerQuoteRequest, type FillerReconfirm, type QuoteDeskOptions, type QuoteDecisionInput } from './quotes';
import { recoverAddress, recoverTypedDataSigner, type FillSigner } from './signer';
import {
  createFakeFetch,
  createFakeWebSocketFactory,
  createRecordingEventSink,
  createRecordingLogger,
  createTestGatewaySigner,
  createTestTypedDataSigner,
  FakeClock,
  FakeEvmRpc,
  InMemoryFillerStore,
} from './testing';

const QUOTE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const BSC_FILL_KEY: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const GATEWAY_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const FILLER = 'acme-1';
const ORDER_HASH: Hex = `0x${'11'.repeat(32)}`;

const fillSigner = (key: Hex): FillSigner => ({ ...createTestTypedDataSigner(key), signTransaction: async () => '0x02' });

// ---------------------------------------------------------------------------

describe('evmFillerPayout (protocol §3.11)', () => {
  test('T = 105, feeBps = 500 → payout 100, fee 5', () => {
    expect(evmFillerPayout(105n, 500)).toBe(100n);
  });

  test('rounding dust goes to the fee; zero fee pays everything', () => {
    expect(evmFillerPayout(104n, 500)).toBe(99n);
    expect(evmFillerPayout(1n, 1)).toBe(0n);
    expect(evmFillerPayout(123_456_789n, 0)).toBe(123_456_789n);
  });

  test('for any N and feeBps ≤ 1000, the payout of T = N + ⌈N·feeBps/10 000⌉ is exactly N', () => {
    let seed = 0x2545f491;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff);
    for (let i = 0; i < 2_000; i++) {
      const n = (BigInt(next()) << 62n) ^ (BigInt(next()) << 31n) ^ BigInt(next());
      const feeBps = next() % 1_001;
      const fee = (n * BigInt(feeBps) + 9_999n) / 10_000n;
      expect(evmFillerPayout(n + fee, feeBps)).toBe(n);
    }
  });

  test('refuses a negative total and a feeBps outside uint16', () => {
    expect(() => evmFillerPayout(-1n, 0)).toThrow(RangeError);
    expect(() => evmFillerPayout(1n, 70_000)).toThrow(RangeError);
  });
});

describe('cantonFillerPayout (protocol §3.11, T-12: SwapIntent.daml, Numeric 10, half to even)', () => {
  const units = (decimal: string): bigint => {
    const [whole, frac = ''] = decimal.split('.');
    return BigInt(whole!) * 10n ** 10n + BigInt(frac.padEnd(10, '0'));
  };

  test.each([
    ['1000.0', 30, '997.0089730808', '2.9910269192'],
    ['100.8000000063', 80, '100.0000000062', '0.8000000001'],
    ['100.8000000189', 80, '100.0000000188', '0.8000000001'],
    ['0.0000000002', 1000, '0.0000000002', '0.0'],
  ])('amount %s, feeBps %d → payout %s, fee %s (daml test vectors)', (amount, feeBps, payout, fee) => {
    const total = units(amount);
    expect(cantonFillerPayout(total, feeBps)).toBe(units(payout));
    expect(total - cantonFillerPayout(total, feeBps)).toBe(units(fee));
  });

  test('the first vector is one unit above the EVM formula', () => {
    expect(evmFillerPayout(units('1000.0'), 30)).toBe(units('997.0089730807'));
  });

  test('for any T: the EVM payout or one unit above it, the fee never below ⌊T·feeBps/(10 000 + feeBps)⌋, and never a zero payout for T > 0', () => {
    let seed = 0x1b873593;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff);
    for (let i = 0; i < 2_000; i++) {
      const total = (BigInt(next()) << 31n) ^ BigInt(next());
      const feeBps = next() % 1_001;
      const payout = cantonFillerPayout(total, feeBps);
      const evm = evmFillerPayout(total, feeBps);
      expect(payout === evm || payout === evm + 1n).toBe(true);
      expect(total - payout).toBeGreaterThanOrEqual((total * BigInt(feeBps)) / (10_000n + BigInt(feeBps)));
      if (total > 0n) expect(payout).toBeGreaterThan(0n);
    }
  });

  test('refuses a negative total and a feeBps outside uint16', () => {
    expect(() => cantonFillerPayout(-1n, 0)).toThrow(RangeError);
    expect(() => cantonFillerPayout(1n, -1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------

/** A protocol client stand-in: records what the desk sends, sealed by the real sealer. */
function fakeProtocol(store: InMemoryFillerStore, seal: Sealer) {
  const sent: F2SMessage[] = [];
  const quoteItems: QuoteListItem[] = [];
  const protocol = {
    connected: true,
    sent,
    quoteItems,
    seal,
    send(frame: F2SMessage) {
      if (!protocol.connected) return false;
      sent.push(frame);
      return true;
    },
    on: () => undefined,
    onLogin: () => undefined,
    listQuotes: async () => quoteItems,
    ingest: async (verified: { frame: Record<string, unknown> }) => void (await store.quotes.recordAck(verified.frame as never)),
  };
  return protocol;
}

function desk(over: Partial<QuoteDeskOptions> & { hook?: (r: FillerQuoteRequest) => Promise<QuoteDecisionInput | null>; reconfirm?: (r: FillerReconfirm) => Promise<boolean> } = {}) {
  const clock = new FakeClock();
  const store = new InMemoryFillerStore(clock);
  const logger = createRecordingLogger();
  const events = createRecordingEventSink();
  const quoteSigner = createTestTypedDataSigner(QUOTE_KEY);
  const protocol = fakeProtocol(store, createSealer({ fillerId: FILLER, messageSigner: quoteSigner, clock }));
  const fill1 = fillSigner(FILL_KEY);
  const fill56 = fillSigner(BSC_FILL_KEY);
  const seenRequests: FillerQuoteRequest[] = [];
  const seenReconfirms: FillerReconfirm[] = [];
  let id = 0;
  const options: QuoteDeskOptions = {
    fillerId: FILLER,
    quoteSigner,
    fillSigners: { 'eip155:1': fill1, 'eip155:56': fill56 },
    store,
    protocol: protocol as unknown as FillerProtocolClient,
    clock,
    logger,
    events,
    nextId: () => `id-${id++}`,
    onQuoteRequest: () => async (request) => {
      seenRequests.push(request);
      return over.hook ? over.hook(request) : { amountOut: 99n, validUntil: BigInt(Math.ceil((clock.now() + 60_000) / 1000)) };
    },
    onReconfirm: () => async (reconfirm) => {
      seenReconfirms.push(reconfirm);
      return over.reconfirm ? over.reconfirm(reconfirm) : true;
    },
    minInput: async () => undefined,
    reconfirmMarginS: 30,
    reconcileLookbackMs: 900_000,
    ...over,
  };
  return { clock, store, logger, events, protocol, quoteSigner, fill1, fill56, seenRequests, seenReconfirms, options, desk: new QuoteDesk(options) };
}

const delivery = (frame: Record<string, unknown>, firstSeen = true): Delivery =>
  ({ frame: { sentAt: 0, sig: '0x', ...frame }, raw: new Uint8Array(), id: '0x00', channel: 'ws', firstSeen }) as unknown as Delivery;

const request = (clock: FakeClock, over: Record<string, unknown> = {}) => ({
  type: 'quote.request',
  fillerId: FILLER,
  requestId: 'rq-1',
  route: { src: 'eip155:56', dst: 'eip155:1' },
  inputToken: '0x0000000000000000000000000000000000000056',
  inputAmount: '105',
  outputAsset: '0x0000000000000000000000000000000000000001',
  feeBps: 500,
  fillDeadlineHint: '1790000600',
  windowCloseAt: clock.now() + 500,
  quoteTtlMs: 30_000,
  ...over,
});

const quoteInput = (requestId: string, q: { amountOut: string; validUntil: string; nonce: string }) => ({
  domain: FILLER_PROTOCOL_DOMAIN,
  types: FILLER_QUOTE_TYPES,
  primaryType: 'FillerQuote',
  message: { requestId: requestIdHash(requestId), fillerId: FILLER, amountOut: q.amountOut, validUntil: q.validUntil, nonce: q.nonce },
});

describe('quote.request → onQuoteRequest → FillerQuote', () => {
  test('the hook gets the payout with the fee taken (T = 105, feeBps = 500 → 100); the quote is signed by the quote key and stored', async () => {
    const h = desk();
    const result = await h.desk.onRequest(delivery(request(h.clock)));
    expect(h.seenRequests[0]).toMatchObject({ requestId: 'rq-1', payout: 100n, fee: 5n, inputAmount: '105' });
    expect(h.seenRequests[0]!.imbalanceHint).toBeUndefined();

    expect(result).toHaveProperty('sent');
    const [quote] = h.protocol.sent as QuoteMessage[];
    expect(quote).toMatchObject({ type: 'quote', fillerId: FILLER, sentAt: h.clock.now(), requestId: 'rq-1', amountOut: '99', nonce: '1' });
    expect(quote).not.toHaveProperty('filler');
    expect(recoverAddress(hashFillerMessage(quote!), quote!.msgSig)).toBe(h.quoteSigner.address);
    const input = quoteInput('rq-1', quote!);
    expect(recoverTypedDataSigner(input, quote!.sig)).toBe(h.quoteSigner.address);
    const [stored] = await h.store.quotes.listQuotes('rq-1');
    expect(stored).toMatchObject({ quoteHash: hashTypedData(input), quote });
    expect(h.events.events).toContainEqual(expect.objectContaining({ stage: 'quote.sent', requestId: 'rq-1' }));
  });

  test('a Canton source is priced on the ledger formula (T-12): 1000.0 at feeRate 0.003 → 997.0089730808', async () => {
    const h = desk();
    await h.desk.onRequest(delivery(request(h.clock, { requestId: 'rq-cs', route: { src: 'canton:devnet', dst: 'eip155:1' }, inputAmount: '10000000000000', feeBps: 30 })));
    expect(h.seenRequests[0]).toMatchObject({ payout: 9_970_089_730_808n, fee: 29_910_269_192n });
    expect(h.protocol.sent[0]).toMatchObject({ type: 'quote', requestId: 'rq-cs', fillerId: FILLER });
  });

  test('a Canton destination is quoted when the source has a fill key; the quote names the fillerId, not an address', async () => {
    const h = desk();
    await h.desk.onRequest(delivery(request(h.clock, { requestId: 'rq-c', route: { src: 'eip155:56', dst: 'canton:devnet' } })));
    const quote = h.protocol.sent[0] as QuoteMessage;
    expect(quote).toMatchObject({ type: 'quote', fillerId: FILLER });
    expect(recoverTypedDataSigner(quoteInput('rq-c', quote), quote.sig)).toBe(h.quoteSigner.address);
  });

  test.each([
    ['after windowCloseAt', (c: FakeClock) => ({ windowCloseAt: c.now() - 1 }), 'late'],
    ['at windowCloseAt', (c: FakeClock) => ({ windowCloseAt: c.now() }), 'late'],
    ['Canton to Canton (no EVM fill key names the filler)', () => ({ route: { src: 'canton:devnet', dst: 'canton:devnet' } }), 'no-fill-key'],
    ['a source that is neither eip155 nor canton', () => ({ route: { src: 'solana:mainnet', dst: 'eip155:1' } }), 'malformed'],
    ['a fractional feeBps (feeRate not a multiple of 0.0001)', () => ({ feeBps: 12.5 }), 'malformed'],
    ['no fill key for the destination', () => ({ route: { src: 'eip155:56', dst: 'eip155:10' } }), 'no-fill-key'],
    ['a malformed requestId', () => ({ requestId: 'has space' }), 'malformed'],
    ['inputAmount not a decimal string', () => ({ inputAmount: 105 }), 'malformed'],
    ['windowCloseAt not an integer', () => ({ windowCloseAt: 'soon' }), 'malformed'],
  ])('not quoted: %s', async (_name, over, reason) => {
    const h = desk();
    await expect(h.desk.onRequest(delivery(request(h.clock, over(h.clock))))).resolves.toEqual({ skipped: reason });
    expect(h.seenRequests).toHaveLength(0);
    expect(h.protocol.sent).toHaveLength(0);
  });

  test('not quoted: the hook returns null', async () => {
    const h = desk({ hook: async () => null });
    await expect(h.desk.onRequest(delivery(request(h.clock)))).resolves.toEqual({ skipped: 'declined' });
    expect(h.protocol.sent).toHaveLength(0);
  });

  test('not quoted: windowCloseAt passes while the hook thinks', async () => {
    const h = desk({
      hook: async () => {
        h.clock.advance(600);
        return { amountOut: 99n, validUntil: '1800000000' };
      },
    });
    await expect(h.desk.onRequest(delivery(request(h.clock)))).resolves.toEqual({ skipped: 'late' });
    expect(h.protocol.sent).toHaveLength(0);
  });

  test('not quoted: inputAmount below the source router minInput (T-16)', async () => {
    const h = desk({ minInput: async (chain, token) => (chain === 'eip155:56' && token === '0x0000000000000000000000000000000000000056' ? 106n : undefined) });
    await expect(h.desk.onRequest(delivery(request(h.clock)))).resolves.toEqual({ skipped: 'below-min-input' });
    expect(h.seenRequests).toHaveLength(0);
  });

  test('validUntil × 1000 = windowCloseAt + quoteTtlMs is accepted; one second less is not; the boundary is in ms', async () => {
    // windowCloseAt + quoteTtlMs lands on a whole second.
    const boundaryMs = (Math.floor(1_790_000_000_000 / 1000) + 31) * 1000;
    const exact = desk({ hook: async () => ({ amountOut: '99', validUntil: String(boundaryMs / 1000) }) });
    exact.clock.advance(boundaryMs - 30_000 - 500 - exact.clock.now());
    await expect(exact.desk.onRequest(delivery(request(exact.clock)))).resolves.toHaveProperty('sent');

    const short = desk({ hook: async () => ({ amountOut: '99', validUntil: String(boundaryMs / 1000 - 1) }) });
    short.clock.advance(boundaryMs - 30_000 - 500 - short.clock.now());
    await expect(short.desk.onRequest(delivery(request(short.clock)))).resolves.toEqual({ skipped: 'short-ttl' });

    // windowCloseAt one millisecond later: the same validUntil is now 1 ms short.
    const ms = desk({ hook: async () => ({ amountOut: '99', validUntil: String(boundaryMs / 1000) }) });
    ms.clock.advance(boundaryMs - 30_000 - 500 - ms.clock.now());
    await expect(ms.desk.onRequest(delivery(request(ms.clock, { windowCloseAt: ms.clock.now() + 501 })))).resolves.toEqual({ skipped: 'short-ttl' });
  });

  test.each([
    ['a zero amount', { amountOut: 0n, validUntil: '1800000000' }],
    ['a negative amount', { amountOut: '-1', validUntil: '1800000000' }],
    ['a validUntil beyond uint64', { amountOut: '1', validUntil: (1n << 64n).toString() }],
    ['a fractional amount', { amountOut: '1.5', validUntil: '1800000000' }],
  ])('not quoted: the hook returns %s', async (_name, decision) => {
    const h = desk({ hook: async () => decision as QuoteDecisionInput });
    await expect(h.desk.onRequest(delivery(request(h.clock)))).resolves.toEqual({ skipped: 'invalid-decision' });
  });

  test('a hook that throws is logged and skipped', async () => {
    const h = desk({ hook: async () => Promise.reject(new Error('price feed down')) });
    await expect(h.desk.onRequest(delivery(request(h.clock)))).resolves.toEqual({ skipped: 'hook-failed' });
    expect(h.logger.entries).toContainEqual(expect.objectContaining({ level: 'error', message: 'quotes: onQuoteRequest threw' }));
  });

  test('a redelivered request (same bytes) is not quoted twice; paused and disconnected are skipped', async () => {
    const h = desk();
    await expect(h.desk.onRequest(delivery(request(h.clock), false))).resolves.toEqual({ skipped: 'redelivered' });
    h.store.setOverrides({ paused: true });
    await expect(h.desk.onRequest(delivery(request(h.clock)))).resolves.toEqual({ skipped: 'paused' });
    h.store.setOverrides({ paused: false });
    h.protocol.connected = false;
    await expect(h.desk.onRequest(delivery(request(h.clock)))).resolves.toEqual({ skipped: 'disconnected' });
    expect(h.protocol.sent).toHaveLength(0);
  });

  test('a replacement in the window takes a higher nonce, also after a restart (nonce from the store)', async () => {
    const h = desk();
    await h.desk.onRequest(delivery(request(h.clock)));
    const restarted = new QuoteDesk(h.options);
    await restarted.onRequest(delivery(request(h.clock, { sentAt: 1 })));
    expect((h.protocol.sent as QuoteMessage[]).map((q) => q.nonce)).toEqual(['1', '2']);
    const quotes = await h.store.quotes.listQuotes('rq-1');
    expect(quotes).toHaveLength(2);
    await expect(h.desk.firmQuote('rq-1')).resolves.toMatchObject({ quote: { nonce: '2' } });
  });

  test('firmQuote: a quote past its validUntil is no longer firm', async () => {
    const h = desk({ hook: async () => ({ amountOut: 99n, validUntil: BigInt(Math.ceil((h.clock.now() + 31_000) / 1000)) }) });
    await h.desk.onRequest(delivery(request(h.clock)));
    await expect(h.desk.firmQuote('rq-1')).resolves.toBeDefined();
    await expect(h.desk.firmQuote('rq-1', h.clock.now() + 60_000)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

const order = (over: Record<string, unknown> = {}) => ({
  user: '0x00000000000000000000000000000000000000aa',
  originChainId: '56',
  inputToken: '0x0000000000000000000000000000000000000056',
  inputAmount: '105',
  destination: `0x${(1).toString(16).padStart(64, '0')}`,
  outputAsset: `0x${'00'.repeat(31)}01`,
  minReceived: '97',
  recipient: `0x${'00'.repeat(31)}bb`,
  createdAt: '1790000000',
  fillDeadline: '1790000600',
  feeBps: '500',
  ...over,
});

const reconfirm = (clock: FakeClock, over: Record<string, unknown> = {}) => ({
  type: 'quote.reconfirm',
  fillerId: FILLER,
  orderHash: ORDER_HASH,
  requestId: 'rq-1',
  order: order(),
  amountOut: '97',
  ticketTtl: 180,
  replyBy: clock.now() + 2_000,
  ...over,
});

describe('quote.reconfirm → onReconfirm → quote.reconfirm.reply (T-20)', () => {
  test('accepted at order.minReceived: signed FillerQuote, a nonce above every earlier one, before replyBy', async () => {
    const h = desk();
    await h.desk.onRequest(delivery(request(h.clock)));
    const frame = reconfirm(h.clock);
    const result = await h.desk.onReconfirm(delivery(frame));
    expect(h.seenReconfirms[0]).toMatchObject({ orderHash: ORDER_HASH, payout: 100n, fee: 5n });

    expect(result).toHaveProperty('reply');
    const reply = h.protocol.sent.at(-1) as QuoteReconfirmReply;
    const validUntil = String(Math.ceil(frame.replyBy / 1000) + 180 + 30);
    expect(reply).toMatchObject({ type: 'quote.reconfirm.reply', orderHash: ORDER_HASH, accept: true, nonce: '2', validUntil });
    const input = quoteInput('rq-1', { amountOut: '97', validUntil, nonce: '2' });
    expect(recoverTypedDataSigner(input, reply.sig!)).toBe(h.quoteSigner.address);
    await expect(h.desk.firmQuote('rq-1')).resolves.toMatchObject({ quoteHash: hashTypedData(input), quote: { amountOut: '97' } });
  });

  test('a changed price is not signed: amountOut ≠ order.minReceived is declined without asking the hook', async () => {
    const h = desk();
    await h.desk.onReconfirm(delivery(reconfirm(h.clock, { amountOut: '98' })));
    expect(h.seenReconfirms).toHaveLength(0);
    const decline = h.protocol.sent[0] as QuoteReconfirmReply;
    expect(h.protocol.sent).toEqual([
      { type: 'quote.reconfirm.reply', id: expect.any(String), orderHash: ORDER_HASH, accept: false, fillerId: FILLER, sentAt: h.clock.now(), msgSig: expect.any(String) },
    ]);
    // a decline carries no FillerQuote, and is signed by its envelope alone
    expect(recoverAddress(hashFillerMessage(decline), decline.msgSig)).toBe(h.quoteSigner.address);
  });

  test('the hook says no → declined, no signature', async () => {
    const h = desk({ reconfirm: async () => false });
    await h.desk.onReconfirm(delivery(reconfirm(h.clock)));
    const reply = h.protocol.sent[0] as QuoteReconfirmReply;
    expect(reply).toMatchObject({ accept: false });
    expect(reply.sig).toBeUndefined();
  });

  test('after replyBy nothing is sent; also when the hook answers too late', async () => {
    const h = desk();
    await expect(h.desk.onReconfirm(delivery(reconfirm(h.clock, { replyBy: h.clock.now() })))).resolves.toEqual({ skipped: 'late' });
    const slow = desk({
      reconfirm: async () => {
        slow.clock.advance(5_000);
        return true;
      },
    });
    await expect(slow.desk.onReconfirm(delivery(reconfirm(slow.clock)))).resolves.toEqual({ skipped: 'late' });
    expect([...h.protocol.sent, ...slow.protocol.sent]).toHaveLength(0);
  });

  test('a Canton-source order is reconfirmed on the ledger formula (T-12); a redelivery is ignored', async () => {
    const h = desk();
    const canton = order({ originChainId: '9223372036854775811', inputAmount: '1008000000063', feeBps: '80' });
    await h.desk.onReconfirm(delivery(reconfirm(h.clock, { order: canton })));
    expect(h.seenReconfirms[0]).toMatchObject({ payout: 1_000_000_000_062n, fee: 8_000_000_001n });
    expect(h.protocol.sent[0]).toMatchObject({ accept: true });
    await expect(h.desk.onReconfirm(delivery(reconfirm(h.clock), false))).resolves.toEqual({ skipped: 'redelivered' });
  });

  test('an order to another EVM destination with a fill key there is reconfirmed under the same fillerId', async () => {
    const h = desk();
    const toBsc = order({ originChainId: '1', destination: `0x${(56).toString(16).padStart(64, '0')}` });
    await h.desk.onReconfirm(delivery(reconfirm(h.clock, { order: toBsc })));
    const reply = h.protocol.sent[0] as QuoteReconfirmReply;
    const input = quoteInput('rq-1', { amountOut: '97', validUntil: reply.validUntil!, nonce: reply.nonce! });
    expect(recoverTypedDataSigner(input, reply.sig!)).toBe(h.quoteSigner.address);
    expect(recoverAddress(hashFillerMessage(reply), reply.msgSig)).toBe(h.quoteSigner.address);
  });
});

// ---------------------------------------------------------------------------

describe('reconciliation — GET /v1/filler/quotes?since=', () => {
  test('attaches an ack the store missed and counts quotes the store does not know', async () => {
    const h = desk();
    await h.desk.onRequest(delivery(request(h.clock)));
    const [mine] = await h.store.quotes.listQuotes('rq-1');
    const ack = (quoteHash: Hex) => ({ frame: { type: 'quote.ack', requestId: 'rq-1', quoteHash, receivedAt: h.clock.now(), status: 'COUNTED', sentAt: 0, sig: '0x' }, raw: new Uint8Array(), id: '0x00' });
    h.protocol.quoteItems.push(
      { quote: mine!.quote, ack: ack(mine!.quoteHash), status: 'WON' } as unknown as QuoteListItem,
      { quote: { ...mine!.quote, nonce: '9' }, ack: ack(`0x${'99'.repeat(32)}`), status: 'COUNTED' } as unknown as QuoteListItem,
    );
    await expect(h.desk.reconcile(0)).resolves.toEqual({ seen: 2, acksRecovered: 1, unknownToStore: 1 });
    await expect(h.desk.reconcile(0)).resolves.toEqual({ seen: 2, acksRecovered: 0, unknownToStore: 1 });
    const [after] = await h.store.quotes.listQuotes('rq-1');
    expect(after!.ack).toMatchObject({ status: 'COUNTED' });
  });
});

// ---------------------------------------------------------------------------

describe('through createFiller and a crafted filler-gateway', () => {
  test('a signed quote.request on the session is priced, quoted and its quote.ack kept', async () => {
    const clock = new FakeClock();
    const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
    const ws = createFakeWebSocketFactory();
    const store = new InMemoryFillerStore(clock);
    const settle = async () => {
      for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    const filler = createFiller({
      gatewayUrl: 'wss://filler-gateway.example/v1',
      fillerId: FILLER,
      gatewaySigner: gateway.address,
      ticketSigners: ['0x2222222222222222222222222222222222222222'],
      quoteSigner: createTestTypedDataSigner(QUOTE_KEY),
      fillSigners: { 'eip155:1': fillSigner(FILL_KEY), 'eip155:56': fillSigner(BSC_FILL_KEY) },
      rpc: { 'eip155:1': [new FakeEvmRpc()], 'eip155:56': [new FakeEvmRpc()] },
      store,
      webSocket: ws.factory,
      fetch: createFakeFetch().fetch,
      clock,
      instanceId: 'replica-1',
    });
    const payouts: bigint[] = [];
    filler.onQuoteRequest(async (r) => {
      payouts.push(r.payout);
      return { amountOut: r.payout - 1n, validUntil: BigInt(Math.ceil((clock.now() + 60_000) / 1000)) };
    });
    filler.onReconfirm(async () => true);
    filler.onTicketOffer(async () => 'decline');
    const started = filler.start();
    const socket = ws.sockets[0]!;
    socket.open();
    socket.receive(gateway.frame({ type: 'auth.challenge', nonce: `0x${'ab'.repeat(32)}`, expiresAt: String(Math.floor(clock.now() / 1000) + 30) }));
    await settle();
    socket.receive(gateway.frame({ type: 'auth.ok', fillerId: FILLER, heartbeatIntervalMs: 10_000, re: socket.sentFrames()[0]!.id }));
    await started;

    socket.receive(gateway.frame({ ...request(clock), fillerId: FILLER }));
    await settle();
    expect(payouts).toEqual([100n]);
    const quote = socket.sentFrames().find((f) => f.type === 'quote')!;
    expect(quote).toMatchObject({ requestId: 'rq-1', amountOut: '99', nonce: '1' });

    const [stored] = await store.quotes.listQuotes('rq-1');
    socket.receive(gateway.frame({ type: 'quote.ack', fillerId: FILLER, re: quote.id, requestId: 'rq-1', quoteHash: stored!.quoteHash, receivedAt: clock.now(), status: 'COUNTED' }));
    await settle();
    const [acked] = await store.quotes.listQuotes('rq-1');
    expect(acked!.ack).toMatchObject({ status: 'COUNTED' });
    await filler.stop();
  });
});
