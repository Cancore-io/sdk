import {
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  FILLER_PROTOCOL_DOMAIN,
  TICKET_INTENT_TYPES,
  TICKET_RECEIPT_TYPES,
  hashTypedData,
  type Hex,
  type OrderJson,
  type TicketOffer,
} from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { hashOrder, hashTicket } from '../chain';
import type { FillerEvent } from '../events';
import { createFiller, type Filler, type TicketOfferDecision } from '../filler';
import { recoverAddress, type FillSigner } from '../signer';
import { FillerProtocolClient } from '../protocol/client';
import type { TicketRecord, TicketState } from '../store';
import type { TicketVerifier } from './checks';
import { TicketDesk } from './desk';
import {
  createFakeFetch,
  createFakeWebSocketFactory,
  createRecordingEventSink,
  createRecordingLogger,
  createTestGatewaySigner,
  createTestTypedDataSigner,
  FakeChain,
  FakeClock,
  InMemoryFillerStore,
  type FakeSocket,
} from '../testing';

const QUOTE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const STRANGER_KEY: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const GATEWAY_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const IMPOSTOR_KEY: Hex = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
const SRC_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
const DST_ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const TOKEN: Hex = '0x00000000000000000000000000000000000000aa';
const FILLER = 'acme-1';

const fill: FillSigner = { ...createTestTypedDataSigner(FILL_KEY), signTransaction: async () => '0x02' };
const ticketSigner = createTestTypedDataSigner(TICKET_KEY);
const stranger = createTestTypedDataSigner(STRANGER_KEY);
const POLICY = { openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n };

const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** One order on a BSC → Ethereum route, its escrow open on the fake source, the filler stocked on the fake destination. */
function world(clock: FakeClock) {
  const nowS = BigInt(Math.floor(clock.now() / 1000));
  const src = new FakeChain(56n, 'bsc');
  const dst = new FakeChain(1n, 'eth');
  const order: OrderJson = {
    user: '0x2222222222222222222222222222222222222222',
    originChainId: '56',
    inputToken: '0x0000000000000000000000000000000000000056',
    inputAmount: '105',
    destination: `0x${'00'.repeat(31)}01`,
    outputAsset: `0x${'00'.repeat(12)}${TOKEN.slice(2)}`,
    minReceived: '99',
    recipient: `0x${'00'.repeat(12)}${'0b'.repeat(20)}`,
    createdAt: String(nowS - 60n),
    fillDeadline: String(nowS + 600n),
    feeBps: '500',
  };
  const orderHash = hashOrder(order, { chainId: 56n, router: SRC_ROUTER });
  src.router(SRC_ROUTER).openIntent(orderHash, { refundAfter: nowS + 600n + 3_600n, openedAt: nowS - 50n, atBlock: 90n });
  dst.router(DST_ROUTER).ticketSigners.add(ticketSigner.address);
  dst.token(TOKEN).setBalance(fill.address, 1_000n).approve(fill.address, DST_ROUTER, 1_000n);
  dst.nativeBalances.set(fill.address.toLowerCase(), 10n ** 16n);
  return { src, dst, order, orderHash, nowS };
}

interface Options {
  clock?: FakeClock;
  store?: InMemoryFillerStore;
  hook?: (offer: TicketOffer) => Promise<TicketOfferDecision>;
  chains?: ReturnType<typeof world>;
}

