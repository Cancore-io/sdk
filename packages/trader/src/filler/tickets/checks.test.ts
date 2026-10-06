import { FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, type Hex, type OrderJson, type TicketIssuedEvm, type TicketOffer } from '@cancore/contracts';
import { FillerChains, hashOrder, type ChainConfig } from '../chain';
import type { FillSigner } from '../signer';
import { createRecordingEventSink, createRecordingLogger, createTestTypedDataSigner, FakeChain, FakeClock } from '../testing';
import { TicketVerifier, type TicketCheckInput } from './checks';

const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const STRANGER_KEY: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const SRC_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
const DST_ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const TOKEN: Hex = '0x00000000000000000000000000000000000000aa';

const fill: FillSigner = { ...createTestTypedDataSigner(FILL_KEY), signTransaction: async () => '0x02' };
const ticketSigner = createTestTypedDataSigner(TICKET_KEY);
const stranger = createTestTypedDataSigner(STRANGER_KEY);
const POLICY = { maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n };

interface Shape {
  order?: Partial<OrderJson>;
  validFrom?: bigint;
  validUntil?: bigint;
  amountOut?: string;
  /** Applied to the ticket after the offer is built (to break V-T2). */
  ticket?: Record<string, unknown>;
  signer?: typeof ticketSigner;
  refundAfter?: bigint;
}

async function setup(shape: Shape = {}) {
  const clock = new FakeClock();
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
    ...shape.order,
  };
  const orderHash = hashOrder({ ...order, ...{} }, { chainId: 56n, router: SRC_ROUTER });
  const validFrom = shape.validFrom ?? nowS;
  const validUntil = shape.validUntil ?? nowS + 300n;

  src.router(SRC_ROUTER).openIntent(orderHash, { refundAfter: shape.refundAfter ?? BigInt(order.fillDeadline) + 3_600n, openedAt: nowS - 50n, atBlock: 90n });
  const dstRouter = dst.router(DST_ROUTER);
  dstRouter.ticketSigners.add(ticketSigner.address);
  dst.token(TOKEN).setBalance(fill.address, 1_000n).approve(fill.address, DST_ROUTER, 1_000n);
  dst.nativeBalances.set(fill.address.toLowerCase(), 10n ** 16n);

  const offer: TicketOffer = {
    type: 'ticket.offer',
    fillerId: 'acme-1',
    sentAt: clock.now(),
    sig: '0x',
    orderHash,
    attempt: 0,
    order,
    amountOut: shape.amountOut ?? '99',
    validFrom: String(validFrom),
    validUntil: String(validUntil),
    acceptBy: clock.now() + 5_000,
  };
  const ticket = { orderHash, filler: fill.address, attempt: 0, validFrom: String(validFrom), validUntil: String(validUntil), ...shape.ticket };
  const ticketSig = await (shape.signer ?? ticketSigner).signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
  const issued = { type: 'ticket.issued', form: 'evm', fillerId: 'acme-1', sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, ticket, ticketSig } as unknown as TicketIssuedEvm;

  const config = (chain: Hex, openConfirmations: number): ChainConfig => ({ router: chain, openConfirmations, ...POLICY });
  const logger = createRecordingLogger();
  const events = createRecordingEventSink();
  const chains = new FillerChains({ 'eip155:56': [src], 'eip155:1': [dst] }, { 'eip155:56': config(SRC_ROUTER, 3), 'eip155:1': config(DST_ROUTER, 3) }, logger);
  const verifier = new TicketVerifier({ chains, fillSigners: { 'eip155:1': fill }, ticketSigners: [ticketSigner.address], deltaIssueMs: 3_000, clock, events, logger });
  const input: TicketCheckInput = { offer, issued, issuedAtMs: clock.now() };
  return { clock, src, dst, dstRouter, offer, issued, input, verifier, events, orderHash, nowS };
}

const ORDER_OF_CHECKS = ['form', 'V-T4', 'V-T2', 'V-T3', 'V-E1', 'V-E2', 'V-E3', 'V-T1', 'V-E4', 'V-E5'];

