/**
 * CAN-2482 through the whole filler runtime: `createFiller` logged in to a
 * fake filler-gateway over `createFakeWebSocketFactory` (no network), its
 * frames signed by a test gateway key, the chains a `FakeChain`. The user
 * picks the filler (filler-selection.md), so:
 *
 * - one ticket attempt per order: a later attempt of an order this filler was
 *   already offered is declined as stale, without asking the hook;
 * - a `quote.reconfirm` is answered only for an order that names this filler
 *   (`order.fillerId`); another filler's is dropped unanswered.
 *
 * Runs in `npm test` (the `node` project): no stand needed.
 */
import { fillerIdHash, type Hex, type OrderJson } from '@cancore/contracts';
import { hashOrder } from '../src/filler/chain';
import { createFiller, type Filler } from '../src/filler/filler';
import type { FillSigner } from '../src/filler/signer';
import {
  createFakeFetch,
  createFakeGatewayLogin,
  createFakeWebSocketFactory,
  createRecordingEventSink,
  createRecordingLogger,
  createTestGatewaySigner,
  createTestTypedDataSigner,
  FakeChain,
  FakeClock,
  InMemoryFillerStore,
  type FakeSocket,
  type FrameBody,
} from '../src/filler/testing';

// Public test keys (hardhat/anvil defaults).
const QUOTE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const GATEWAY_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const SRC_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
const DST_ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const TOKEN: Hex = '0x00000000000000000000000000000000000000aa';
const FILLER = 'acme-1';
const POLICY = { openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n };

const quote = createTestTypedDataSigner(QUOTE_KEY);
const fill: FillSigner = { ...createTestTypedDataSigner(FILL_KEY), signTransaction: async () => '0x02' };
const ticketSigner = createTestTypedDataSigner(TICKET_KEY);

const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A BSC → Ethereum order with its escrow open on the fake source; `fillerId` names the filler the user picked. */
function world(clock: FakeClock, fillerId = fillerIdHash(FILLER)) {
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
    fillerId,
  };
  const orderHash = hashOrder(order, { chainId: 56n, router: SRC_ROUTER });
  src.router(SRC_ROUTER).openIntent(orderHash, { refundAfter: nowS + 600n + 3_600n, openedAt: nowS - 50n, atBlock: 90n });
  dst.router(DST_ROUTER).ticketSigners.add(ticketSigner.address);
  dst.token(TOKEN).setBalance(fill.address, 1_000n).approve(fill.address, DST_ROUTER, 1_000n);
  dst.nativeBalances.set(fill.address.toLowerCase(), 10n ** 16n);
  return { src, dst, order, orderHash, nowS };
}

/** A started filler, logged in over the fake socket. */
async function runtime() {
  const clock = new FakeClock();
  const store = new InMemoryFillerStore(clock);
  const w = world(clock);
  const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
  const ws = createFakeWebSocketFactory();
  const login = createFakeGatewayLogin(gateway, { fillerId: FILLER, clock, heartbeatIntervalMs: 60_000 });
  const offers: unknown[] = [];
  const reconfirms: unknown[] = [];
  const filler: Filler = createFiller({
    gatewayUrl: 'wss://filler-gateway.example/v1',
    fillerId: FILLER,
    gatewaySigner: gateway.address,
    ticketSigners: [ticketSigner.address],
    quoteSigner: quote,
    fillSigners: { 'eip155:1': fill },
    rpc: { 'eip155:56': [w.src], 'eip155:1': [w.dst] },
    chains: { 'eip155:56': { router: SRC_ROUTER, ...POLICY }, 'eip155:1': { router: DST_ROUTER, ...POLICY } },
    tickets: { deltaIssueMs: 3_000 },
    store,
    webSocket: ws.factory,
    fetch: createFakeFetch(login.routes).fetch,
    clock,
    events: createRecordingEventSink(),
    logger: createRecordingLogger(),
    instanceId: 'replica-1',
  });
  filler.onQuoteRequest(async () => null);
  filler.onReconfirm(async (r) => {
    reconfirms.push(r);
    return true;
  });
  filler.onTicketOffer(async (o) => {
    offers.push(o);
    return 'accept';
  });
  const started = filler.start();
  await settle();
  const socket: FakeSocket = ws.sockets[0]!;
  login.accept(socket);
  await started;
  await settle();

  const receive = async (frame: FrameBody) => {
    socket.receive(gateway.frame(frame));
    await settle();
  };
  const offer = (attempt: number, id: string) => ({
    type: 'ticket.offer',
    id,
    fillerId: FILLER,
    orderHash: w.orderHash,
    attempt,
    order: w.order,
    amountOut: '99',
    validFrom: String(w.nowS),
    validUntil: String(w.nowS + 300n),
    acceptBy: clock.now() + 5_000,
  });
  const reconfirm = (order: OrderJson, orderHash: Hex, id: string) => ({
    type: 'quote.reconfirm',
    id,
    fillerId: FILLER,
    orderHash,
    requestId: `rq-${id}`,
    order,
    amountOut: order.minReceived,
    ticketTtl: 180,
    replyBy: clock.now() + 2_000,
  });
  const sent = (type: string) => socket.sentFrames().filter((f) => f.type === type);
  const ticket = (attempt: number) => store.withOrder(w.orderHash, (tx) => tx.getTicket(attempt));
  return { clock, w, filler, offers, reconfirms, receive, offer, reconfirm, sent, ticket };
}

