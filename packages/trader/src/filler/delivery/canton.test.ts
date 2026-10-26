/**
 * The delivery state machine of a Canton-form ticket (CAN-1867, sdk#138
 * review F-1, F-2): once the legs are signed a fill may have committed, so no
 * later failure closes it `failed` — it ends `sent`, outcome unknown, and the
 * settlement adopts the attested proof (TC-SDK-1867-COMP-04 settles such a
 * fill on the real router). A repeat never prepares a second Fill after a
 * commit: the ledger answers `TICKET_CLOSED`, the fill ends `sent`.
 *
 * `operations.fill` is scripted: each call either commits, or fails before or
 * after its `onSigned` hook — the exact boundary `CantonOperations.run` draws.
 */
import {
  encodeCantonAmount,
  encodeCantonDestination,
  encodeCantonOutputAsset,
  encodeCantonRecipient,
  fillerIdHash,
  repayToFromEvm,
  type Hex,
  type OrderJson,
  type TicketIssuedCanton,
  type TicketOffer,
} from '@cancore/contracts';
import { CantonRefusal } from '../canton/legs';
import { CantonSubmitUnknown, type RunHooks } from '../canton/operations';
import { GatewayError } from '../errors';
import type { FillRecord, TicketRecord } from '../store';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, FakeClock, InMemoryFillerStore } from '../testing';
import { CantonDelivery, cantonFillRef } from './canton';
import { LEDGER_CLOCK_SLACK_MS } from './validFrom';
import type { DeliveryResult } from './executor';

const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SOURCE = 'eip155:11155111' as const;
const PARTY = `filler::1220${'6c'.repeat(32)}`;
const ORDER_HASH = `0x${'5a'.repeat(32)}` as Hex;
const START = 1_790_000_000_000;
const ASSET = { admin: `cancore::1220${'4f'.repeat(32)}`, id: 'CNRX' };

type Step = 'commit' | 'refused-before-sign' | 'closed-at-prepare' | 'not-ready' | 'transport-after-sign' | 'closed-after-sign';

function harness(opts: { validUntilSec?: number; validFromSec?: number; script: Step[] }) {
  const clock = new FakeClock(START);
  const store = new InMemoryFillerStore(clock);
  const events = createRecordingEventSink();
  const signer = createTestFillSigner(FILL_KEY);
  const repayTo = repayToFromEvm(signer.address);
  const validUntil = String(opts.validUntilSec ?? START / 1000 + 300);
  const order: OrderJson = {
    user: `0x${'11'.repeat(20)}`, originChainId: '11155111', inputToken: `0x${'22'.repeat(20)}`, inputAmount: '1003000000000000000',
    destination: encodeCantonDestination('devnet'), outputAsset: encodeCantonOutputAsset(ASSET), minReceived: encodeCantonAmount('25').toString(),
    recipient: encodeCantonRecipient(`alice::1220${'cd'.repeat(32)}`), createdAt: String(START / 1000 - 5), fillDeadline: String(START / 1000 + 1_800), feeBps: '30', fillerId: fillerIdHash('cancore-dev-1'),
  } as OrderJson;
  const ticket: TicketRecord = {
    orderHash: ORDER_HASH, attempt: 0, state: 'receipted', sentAtMs: START, updatedAtMs: START,
    offer: { type: 'ticket.offer', orderHash: ORDER_HASH, attempt: 0, order, amountOut: order.minReceived, validFrom: String(START / 1000 - 5), validUntil, acceptBy: START } as unknown as TicketOffer,
    issued: {
      type: 'ticket.issued', form: 'canton', orderHash: ORDER_HASH, attempt: 0, deliveryOrderCid: `00${'0d'.repeat(33)}`, validUntil, repayTo,
      ...(opts.validFromSec !== undefined ? { validFrom: String(opts.validFromSec) } : {}),
    } as unknown as TicketIssuedCanton,
  } as TicketRecord;

  const script = [...opts.script];
  const calls: number[] = [];
  const operations = {
    fill: async (_expect: unknown, hooks: RunHooks = {}) => {
      calls.push(clock.now());
      const step = script.shift() ?? 'closed-at-prepare';
      if (step === 'refused-before-sign') throw new CantonRefusal('-', 'delivery.fill: the root is not DeliveryOrder_Fill');
      if (step === 'closed-at-prepare') throw new GatewayError('TICKET_CLOSED', true, 'the ticket is filled');
      if (step === 'not-ready') throw new GatewayError('CANTON_NOT_READY', true, 'the ticket opens later; fill from then');
      await hooks.onSigned?.('op-1');
      if (step === 'transport-after-sign') throw new CantonSubmitUnknown('delivery.fill', 'op-1', new Error('socket hang up'));
      if (step === 'closed-after-sign') throw new CantonSubmitUnknown('delivery.fill', 'op-1', new GatewayError('TICKET_CLOSED', true, 'already submitted'));
      return { type: 'canton.submitted', op: 'delivery.fill', operationId: 'op-1', updateId: 'upd-1', result: { receiptCid: '00cc' }, delivered: order.minReceived } as never;
    },
  };
  const results: Promise<DeliveryResult>[] = [];
  const make = (instanceId: string) =>
    new CantonDelivery({
      store, operations, sendGuardSec: 20, instanceId, leaseMs: 60_000, retryMs: 2_000, clock, logger: createRecordingLogger(), events,
      fillerId: 'cancore-dev-1', fillSigners: { [SOURCE]: signer }, cantonParty: PARTY,
    });
  const delivery = make('replica-1');
  const run = (d = delivery): Promise<DeliveryResult> => {
    const p = d.deliver(ticket, () => void results.push(run(d)));
    results.push(p);
    return p;
  };
  const fill = () => store.withOrder(ORDER_HASH, (tx) => tx.getFill(0));
  const seed = (record: TicketRecord) => store.withOrder(ORDER_HASH, (tx) => tx.putTicket(record));
  /** Runs timers due within `ms` and waits for every delivery they started. */
  const advance = async (ms: number) => {
    clock.advance(ms);
    await Promise.all(results);
  };
  return { clock, store, events, ticket, run, fill, seed, advance, calls, make };
}