async function harness(options: Options = {}) {
  const clock = options.clock ?? new FakeClock();
  const store = options.store ?? new InMemoryFillerStore(clock);
  const w = options.chains ?? world(clock);
  const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
  const impostor = createTestGatewaySigner(IMPOSTOR_KEY, clock);
  const ws = createFakeWebSocketFactory();
  const events = createRecordingEventSink();
  const logger = createRecordingLogger();
  const hookCalls: TicketOffer[] = [];
  const filler: Filler = createFiller({
    gatewayUrl: 'wss://filler-gateway.example/v1',
    fillerId: FILLER,
    gatewaySigner: gateway.address,
    ticketSigners: [ticketSigner.address],
    quoteSigner: createTestTypedDataSigner(QUOTE_KEY),
    fillSigners: { 'eip155:1': fill },
    rpc: { 'eip155:56': [w.src], 'eip155:1': [w.dst] },
    chains: { 'eip155:56': { router: SRC_ROUTER, ...POLICY }, 'eip155:1': { router: DST_ROUTER, ...POLICY } },
    tickets: { deltaIssueMs: 3_000 },
    store,
    webSocket: ws.factory,
    fetch: createFakeFetch().fetch,
    clock,
    events,
    logger,
    instanceId: 'replica-1',
  });
  filler.onQuoteRequest(async () => null);
  filler.onReconfirm(async () => false);
  filler.onTicketOffer(async (offer) => {
    hookCalls.push(offer);
    return options.hook ? options.hook(offer) : 'accept';
  });
  const started = filler.start();
  const socket: FakeSocket = ws.sockets[0]!;
  socket.open();
  socket.receive(gateway.frame({ type: 'auth.challenge', nonce: `0x${'ab'.repeat(32)}`, expiresAt: String(Math.floor(clock.now() / 1000) + 30) }));
  await settle();
  socket.receive(gateway.frame({ type: 'auth.ok', fillerId: FILLER, heartbeatIntervalMs: 60_000, re: socket.sentFrames()[0]!.id }));
  await started;
  await settle();

  const offerFrame = (over: Record<string, unknown> = {}) => ({
    type: 'ticket.offer',
    fillerId: FILLER,
    orderHash: w.orderHash,
    attempt: 0,
    order: w.order,
    amountOut: '99',
    validFrom: String(w.nowS),
    validUntil: String(w.nowS + 300n),
    acceptBy: clock.now() + 5_000,
    ...over,
  });
  const ticketOf = (offer: { validFrom: string; validUntil: string; attempt: number }, over: Record<string, unknown> = {}) => ({
    orderHash: w.orderHash,
    filler: fill.address,
    attempt: offer.attempt,
    validFrom: offer.validFrom,
    validUntil: offer.validUntil,
    ...over,
  });
  const issuedFrame = async (offer: { validFrom: string; validUntil: string; attempt: number }, over: { ticket?: Record<string, unknown>; signer?: typeof ticketSigner } = {}) => {
    const ticket = ticketOf(offer, over.ticket);
    const ticketSig = await (over.signer ?? ticketSigner).signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
    return { type: 'ticket.issued', fillerId: FILLER, form: 'evm', orderHash: w.orderHash, attempt: offer.attempt, ticket, ticketSig };
  };
  const sent = (type: string) => socket.sentFrames().filter((f) => f.type === type);
  const record = (attempt = 0) => store.withOrder(w.orderHash, (tx) => tx.getTicket(attempt));
  const stages = () => events.events.filter((e): e is Extract<FillerEvent, { type: 'stage' }> => e.type === 'stage').map((e) => e.stage);
  return { clock, store, w, gateway, impostor, socket, events, logger, filler, hookCalls, offerFrame, issuedFrame, sent, record, stages };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** offer → intent → ack, through the session. */
async function consent(h: Harness, over: Record<string, unknown> = {}) {
  const offer = h.offerFrame(over);
  h.socket.receive(h.gateway.frame(offer));
  await settle();
  const intent = h.sent('ticket.intent').at(-1);
  if (intent) {
    h.socket.receive(h.gateway.frame({ type: 'ticket.intent.ack', fillerId: FILLER, re: intent.id, orderHash: h.w.orderHash, attempt: offer.attempt, intentHash: `0x${'11'.repeat(32)}`, receivedAt: h.clock.now() }));
    await settle();
  }
  return { offer, intent };
}

describe('the full path: offer → intent → ack → issued → checks → receipt', () => {
  test('the intent repeats the offer and is signed by the fill key; the receipt signs hashTicket and keccak256(ticketSig)', async () => {
    const h = await harness();
    const { offer, intent } = await consent(h);
    expect(h.hookCalls).toHaveLength(1);
    expect(intent).toMatchObject({ orderHash: h.w.orderHash, attempt: 0, validFrom: offer.validFrom, validUntil: offer.validUntil });
    const intentDigest = hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: TICKET_INTENT_TYPES, primaryType: 'TicketIntent', message: { orderHash: h.w.orderHash, attempt: 0, validFrom: offer.validFrom, validUntil: offer.validUntil } });
    expect(recoverAddress(intentDigest, intent!.sig as Hex)).toBe(fill.address.toLowerCase());
    expect(await h.record()).toMatchObject({ state: 'intent-acked', intentAck: { intentHash: `0x${'11'.repeat(32)}` } });

    const issued = await h.issuedFrame(offer);
    h.socket.receive(h.gateway.frame(issued));
    await settle();
    const [receipt] = h.sent('ticket.receipt');
    const ticketHash = hashTicket(issued.ticket);
    const ticketSigHash = `0x${bytesToHex(keccak_256(hexToBytes(issued.ticketSig.slice(2))))}`;
    expect(receipt).toMatchObject({ orderHash: h.w.orderHash, attempt: 0, ticketHash, ticketSigHash });
    const receiptDigest = hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: TICKET_RECEIPT_TYPES, primaryType: 'TicketReceipt', message: { ticketHash, ticketSigHash } });
    expect(recoverAddress(receiptDigest, receipt!.sig as Hex)).toBe(fill.address.toLowerCase());
    expect(h.sent('ticket.decline')).toHaveLength(0);

    const stored = await h.record();
    expect(stored).toMatchObject({ state: 'receipted', receipt: { id: receipt!.id } });
    expect(stored!.sentAtMs).toBeDefined();
    expect(h.stages()).toEqual(expect.arrayContaining(['ticket.offered', 'ticket.intent.sent', 'ticket.issued', 'ticket.checked', 'ticket.receipted']));
    await h.filler.stop();
  });

  test('ticket.issued before the ack is still checked and receipted', async () => {
    const h = await harness();
    const offer = h.offerFrame();
    h.socket.receive(h.gateway.frame(offer));
    await settle();
    h.socket.receive(h.gateway.frame(await h.issuedFrame(offer)));
    await settle();
    expect(h.sent('ticket.receipt')).toHaveLength(1);
    await h.filler.stop();
  });

  test('redeliveries change nothing: one intent, one receipt', async () => {
    const h = await harness();
    const offer = h.offerFrame();
    const offerSigned = h.gateway.frame(offer);
    h.socket.receive(offerSigned);
    await settle();
    h.socket.receive(offerSigned);
    await settle();
    const issued = h.gateway.frame(await h.issuedFrame(offer));
    h.socket.receive(issued);
    await settle();
    h.socket.receive(issued);
    await settle();
    expect(h.sent('ticket.intent')).toHaveLength(1);
    expect(h.sent('ticket.receipt')).toHaveLength(1);
    expect(h.hookCalls).toHaveLength(1);
    await h.filler.stop();
  });
});