describe('all checks pass: { ok: true }, every check reported to the EventSink', () => {
  test('happy path', async () => {
    const h = await setup();
    const result = await h.verifier.verify(h.input);
    expect(result).toMatchObject({ ok: true });
    expect(result.checks.map((c) => c.check)).toEqual(ORDER_OF_CHECKS);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks.find((c) => c.check === 'V-E4')!.detail).toMatch(/CAN-2151/);
    const stages = h.events.events.filter((e) => e.type === 'stage' && e.stage === 'ticket.checked');
    expect(stages).toHaveLength(ORDER_OF_CHECKS.length);
    expect(stages[0]).toMatchObject({ orderHash: h.orderHash, attempt: 0, detail: { check: 'form', ok: true } });
  });

  test('only the pinned routers and the output token are read, with the node RPC', async () => {
    const h = await setup();
    await h.verifier.verify(h.input);
    const targets = (chain: FakeChain) => new Set(chain.calls.filter((c) => c.method === 'eth_call').map((c) => (c.params![0] as { to: string }).to));
    expect(targets(h.src)).toEqual(new Set([SRC_ROUTER]));
    expect(targets(h.dst)).toEqual(new Set([DST_ROUTER, TOKEN]));
  });

  test('the escrow is read openConfirmations deep', async () => {
    const h = await setup();
    await h.verifier.verify(h.input);
    expect(h.src.calls.filter((c) => c.method === 'eth_call').map((c) => BigInt(c.params![1] as string))).toEqual([97n]);
  });
});

describe('each check refuses with its own code, and nothing after it runs', () => {
  type Case = [name: string, shape: Shape, mutate: ((h: Awaited<ReturnType<typeof setup>>) => void) | undefined, check: string, reason: string];
  const cases: Case[] = [
    ['V-T4: ticket.issued after acceptBy + δ_issue', {}, (h) => void (h.input.issuedAtMs = h.offer.acceptBy + 3_001), 'V-T4', 'TICKET_ISSUED_LATE'],
    ['V-T2: the ticket names another filler', { ticket: { filler: stranger.address } }, undefined, 'V-T2', 'TICKET_MISMATCH'],
    ['V-T2: another attempt in the ticket', { ticket: { attempt: 1 } }, undefined, 'V-T2', 'TICKET_MISMATCH'],
    ['V-T2: another validUntil than the offer', { ticket: { validUntil: '1790000301' } }, undefined, 'V-T2', 'TICKET_MISMATCH'],
    ['V-T2: another validFrom than the signed intent', {}, (h) => void (h.input.intent = { type: 'ticket.intent', id: 'i', orderHash: h.orderHash, attempt: 0, validFrom: '1', validUntil: h.offer.validUntil, sig: '0x' }), 'V-T2', 'TICKET_MISMATCH'],
    ['V-T2: the frame names another order than the offer', {}, (h) => void ((h.issued as { orderHash: Hex }).orderHash = `0x${'cd'.repeat(32)}`), 'V-T2', 'TICKET_MISMATCH'],
    ['V-T3: validUntil equals fillDeadline', {}, undefined, 'V-T3', 'TICKET_BEYOND_DEADLINE'],
    ['V-T3: validUntil − validFrom below MIN_TICKET_TTL', {}, undefined, 'V-T3', 'TICKET_TTL_TOO_SHORT'],
    ['V-T3: less than sendGuard left', {}, (h) => h.clock.advance(271_000), 'V-T3', 'TICKET_TTL_TOO_SHORT'],
    ['V-E1: the offered order is not the one hashed', {}, (h) => void (h.offer.order = { ...h.offer.order, minReceived: '98' }), 'V-E1', 'ESCROW_MISMATCH'],
    ['V-E2: no escrow on the source router', {}, (h) => h.src.router(SRC_ROUTER).intents.clear(), 'V-E2', 'ESCROW_NOT_OPEN'],
    ['V-E2: the escrow is already settled', {}, (h) => void (h.src.router(SRC_ROUTER).intents.get(h.orderHash)!.status = 2), 'V-E2', 'ESCROW_NOT_OPEN'],
    ['V-E2: opened openConfirmations − 1 deep', {}, (h) => void (h.src.router(SRC_ROUTER).intents.get(h.orderHash)!.atBlock = 98n), 'V-E2', 'ESCROW_NOT_OPEN'],
    ['V-E2: the source RPC is down (N-12)', {}, (h) => void (h.src.down = true), 'V-E2', 'ESCROW_NOT_OPEN'],
    ['V-E3: refundAfter − fillDeadline one second short', { refundAfter: undefined }, (h) => void (h.src.router(SRC_ROUTER).intents.get(h.orderHash)!.refundAfter = BigInt(h.offer.order.fillDeadline) + 2_699n), 'V-E3', 'PROOF_WINDOW_TOO_SHORT'],
    ['V-T1: signed by a key that is not a ticket signer', { signer: stranger }, undefined, 'V-T1', 'TICKET_SIGNER_UNKNOWN'],
    ['V-T1: pinned, but not registered on the destination router', {}, (h) => h.dstRouter.ticketSigners.clear(), 'V-T1', 'TICKET_SIGNER_UNKNOWN'],
    ['V-T1: a malformed ticketSig', {}, (h) => void ((h.issued as { ticketSig: Hex }).ticketSig = `0x${'00'.repeat(65)}`), 'V-T1', 'TICKET_SIGNER_UNKNOWN'],
    ['V-T1: the destination RPC is down (N-12)', {}, (h) => void (h.dst.down = true), 'V-T1', 'TICKET_SIGNER_UNKNOWN'],
    ['V-E5: the order is already filled on the destination', {}, (h) => void h.dstRouter.filled.set(h.orderHash, 50n), 'V-E5', 'OTHER'],
    ['V-E5: balance below amountOut', { amountOut: '1001' }, (h) => h.dst.token(TOKEN).approve(fill.address, DST_ROUTER, 10_000n), 'V-E5', 'NO_INVENTORY'],
    ['V-E5: allowance below amountOut', {}, (h) => h.dst.token(TOKEN).approve(fill.address, DST_ROUTER, 98n), 'V-E5', 'NO_INVENTORY'],
    ['V-E5: no gas at the delivery address', {}, (h) => void h.dst.nativeBalances.set(fill.address.toLowerCase(), 10n ** 15n - 1n), 'V-E5', 'NO_INVENTORY'],
    ['form: a Canton-form ticket (CAN-1867)', {}, (h) => void ((h.input as { issued: unknown }).issued = { ...h.issued, form: 'canton' }), 'form', 'OTHER'],
    ['form: a Canton source (CAN-1863)', {}, (h) => void (h.offer.order = { ...h.offer.order, originChainId: '9223372036854775809' }), 'form', 'OTHER'],
    ['form: a destination with no router configured', {}, (h) => void (h.offer.order = { ...h.offer.order, destination: `0x${'00'.repeat(31)}89` }), 'form', 'OTHER'],
  ];

  test.each(cases)('%s', async (name, shape, mutate, check, reason) => {
    const h = await setup(shape);
    const nowS = h.nowS;
    if (name.startsWith('V-T3: validUntil equals fillDeadline')) {
      const g = await setup({ validUntil: nowS + 600n });
      return expectRefusal(g, check, reason);
    }
    if (name.startsWith('V-T3: validUntil − validFrom below')) {
      const g = await setup({ validFrom: nowS, validUntil: nowS + 59n });
      return expectRefusal(g, check, reason);
    }
    mutate?.(h);
    return expectRefusal(h, check, reason);
  });

  async function expectRefusal(h: Awaited<ReturnType<typeof setup>>, check: string, reason: string) {
    const result = await h.verifier.verify(h.input);
    expect(result).toMatchObject({ ok: false, reason });
    const last = result.checks.at(-1)!;
    expect(last).toMatchObject({ check, ok: false, reason });
    expect(result.checks.map((c) => c.check)).toEqual(ORDER_OF_CHECKS.slice(0, ORDER_OF_CHECKS.indexOf(check) + 1));
    expect(h.events.events.filter((e) => e.type === 'stage' && e.stage === 'ticket.checked')).toHaveLength(result.checks.length);
  }
});