describe('Canton delivery: a commit (CAN-1867)', () => {
  test('TC-SDK-1867-40: committed → confirmed with the update id, the ticket filled, `filled` with fillRef = keccak256(utf8(updateId))', async () => {
    const h = harness({ script: ['commit'] });
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'sent', txHash: cantonFillRef('upd-1') });
    await expect(h.fill()).resolves.toMatchObject<Partial<FillRecord>>({ state: 'confirmed', txRef: 'upd-1', chain: 'canton:devnet', sentAtMs: START });
    expect((await h.store.withOrder(ORDER_HASH, (tx) => tx.getTicket(0)))?.state).toBe('filled');
    expect(h.events.events).toContainEqual(expect.objectContaining({ type: 'filled', txHash: cantonFillRef('upd-1') }));
    // A recorded fill is never prepared again.
    await expect(h.run()).resolves.toMatchObject({ status: 'tracking' });
    expect(h.calls).toHaveLength(1);
  });
});

describe('Canton delivery: not before the order\'s validFrom (CAN-3026)', () => {
  test('TC-SDK-3026-01: a ticket whose validFrom is ahead waits, unclaimed and unprepared, and fills once the clock is LEDGER_CLOCK_SLACK_MS past it', async () => {
    const h = harness({ validFromSec: START / 1000 + 5, script: ['commit'] });
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'waiting', detail: expect.stringContaining('validFrom not reached') });
    expect(h.calls).toHaveLength(0);
    await expect(h.fill()).resolves.toBeUndefined();
    await h.advance(5_000 + LEDGER_CLOCK_SLACK_MS - 1);
    expect(h.calls).toHaveLength(0);
    await h.advance(1);
    expect(h.calls).toEqual([START + 5_000 + LEDGER_CLOCK_SLACK_MS]);
    await expect(h.fill()).resolves.toMatchObject({ state: 'confirmed', txRef: 'upd-1' });
  });

  test('TC-SDK-3026-02: a ticket.issued without validFrom (a gateway that predates it) waits on the offered validFrom', async () => {
    const h = harness({ script: ['commit'] });
    h.ticket.offer = { ...h.ticket.offer!, validFrom: String(START / 1000 + 3) } as TicketOffer;
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'waiting' });
    await h.advance(3_000 + LEDGER_CLOCK_SLACK_MS);
    expect(h.calls).toEqual([START + 3_000 + LEDGER_CLOCK_SLACK_MS]);
  });

  test('TC-SDK-3026-03: trading refuses the prepare before validFrom (CANTON_NOT_READY): retried, nothing signed, then filled', async () => {
    const h = harness({ validFromSec: START / 1000 - 5, script: ['not-ready', 'commit'] });
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'waiting', detail: expect.stringContaining('CANTON_NOT_READY') });
    await expect(h.fill()).resolves.toMatchObject({ state: 'pending' });
    await h.advance(2_000);
    expect(h.calls).toHaveLength(2);
    await expect(h.fill()).resolves.toMatchObject({ state: 'confirmed' });
  });
});