describe('the offer stage: the hook decides, before acceptBy', () => {
  test.each(['NO_INVENTORY', 'RISK_LIMIT', 'PRICE_MOVED', 'PAUSED', 'OTHER'] as const)('decline %s: ticket.decline with that reason, no intent, declined event', async (reason) => {
    const h = await harness({ hook: async () => ({ decline: reason, detail: 'busy' }) });
    await consent(h);
    expect(h.sent('ticket.intent')).toHaveLength(0);
    expect(h.sent('ticket.decline')).toEqual([expect.objectContaining({ orderHash: h.w.orderHash, attempt: 0, reason, detail: 'busy' })]);
    expect(await h.record()).toMatchObject({ state: 'declined', decline: { reason } });
    expect(h.events.events).toContainEqual({ type: 'declined', orderHash: h.w.orderHash, attempt: 0, reason });
    await h.filler.stop();
  });

  test('a plain "decline" is OTHER', async () => {
    const h = await harness({ hook: async () => 'decline' });
    await consent(h);
    expect(h.sent('ticket.decline')).toEqual([expect.objectContaining({ reason: 'OTHER' })]);
    await h.filler.stop();
  });

  test('a hook that does not answer: decline OTHER before acceptBy (T-21)', async () => {
    const h = await harness({ hook: () => new Promise(() => undefined) });
    const offer = h.offerFrame();
    h.socket.receive(h.gateway.frame(offer));
    await settle();
    expect(h.sent('ticket.decline')).toHaveLength(0);
    h.clock.advance(5_000 - 250);
    await settle();
    expect(h.sent('ticket.decline')).toEqual([expect.objectContaining({ reason: 'OTHER', detail: 'the hook did not answer before acceptBy' })]);
    expect(h.clock.now()).toBeLessThan(offer.acceptBy);
    await h.filler.stop();
  });

  test('a hook that throws: decline OTHER', async () => {
    const h = await harness({ hook: async () => Promise.reject(new Error('boom')) });
    await consent(h);
    expect(h.sent('ticket.decline')).toEqual([expect.objectContaining({ reason: 'OTHER', detail: 'the hook failed' })]);
    await h.filler.stop();
  });

  test('the kill-switch declines PAUSED without asking the hook', async () => {
    const h = await harness();
    h.store.setOverrides({ paused: true });
    await consent(h);
    expect(h.hookCalls).toHaveLength(0);
    expect(h.sent('ticket.decline')).toEqual([expect.objectContaining({ reason: 'PAUSED' })]);
    await h.filler.stop();
  });

  test('the hook answers after acceptBy: nothing is sent, the attempt ends', async () => {
    let release: (d: TicketOfferDecision) => void = () => undefined;
    const h = await harness({ hook: () => new Promise((resolve) => (release = resolve)) });
    const offer = h.offerFrame({ acceptBy: h.clock.now() + 100 });
    h.socket.receive(h.gateway.frame(offer));
    await settle();
    h.clock.advance(101);
    release('accept');
    await settle();
    expect(h.sent('ticket.intent')).toHaveLength(0);
    expect(h.sent('ticket.decline').filter((d) => d.detail !== 'the hook did not answer before acceptBy')).toHaveLength(0);
    expect((await h.record())!.state).toBe('declined');
    await h.filler.stop();
  });

  test('an offer signed by another key than the pinned filler-gateway is dropped: no hook, no intent', async () => {
    const h = await harness();
    h.socket.receive(h.impostor.frame(h.offerFrame()));
    await settle();
    expect(h.hookCalls).toHaveLength(0);
    expect(h.sent('ticket.intent')).toHaveLength(0);
    expect(await h.record()).toBeUndefined();
    await h.filler.stop();
  });

  test('TICKET_CLOSED for a late intent leaves the state as written', async () => {
    const h = await harness();
    const { intent } = await consent(h);
    h.socket.receive(h.gateway.frame({ type: 'error', fillerId: FILLER, re: intent!.id, code: 'TICKET_CLOSED', message: 'intent after acceptBy' }));
    await settle();
    expect((await h.record())!.state).toBe('intent-acked');
    await h.filler.stop();
  });
});