describe('boundaries pass', () => {
  test('ticket.issued exactly at acceptBy + δ_issue', async () => {
    const h = await setup();
    h.input.issuedAtMs = h.offer.acceptBy + 3_000;
    await expect(h.verifier.verify(h.input)).resolves.toMatchObject({ ok: true });
  });

  test('validUntil − validFrom exactly MIN_TICKET_TTL; validUntil one second before fillDeadline', async () => {
    const a = await setup({ validUntil: BigInt(Math.floor(1_790_000_000)) + 60n });
    await expect(a.verifier.verify(a.input)).resolves.toMatchObject({ ok: true });
    const b = await setup({ validUntil: BigInt(1_790_000_000) + 599n });
    await expect(b.verifier.verify(b.input)).resolves.toMatchObject({ ok: true });
  });

  test('exactly sendGuard left', async () => {
    const h = await setup();
    h.clock.advance(270_000);
    await expect(h.verifier.verify(h.input)).resolves.toMatchObject({ ok: true });
  });

  test('refundAfter − fillDeadline exactly the required window; the escrow exactly openConfirmations deep', async () => {
    const h = await setup();
    const intent = h.src.router(SRC_ROUTER).intents.get(h.orderHash)!;
    intent.refundAfter = BigInt(h.offer.order.fillDeadline) + 2_700n;
    intent.atBlock = 97n;
    await expect(h.verifier.verify(h.input)).resolves.toMatchObject({ ok: true });
  });

  test('balance, allowance and gas exactly enough', async () => {
    const h = await setup({ amountOut: '1000' });
    h.dst.nativeBalances.set(fill.address.toLowerCase(), 10n ** 15n);
    await expect(h.verifier.verify(h.input)).resolves.toMatchObject({ ok: true });
  });
});
