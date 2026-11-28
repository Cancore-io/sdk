/**
 * A Canton-form ticket (CAN-1867): the order's Canton destination, the
 * `DeliveryOrder` held to the ticket and the offered order, and the
 * `CantonTicketReceipt` the filler signs. The chain checks (V-E1…V-E5) run
 * against the real router on the stand: `test/canton-delivery.int.test.ts`.
 */
import {
  cantonTicketReceipt,
  encodeCantonAmount,
  encodeCantonDestination,
  encodeCantonOutputAsset,
  encodeCantonRecipient,
  fillerIdHash,
  hashCantonTicketReceipt,
  repayToFromEvm,
  type CantonDeliveryOrder,
  type CantonRecipientReadiness,
  type Hex,
  type OrderJson,
  type TicketIssuedCanton,
  type TicketOffer,
} from '@cancore/contracts';
import { FillerChains, hashOrder, type OpenDepth } from '../chain';
import { recoverAddress } from '../signer';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, FakeChain, FakeClock } from '../testing';
import { deliveryOrderMismatch } from './canton-ticket';
import { TicketVerifier } from './checks';
import { chainsOf, signCantonTicketReceipt } from './terms';

const MESSAGE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const asset = { admin: 'cancore::1220aa', id: 'CNRX' };
const RECIPIENT = 'alice::1220cd';
const issued: TicketIssuedCanton = {
  type: 'ticket.issued', form: 'canton', id: 'f-1', fillerId: 'cancore-dev-1', ts: 0, msgSig: '0x', orderHash: `0x${'5a'.repeat(32)}`, attempt: 2,
  deliveryOrderCid: `00${'0d'.repeat(33)}`, validUntil: '1790000120', repayTo: `0x${'00'.repeat(12)}${'7e'.repeat(20)}`,
} as unknown as TicketIssuedCanton;
const order: CantonDeliveryOrder = {
  deliveryOrderCid: issued.deliveryOrderCid, orderHash: issued.orderHash, attempt: 2, asset, amount: '25.0000000000', recipient: RECIPIENT, repayTo: issued.repayTo, validFrom: '1790000000', validUntil: issued.validUntil,
};
const offered = { recipient: encodeCantonRecipient(RECIPIENT), outputAsset: encodeCantonOutputAsset(asset) };
const bounds = { validFrom: '1790000000', minReceived: encodeCantonAmount('25'), amountOut: encodeCantonAmount('25') };

describe('the order’s Canton destination (CAN-1867)', () => {
  test('TC-SDK-1867-30: keccak256("canton:devnet") is a Canton destination, never an eip155 chain, whatever its top bit', () => {
    const chains = chainsOf({ originChainId: '11155111', destination: encodeCantonDestination('devnet') } as never);
    expect(chains).toEqual({ origin: 11155111n, source: 'eip155:11155111', canton: 'devnet' });
    expect(chainsOf({ originChainId: '11155111', destination: `0x${'00'.repeat(31)}01` } as never)).toEqual({ origin: 11155111n, source: 'eip155:11155111', destination: 'eip155:1' });
  });
});

describe('the DeliveryOrder of a Canton-form ticket (CAN-1867)', () => {
  test('TC-SDK-1867-31: the DeliveryOrder that repeats the ticket and the order passes', () => {
    expect(deliveryOrderMismatch(order, issued, offered, bounds)).toBeUndefined();
  });

  test('BUG-1645: a DeliveryOrder from a gateway that predates validFrom (no field) is checked as before', () => {
    expect(deliveryOrderMismatch({ ...order, validFrom: undefined }, issued, offered, bounds)).toBeUndefined();
  });

  test.each([
    ['another order', { orderHash: `0x${'5b'.repeat(32)}` }, 'orderHash'],
    ['BUG-1645 legacy opening time', { validFrom: null }, 'validFrom'],
    ['BUG-1645 earlier opening time', { validFrom: '1789999999' }, 'validFrom'],
    ['another attempt', { attempt: 3 }, 'attempt'],
    ['another validUntil', { validUntil: '1790000180' }, 'validUntil'],
    ['T-48: another repayTo than the signed ticket.intent', { repayTo: `0x${'00'.repeat(12)}${'66'.repeat(20)}` }, 'repayTo'],
    ['another recipient', { recipient: 'mallory::1220ee' }, 'recipient'],
    ['another instrument', { asset: { ...asset, id: 'CC' } }, 'asset'],
    ['an amount below minReceived', { amount: '24.9999999999' }, 'amount'],
    ['an amount above the filler’s quote', { amount: '25.0000000001' }, 'amount'],
    ['an amount not exact at 10⁻¹⁰', { amount: '25.00000000001' }, 'amount'],
  ])('TC-SDK-1867-32: %s is a mismatch', (_name, over, field) => {
    expect(deliveryOrderMismatch({ ...order, ...over } as CantonDeliveryOrder, issued, offered, bounds)).toBe(field);
  });
});

