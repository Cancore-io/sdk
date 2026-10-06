import { FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, type Hex, type OrderJson, type TicketIssued, type TicketOffer } from '@cancore/contracts';
import { hashOrder } from '../chain';
import { createFiller } from '../filler';
import type { FillSigner } from '../signer';
import { createFakeFetch, createFakeWebSocketFactory, createTestGatewaySigner, createTestTypedDataSigner, FakeChain, FakeClock, InMemoryFillerStore } from '../testing';

// filler.verifyEscrow() through createFiller: V-T4 measures when ticket.issued ARRIVED (recorded by the protocol
// client in the frame's own store transaction), not when the check runs.

const QUOTE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const GATEWAY_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const SRC_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
const DST_ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const TOKEN: Hex = '0x00000000000000000000000000000000000000aa';
const FILLER = 'acme-1';
const POLICY = { openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n };

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function setup() {
  const clock = new FakeClock();
  const nowS = BigInt(Math.floor(clock.now() / 1000));
  const fill: FillSigner = { ...createTestTypedDataSigner(FILL_KEY), signTransaction: async () => '0x02' };
  const ticketSigner = createTestTypedDataSigner(TICKET_KEY);
  const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
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
  const src = new FakeChain(56n, 'bsc');
  const dst = new FakeChain(1n, 'eth');
  src.router(SRC_ROUTER).openIntent(orderHash, { refundAfter: nowS + 600n + 3_600n, openedAt: nowS - 50n, atBlock: 90n });
  dst.router(DST_ROUTER).ticketSigners.add(ticketSigner.address);
  dst.token(TOKEN).setBalance(fill.address, 1_000n).approve(fill.address, DST_ROUTER, 1_000n);
  dst.nativeBalances.set(fill.address.toLowerCase(), 10n ** 16n);

  const store = new InMemoryFillerStore(clock);
  const ws = createFakeWebSocketFactory();
  const filler = createFiller({
    gatewayUrl: 'wss://filler-gateway.example/v1',
    fillerId: FILLER,
    gatewaySigner: gateway.address,
    ticketSigners: [ticketSigner.address],
    quoteSigner: createTestTypedDataSigner(QUOTE_KEY),
    fillSigners: { 'eip155:1': fill },
    rpc: { 'eip155:56': [src], 'eip155:1': [dst] },
    chains: { 'eip155:56': { router: SRC_ROUTER, ...POLICY }, 'eip155:1': { router: DST_ROUTER, ...POLICY } },
    tickets: { deltaIssueMs: 3_000 },
    store,
    webSocket: ws.factory,
    fetch: createFakeFetch().fetch,
    clock,
    instanceId: 'replica-1',
  });
  filler.onQuoteRequest(async () => null);
  filler.onReconfirm(async () => false);
  filler.onTicketOffer(async () => 'decline');
  const started = filler.start();
  const socket = ws.sockets[0]!;
  socket.open();
  socket.receive(gateway.frame({ type: 'auth.challenge', nonce: `0x${'ab'.repeat(32)}`, expiresAt: String(Math.floor(clock.now() / 1000) + 30) }));
  await settle();
  socket.receive(gateway.frame({ type: 'auth.ok', fillerId: FILLER, heartbeatIntervalMs: 600_000, re: socket.sentFrames()[0]!.id }));
  await started;

  const offer = {
    type: 'ticket.offer', fillerId: FILLER, sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, order, amountOut: '99',
    validFrom: String(nowS), validUntil: String(nowS + 300n), acceptBy: clock.now() + 5_000,
  } as TicketOffer;
  // The offer as the ticket flow (CAN-1861) stores it.
  await store.withOrder(orderHash, (tx) => tx.putTicket({ orderHash, attempt: 0, state: 'intent-acked', offer, updatedAtMs: clock.now() }));
  const ticket = { orderHash, filler: fill.address, attempt: 0, validFrom: offer.validFrom, validUntil: offer.validUntil };
  const ticketSig = await ticketSigner.signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
  const issued = gateway.frame({ type: 'ticket.issued', fillerId: FILLER, form: 'evm', orderHash, attempt: 0, ticket, ticketSig });
  return { clock, store, socket, filler, offer, issued, orderHash };
}

describe('V-T4 measures the arrival of ticket.issued, not the check', () => {
  test('arrived in time, checked after acceptBy + δ_issue: ok', async () => {
    const h = await setup();
    h.socket.receive(h.issued);
    await settle();
    const arrivedAt = h.clock.now();
    expect((await h.store.withOrder(h.orderHash, (tx) => tx.getTicket(0)))!.issuedAtMs).toBe(arrivedAt);
    h.clock.advance(5_000 + 3_000 + 10_000);
    await expect(h.filler.verifyEscrow(h.issued as unknown as TicketIssued)).resolves.toMatchObject({ ok: true });
    await h.filler.stop();
  });

  test('a redelivery does not move the arrival time', async () => {
    const h = await setup();
    h.socket.receive(h.issued);
    await settle();
    const first = (await h.store.withOrder(h.orderHash, (tx) => tx.getTicket(0)))!.issuedAtMs;
    h.clock.advance(20_000);
    h.socket.receive(h.issued);
    await settle();
    expect((await h.store.withOrder(h.orderHash, (tx) => tx.getTicket(0)))!.issuedAtMs).toBe(first);
    await h.filler.stop();
  });

  test('arrived after acceptBy + δ_issue: TICKET_ISSUED_LATE', async () => {
    const h = await setup();
    h.clock.advance(5_000 + 3_001);
    h.socket.receive(h.issued);
    await settle();
    await expect(h.filler.verifyEscrow(h.issued as unknown as TicketIssued)).resolves.toMatchObject({ ok: false, reason: 'TICKET_ISSUED_LATE' });
    await h.filler.stop();
  });

  test('no recorded arrival: unverifiable, refused — never taken as «now»', async () => {
    const h = await setup();
    await expect(h.filler.verifyEscrow(h.issued as unknown as TicketIssued)).resolves.toMatchObject({
      ok: false,
      reason: 'TICKET_ISSUED_LATE',
      detail: expect.stringMatching(/unverifiable/),
    });
    await h.filler.stop();
  });
});