describe('the issued stage: a failed check declines with its code, never a receipt (T-23)', () => {
  type Case = [name: string, reason: string, setup: (h: Harness, offer: ReturnType<Harness['offerFrame']>) => Promise<{ type: string } & Record<string, unknown>>];
  const cases: Case[] = [
    ['ticketSig by a key outside ticketSigners', 'TICKET_SIGNER_UNKNOWN', async (h, offer) => h.issuedFrame(offer, { signer: stranger })],
    ['validUntil differs from the intent', 'TICKET_MISMATCH', async (h, offer) => h.issuedFrame(offer, { ticket: { validUntil: String(BigInt(offer.validUntil) + 1n) } })],
    ['ticket.issued after acceptBy + δ_issue', 'TICKET_ISSUED_LATE', async (h, offer) => {
      h.clock.advance(5_000 + 3_001);
      return h.issuedFrame(offer);
    }],
    ['the escrow is not open', 'ESCROW_NOT_OPEN', async (h, offer) => {
      h.w.src.router(SRC_ROUTER).intents.clear();
      return h.issuedFrame(offer);
    }],
    ['refundAfter − fillDeadline below the filler window', 'PROOF_WINDOW_TOO_SHORT', async (h, offer) => {
      h.w.src.router(SRC_ROUTER).intents.get(h.w.orderHash)!.refundAfter = BigInt(h.w.order.fillDeadline) + 100n;
      return h.issuedFrame(offer);
    }],
    ['every source RPC down (N-12)', 'ESCROW_NOT_OPEN', async (h, offer) => {
      h.w.src.down = true;
      return h.issuedFrame(offer);
    }],
    ['a Canton-form ticket (CAN-1867)', 'OTHER', async (h, offer) => ({ type: 'ticket.issued', fillerId: FILLER, form: 'canton', orderHash: h.w.orderHash, attempt: 0, deliveryOrderCid: '00ab', validUntil: offer.validUntil })],
  ];

  test.each(cases)('%s → %s', async (_name, reason, make) => {
    const h = await harness();
    const { offer } = await consent(h);
    h.socket.receive(h.gateway.frame(await make(h, offer)));
    await settle();
    expect(h.sent('ticket.receipt')).toHaveLength(0);
    expect(h.sent('ticket.decline')).toEqual([expect.objectContaining({ orderHash: h.w.orderHash, attempt: 0, reason })]);
    expect(await h.record()).toMatchObject({ state: 'declined', decline: { reason } });
    expect(h.events.events).toContainEqual({ type: 'declined', orderHash: h.w.orderHash, attempt: 0, reason });
    await h.filler.stop();
  });

  test('a ticket.issued with no offer in the store is declined, not receipted', async () => {
    const h = await harness();
    h.socket.receive(h.gateway.frame(await h.issuedFrame(h.offerFrame())));
    await settle();
    expect(h.sent('ticket.receipt')).toHaveLength(0);
    expect(h.sent('ticket.decline')).toEqual([expect.objectContaining({ reason: 'OTHER' })]);
    await h.filler.stop();
  });
});