describe('Canton delivery: after the signature nothing ends failed (CAN-1867, review F-1)', () => {
  test('TC-SDK-1867-41: the submit answer is lost, the repeat meets TICKET_CLOSED → sent, outcome unknown; no third prepare', async () => {
    const h = harness({ script: ['transport-after-sign', 'closed-at-prepare'] });
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'waiting' });
    await expect(h.fill()).resolves.toMatchObject({ state: 'pending', sentAtMs: START, leaseUntilMs: 0 });
    await h.advance(2_000);
    await expect(h.fill()).resolves.toMatchObject({ state: 'sent', txRef: '', reason: expect.stringContaining('outcome unknown') });
    expect(h.calls).toHaveLength(2);
    await h.advance(60_000);
    expect(h.calls).toHaveLength(2);
  });

  test('TC-SDK-1867-42: the submit answer is lost and no time is left to try again → sent, never failed', async () => {
    const h = harness({ validUntilSec: START / 1000 + 21, script: ['transport-after-sign'] });
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'tracking', detail: expect.stringContaining('outcome unknown') });
    await expect(h.fill()).resolves.toMatchObject({ state: 'sent' });
  });

  test('TC-SDK-1867-43: TICKET_CLOSED on a repeated submit of the first try → sent, never failed', async () => {
    const h = harness({ script: ['closed-after-sign'] });
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'tracking' });
    await expect(h.fill()).resolves.toMatchObject({ state: 'sent', sentAtMs: START });
  });
});

describe('Canton delivery: before the signature (CAN-1867)', () => {
  test('TC-SDK-1867-44: the backend prepared something else → failed, nothing signed', async () => {
    const h = harness({ script: ['refused-before-sign'] });
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'refused', reason: 'ticket-mismatch' });
    const f = await h.fill();
    expect(f).toMatchObject({ state: 'failed' });
    expect(f?.sentAtMs).toBeUndefined();
  });

  test('TC-SDK-1867-45: TICKET_CLOSED at the first prepare, never signed → failed, not deliverable', async () => {
    const h = harness({ script: ['closed-at-prepare'] });
    await h.seed(h.ticket);
    await expect(h.run()).resolves.toMatchObject({ status: 'refused', reason: 'not-deliverable' });
    await expect(h.fill()).resolves.toMatchObject({ state: 'failed' });
  });
});

describe('Canton delivery: a replica that died mid-delivery (CAN-1867, review F-1)', () => {
  const dead = (leaseUntilMs: number): FillRecord => ({
    orderHash: ORDER_HASH, attempt: 0, chain: 'canton:devnet', txRef: '', amount: encodeCantonAmount('25').toString(), state: 'pending',
    owner: 'replica-dead', leaseUntilMs, sentAtMs: START - 1_000, updatedAtMs: START - 1_000,
  });

  test('TC-SDK-1867-46: its lease still runs → tracked, looked at again when it ends, taken over; the repeat meets TICKET_CLOSED → sent', async () => {
    const h = harness({ script: ['closed-at-prepare'] });
    await h.seed(h.ticket);
    await h.store.withOrder(ORDER_HASH, (tx) => tx.putFill(dead(START + 10_000)));
    await expect(h.run()).resolves.toMatchObject({ status: 'tracking', detail: expect.stringContaining('another replica') });
    expect(h.calls).toHaveLength(0);
    await h.advance(10_001);
    expect(h.calls).toHaveLength(1);
    await expect(h.fill()).resolves.toMatchObject({ state: 'sent', reason: expect.stringContaining('outcome unknown') });
  });

  test('TC-SDK-1867-47: its lease expired and no time is left → sent, not pending forever', async () => {
    const h = harness({ validUntilSec: START / 1000 + 10, script: [] });
    await h.seed(h.ticket);
    await h.store.withOrder(ORDER_HASH, (tx) => tx.putFill(dead(START - 1)));
    await expect(h.run()).resolves.toMatchObject({ status: 'tracking', detail: expect.stringContaining('outcome unknown') });
    await expect(h.fill()).resolves.toMatchObject({ state: 'sent' });
    expect(h.calls).toHaveLength(0);
  });
});