describe('CAN-2482: one ticket attempt per order, reconfirm only for the picked filler', () => {
  test('TC-SDK-2482-01: the first offer of an order goes to the hook and is answered with ticket.intent', async () => {
    const r = await runtime();
    await r.receive(r.offer(0, 'g-offer-0'));
    expect(r.offers).toHaveLength(1);
    expect(r.sent('ticket.intent')).toContainEqual(expect.objectContaining({ orderHash: r.w.orderHash, attempt: 0, fillerId: FILLER }));
    expect(r.sent('ticket.decline')).toHaveLength(0);
    await r.filler.stop();
  });

  test('TC-SDK-2482-02: after ticket.expired a later attempt of the same order is declined as stale, without the hook', async () => {
    const r = await runtime();
    await r.receive(r.offer(0, 'g-offer-0'));
    await r.receive({ type: 'ticket.expired', id: 'g-expired-0', fillerId: FILLER, orderHash: r.w.orderHash, attempt: 0, result: 'NO_SHOW' });
    await r.receive(r.offer(1, 'g-offer-1'));
    expect(r.offers).toHaveLength(1);
    expect(r.sent('ticket.intent').filter((i) => i.attempt === 1)).toHaveLength(0);
    expect(r.sent('ticket.decline')).toContainEqual(expect.objectContaining({ orderHash: r.w.orderHash, attempt: 1, reason: 'OTHER', detail: expect.stringContaining('stale') }));
    expect(await r.ticket(1)).toMatchObject({ state: 'declined' });
    await r.filler.stop();
  });

  test('TC-SDK-2482-03: a later attempt while the first is still open is declined as stale too; the first stays as it was', async () => {
    const r = await runtime();
    await r.receive(r.offer(0, 'g-offer-0'));
    const before = (await r.ticket(0))?.state;
    await r.receive(r.offer(1, 'g-offer-1'));
    expect(r.offers).toHaveLength(1);
    expect(r.sent('ticket.decline')).toContainEqual(expect.objectContaining({ attempt: 1, reason: 'OTHER', detail: expect.stringContaining('stale') }));
    expect((await r.ticket(0))?.state).toBe(before);
    await r.filler.stop();
  });

  test('TC-SDK-2482-04: a reconfirm of an order that names this filler asks the hook and is answered at order.minReceived', async () => {
    const r = await runtime();
    await r.receive(r.reconfirm(r.w.order, r.w.orderHash, 'g-reconfirm-own'));
    expect(r.reconfirms).toHaveLength(1);
    expect(r.sent('quote.reconfirm.reply')).toContainEqual(expect.objectContaining({ orderHash: r.w.orderHash, accept: true }));
    await r.filler.stop();
  });

  test("TC-SDK-2482-05: a reconfirm of another filler's order is dropped: no reply, the hook is not asked", async () => {
    const r = await runtime();
    const other = world(r.clock, fillerIdHash('someone-else'));
    await r.receive(r.reconfirm(other.order, other.orderHash, 'g-reconfirm-other'));
    expect(r.reconfirms).toHaveLength(0);
    expect(r.sent('quote.reconfirm.reply')).toHaveLength(0);
    await r.filler.stop();
  });
});