describe('ticket.expired, order.settled, penalty.applied', () => {
  test.each([
    ['FILLED', 'FILLED'],
    ['NO_SHOW', 'NO_SHOW'],
    ['NO_SHOW_UNCONFIRMED', 'NO_SHOW_UNCONFIRMED'],
    ['EXEMPT', 'EXEMPT'],
    ['SOMETHING_NEW', 'OTHER'],
  ])('result %s is stored and reported as %s; no penalty event from it', async (result, reported) => {
    const h = await harness();
    const { offer } = await consent(h);
    h.socket.receive(h.gateway.frame(await h.issuedFrame(offer)));
    await settle();
    h.socket.receive(h.gateway.frame({ type: 'ticket.expired', fillerId: FILLER, orderHash: h.w.orderHash, attempt: 0, result, ...(result === 'EXEMPT' ? { exemptReason: 'GATEWAY_FAULT' } : {}) }));
    await settle();
    expect(await h.record()).toMatchObject({ state: 'expired', expired: { result } });
    expect(h.events.events).toContainEqual(expect.objectContaining({ type: 'stage', stage: 'ticket.expired', detail: expect.objectContaining({ result: reported }) }));
    expect(h.events.events.some((e) => e.type === 'penalty')).toBe(false);
    await h.filler.stop();
  });

  test('penalty.applied and order.settled become the penalty and settled events', async () => {
    const h = await harness();
    h.socket.receive(h.gateway.frame({ type: 'penalty.applied', fillerId: FILLER, violationId: 'v-1', code: 'NO_SHOW', step: 'RECORDED', details: {} }));
    h.socket.receive(h.gateway.frame({ type: 'order.settled', fillerId: FILLER, orderHash: h.w.orderHash, payout: '100', fee: '5', penaltyWithheld: '0', txRef: `0x${'77'.repeat(32)}` }));
    await settle();
    expect(h.events.events).toContainEqual({ type: 'penalty', violationId: 'v-1', code: 'NO_SHOW', step: 'RECORDED' });
    expect(h.events.events).toContainEqual({ type: 'settled', orderHash: h.w.orderHash, payout: '100', penaltyWithheld: '0', txRef: `0x${'77'.repeat(32)}` });
    await h.filler.stop();
  });
});