describe('the Canton-form receipt (CAN-1867, T-22)', () => {
  test('TC-SDK-1867-33: ticket.receipt {form: "canton"} carries the ticket’s fields and a CantonTicketReceipt signature by the message key', async () => {
    const signer = createTestTypedDataSigner(MESSAGE_KEY);
    const receipt = await signCantonTicketReceipt(issued, signer, 'r-1');
    expect(receipt).toMatchObject({ type: 'ticket.receipt', form: 'canton', orderHash: issued.orderHash, attempt: 2, deliveryOrderCid: issued.deliveryOrderCid, validUntil: issued.validUntil });
    expect(receipt).not.toHaveProperty('ticketHash');
    expect(recoverAddress(hashCantonTicketReceipt(cantonTicketReceipt(issued)), receipt.sig)).toBe(signer.address.toLowerCase());
  });
});

describe('CAN-2808: V-E2 of a Canton-form ticket reads at the openConfirmations tag', () => {
  const SOURCE_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
  const PARTY = `filler::1220${'6c'.repeat(32)}`;
  const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const CANTON_POLICY = { minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30 };

  /** Cancore's readiness read about `order`: ready, as trading saw it before it issued the ticket. */
  const readyAbout = (order: CantonDeliveryOrder): CantonRecipientReadiness => ({
    orderHash: order.orderHash, deliveryOrderCid: order.deliveryOrderCid, recipient: order.recipient, asset: order.asset, ready: true, reason: null,
  });

  function cantonFormTicket(openConfirmations: OpenDepth, readiness: (order: CantonDeliveryOrder) => Promise<CantonRecipientReadiness> = async (o) => readyAbout(o)) {
    const clock = new FakeClock();
    const nowS = BigInt(Math.floor(clock.now() / 1000));
    const source = new FakeChain(11155111n, 'sepolia');
    const fill = createTestFillSigner(FILL_KEY);
    const repayTo = repayToFromEvm(fill.address);
    const offeredOrder: OrderJson = {
      user: `0x${'11'.repeat(20)}`, originChainId: '11155111', inputToken: `0x${'22'.repeat(20)}`, inputAmount: '1000',
      destination: encodeCantonDestination('devnet'), outputAsset: encodeCantonOutputAsset(asset), minReceived: encodeCantonAmount('25').toString(),
      recipient: encodeCantonRecipient(RECIPIENT), createdAt: String(nowS - 60n), fillDeadline: String(nowS + 600n), feeBps: '30', fillerId: fillerIdHash('cancore-dev-1'),
    };
    const orderHash = hashOrder(offeredOrder, { chainId: 11155111n, router: SOURCE_ROUTER });
    const validUntil = String(nowS + 300n);
    const deliveryOrderCid = `00${'0d'.repeat(33)}`;
    const offer = {
      type: 'ticket.offer', id: 'g-1', fillerId: 'cancore-dev-1', sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, order: offeredOrder,
      amountOut: offeredOrder.minReceived, validFrom: String(nowS), validUntil, acceptBy: clock.now() + 5_000,
    } as TicketOffer;
    const cantonIssued = { type: 'ticket.issued', form: 'canton', fillerId: 'cancore-dev-1', orderHash, attempt: 0, deliveryOrderCid, validUntil, repayTo } as unknown as TicketIssuedCanton;
    const deliveryOrder: CantonDeliveryOrder = { deliveryOrderCid, orderHash, attempt: 0, asset, amount: '25.0000000000', recipient: RECIPIENT, repayTo, validFrom: String(nowS), validUntil };
    const escrow = source.router(SOURCE_ROUTER).openIntent(orderHash, { refundAfter: BigInt(offeredOrder.fillDeadline) + 3_600n, openedAt: nowS - 50n }).intents.get(orderHash)!;

    const logger = createRecordingLogger();
    const chains = new FillerChains(
      { 'eip155:11155111': [source] },
      { 'eip155:11155111': { router: SOURCE_ROUTER, openConfirmations, maxHeadLagBlocks: 5, minGasWei: 0n, ...CANTON_POLICY } },
      logger,
    );
    const verifier = new TicketVerifier({
      chains, fillSigners: { 'eip155:11155111': fill }, fillerId: 'cancore-dev-1', cantonParty: PARTY, ticketSigners: [], deltaIssueMs: 3_000,
      clock, events: createRecordingEventSink(), logger,
      canton: {
        party: PARTY, policy: CANTON_POLICY,
        deliveryOrders: async () => [deliveryOrder],
        holdings: async () => [{ contractId: '00h1', asset, amount: '100.0000000000', locked: false }],
        recipientReadiness: async () => readiness(deliveryOrder),
      },
    });
    const escrowReadBlocks = () =>
      source.calls
        .filter((c) => c.method === 'eth_call' && (c.params![0] as { to: string }).to === SOURCE_ROUTER)
        .map((c) => source.numberOfHash((c.params![1] as { blockHash: string }).blockHash));
    return { source, escrow, deliveryOrder, verify: () => verifier.verify({ offer, issued: cantonIssued, issuedAtMs: clock.now() }), escrowReadBlocks };
  }

  test.each(['safe', 'finalized'] as const)('CAN-2808: an escrow opened at the %s block is open; the read is pinned to that block', async (tag) => {
    const t = cantonFormTicket(tag);
    t.source[tag] = 95n;
    t.escrow.atBlock = 95n;
    await expect(t.verify()).resolves.toMatchObject({ ok: true });
    expect(t.escrowReadBlocks()).toEqual([95n]);
  });

  test.each(['safe', 'finalized'] as const)('CAN-2808: an escrow opened one block above the %s block is refused ESCROW_NOT_OPEN', async (tag) => {
    const t = cantonFormTicket(tag);
    t.source[tag] = 95n;
    t.escrow.atBlock = 96n;
    const result = await t.verify();
    expect(result).toMatchObject({ ok: false, reason: 'ESCROW_NOT_OPEN', detail: `V-E2: status 0 at the ${tag} block` });
    expect(result.checks.at(-1)).toMatchObject({ check: 'V-E2', status: 'failed' });
  });

  test('CAN-2808: a numeric openConfirmations reads head − N + 1', async () => {
    const t = cantonFormTicket(3);
    t.source.safe = 50n;
    t.escrow.atBlock = 98n;
    await expect(t.verify()).resolves.toMatchObject({ ok: true });
    expect(t.escrowReadBlocks()).toEqual([98n]);
  });

  test('BUG-1645: a ledger window opening one second before expiry is refused before receipt', async () => {
    const t = cantonFormTicket(3);
    t.deliveryOrder.validFrom = String(BigInt(t.deliveryOrder.validUntil) - 1n);
    const result = await t.verify();
    expect(result).toMatchObject({ ok: false, reason: 'TICKET_MISMATCH', detail: expect.stringContaining('DeliveryOrder.validFrom') });
    expect(result.checks.at(-1)).toMatchObject({ check: 'V-T2', status: 'failed' });
  });

  test('BUG-1609: V-E2 refuses a ticket whose validFrom is one second before the escrow openedAt (ESCROW_MISMATCH); exactly at it passes', async () => {
    const t = cantonFormTicket(3);
    t.escrow.openedAt += 51n; // openedAt = offer.validFrom + 1
    const result = await t.verify();
    expect(result).toMatchObject({ ok: false, reason: 'ESCROW_MISMATCH', detail: expect.stringContaining('V-E2') });
    expect(result.checks.at(-1)).toMatchObject({ check: 'V-E2', status: 'failed' });
    t.escrow.openedAt -= 1n;
    await expect(t.verify()).resolves.toMatchObject({ ok: true });
  });

  test('TC-SDK-1867-50: V-R1 — a recipient whose preapproval is gone is declined RECIPIENT_NOT_READY, no receipt', async () => {
    const t = cantonFormTicket(3, async (o) => ({ ...readyAbout(o), ready: false, reason: 'RECIPIENT_NOT_READY' }));
    await expect(t.verify()).resolves.toMatchObject({ ok: false, reason: 'RECIPIENT_NOT_READY', detail: expect.stringContaining('V-R1') });
  });

  test.each([
    ['another order', (o: CantonDeliveryOrder) => ({ ...readyAbout(o), orderHash: `0x${'ab'.repeat(32)}` as Hex })],
    ['another DeliveryOrder', (o: CantonDeliveryOrder) => ({ ...readyAbout(o), deliveryOrderCid: `00${'ee'.repeat(33)}` })],
    ['another recipient', (o: CantonDeliveryOrder) => ({ ...readyAbout(o), recipient: 'mallory::1220ef' })],
    ['another instrument', (o: CantonDeliveryOrder) => ({ ...readyAbout(o), asset: { ...o.asset, id: 'USDCx' } })],
  ])('TC-SDK-1867-51: V-R1 — a ready answer about %s is no answer: declined OTHER', async (_about, answer) => {
    const t = cantonFormTicket(3, async (o) => answer(o));
    await expect(t.verify()).resolves.toMatchObject({ ok: false, reason: 'OTHER', detail: expect.stringContaining('V-R1') });
  });

  test('TC-SDK-1867-52: V-R1 — a readiness that cannot be read is declined OTHER (N-12), never a receipt', async () => {
    const t = cantonFormTicket(3, async () => {
      throw new Error('filler-gateway unreachable');
    });
    await expect(t.verify()).resolves.toMatchObject({ ok: false, reason: 'OTHER', detail: expect.stringContaining('V-R1') });
  });
});