describe('a restart loses no ticket and sends nothing twice', () => {
  /** Writes `record` as a crashed replica left it, then starts a fresh filler on the same store. */
  async function restartWith(make: (h: Harness) => Promise<Partial<TicketRecord>>) {
    const clock = new FakeClock();
    const store = new InMemoryFillerStore(clock);
    const chains = world(clock);
    const first = await harness({ clock, store, chains });
    const partial = await make(first);
    await first.filler.stop();
    await store.withOrder(chains.orderHash, async (tx) => tx.putTicket({ orderHash: chains.orderHash, attempt: 0, updatedAtMs: clock.now(), state: 'offered', ...partial } as TicketRecord));
    const second = await harness({ clock, store, chains });
    await settle();
    return second;
  }

  test('OFFERED (the hook never answered): the offer is decided again', async () => {
    const h = await restartWith(async (h1) => ({ state: 'offered', offer: h1.gateway.frame(h1.offerFrame()) as unknown as TicketOffer }));
    expect(h.sent('ticket.intent')).toHaveLength(1);
    await h.filler.stop();
  });

  test('INTENT_SENT, never handed over: the same signed intent goes out', async () => {
    let intent: Record<string, unknown> | undefined;
    const h = await restartWith(async (h1) => {
      const { offer, intent: sent } = await consent(h1);
      intent = sent;
      return { state: 'intent-sent', offer: offer as unknown as TicketOffer, intent: sent as never };
    });
    expect(h.sent('ticket.intent')).toEqual([intent]);
    await h.filler.stop();
  });

  test('CHECKING (the checks were interrupted): checked again, receipted once', async () => {
    const h = await restartWith(async (h1) => {
      const offer = h1.offerFrame();
      const issued = await h1.issuedFrame(offer);
      return { state: 'checking', offer: offer as unknown as TicketOffer, issued: issued as never, issuedAtMs: h1.clock.now(), intent: { type: 'ticket.intent', id: 'x', orderHash: h1.w.orderHash, attempt: 0, validFrom: offer.validFrom, validUntil: offer.validUntil, sig: '0x' } };
    });
    expect(h.sent('ticket.receipt')).toHaveLength(1);
    expect((await h.record())!.state).toBe('receipted');
    await h.filler.stop();
  });

  test('RECEIPTED but not handed over: the stored receipt is sent, not a new one', async () => {
    const receipt = { type: 'ticket.receipt', id: 'stored-receipt', orderHash: '', attempt: 0, ticketHash: `0x${'01'.repeat(32)}`, ticketSigHash: `0x${'02'.repeat(32)}`, sig: `0x${'03'.repeat(65)}` };
    const h = await restartWith(async (h1) => {
      const offer = h1.offerFrame();
      return { state: 'receipted', offer: offer as unknown as TicketOffer, issued: (await h1.issuedFrame(offer)) as never, receipt: { ...receipt, orderHash: h1.w.orderHash } as never };
    });
    expect(h.sent('ticket.receipt')).toEqual([expect.objectContaining({ id: 'stored-receipt' })]);
    await h.filler.stop();
  });

  test('RECEIPTED and handed over: nothing is sent again', async () => {
    const h = await restartWith(async (h1) => {
      const offer = h1.offerFrame();
      return { state: 'receipted', sentAtMs: h1.clock.now(), offer: offer as unknown as TicketOffer, issued: (await h1.issuedFrame(offer)) as never, receipt: { type: 'ticket.receipt', id: 'r', orderHash: h1.w.orderHash, attempt: 0 } as never };
    });
    expect(h.sent('ticket.receipt')).toHaveLength(0);
    expect(h.sent('ticket.decline')).toHaveLength(0);
    await h.filler.stop();
  });

  test('DECLINED but not handed over: the stored decline is sent while acceptBy lasts', async () => {
    const h = await restartWith(async (h1) => ({
      state: 'declined',
      offer: h1.offerFrame() as unknown as TicketOffer,
      decline: { type: 'ticket.decline', id: 'stored-decline', orderHash: h1.w.orderHash, attempt: 0, reason: 'RISK_LIMIT' } as never,
    }));
    expect(h.sent('ticket.decline')).toEqual([expect.objectContaining({ id: 'stored-decline', reason: 'RISK_LIMIT' })]);
    expect(await h.store.listOpenOrders()).toEqual([]);
    await h.filler.stop();
  });

  test('DECLINED, not handed over, deadline passed: nothing is sent and the order is closed', async () => {
    const h = await restartWith(async (h1) => ({
      state: 'declined',
      offer: h1.offerFrame({ acceptBy: h1.clock.now() - 1 }) as unknown as TicketOffer,
      decline: { type: 'ticket.decline', id: 'too-late', orderHash: h1.w.orderHash, attempt: 0, reason: 'OTHER' } as never,
    }));
    expect(h.sent('ticket.decline')).toHaveLength(0);
    expect(await h.record()).toMatchObject({ unsent: true });
    expect(await h.store.listOpenOrders()).toEqual([]);
    await h.filler.stop();
  });
});

describe('no fill without a receipt (T-22): receipted() is the only gate', () => {
  test.each<[TicketState, boolean, boolean]>([
    ['offered', false, false],
    ['intent-sent', false, false],
    ['intent-acked', false, false],
    ['checking', false, false],
    ['declined', true, false],
    ['expired', false, false],
    ['receipted', false, false],
    ['receipted', true, true],
  ])('%s, handed over: %s → may fill: %s', async (state, handedOver, mayFill) => {
    const clock = new FakeClock();
    const store = new InMemoryFillerStore(clock);
    const logger = createRecordingLogger();
    const events = createRecordingEventSink();
    const desk = new TicketDesk({
      store,
      protocol: new FillerProtocolClient({ store, clock, logger, events, restPollIntervalMs: 2_000 }),
      verifier: {} as TicketVerifier,
      fillSigners: { 'eip155:1': fill },
      clock,
      logger,
      events,
      nextId: () => 'id',
      onTicketOffer: () => undefined,
      offerReplyMarginMs: 250,
    });
    const orderHash: Hex = `0x${'ab'.repeat(32)}`;
    await store.withOrder(orderHash, (tx) =>
      tx.putTicket({ orderHash, attempt: 0, state, updatedAtMs: 0, ...(handedOver ? { sentAtMs: 1 } : {}), receipt: { type: 'ticket.receipt', id: 'r' } as never }),
    );
    expect((await desk.receipted(orderHash, 0)) !== undefined).toBe(mayFill);
  });
});
