import { buildCantonSourceOrder, fillerIdHash, repayToFromParty, type CantonIntent, type CantonParty, type FillProofJson, type Hex, type OrderJson, type TicketJson } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { FillerChains } from '../chain';
import { CANTON_TRANSFER_FACTORIES } from '../canton/factories';
import { NODE_KEY, party } from '../canton/fixtures';
import { CantonRefusal } from '../canton/legs';
import type { CantonOperations } from '../canton/operations';
import { Executor } from '../delivery/executor';
import type { StageEvent } from '../events';
import type { Delivery, FillerProtocolClient, FrameHandler } from '../protocol/client';
import type { FillRecord, TicketRecord } from '../store';
import { createRecordingEventSink, createRecordingLogger, FakeClock, InMemoryFillerStore } from '../testing';
import { Settler, SettleError } from './settler';

const FILLER = 'cancore-dev-1';
const ME = party();
const OPERATOR = 'cancore-intent-operator::1220ee';
const OWNER = 'alice::1220ff';
const flush = async () => {
  for (let i = 0; i < 80; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A Canton → Sepolia order this filler delivered (fill confirmed on the EVM destination), not settled yet. */
async function world(options: { canton?: boolean; refundAfterS?: number } = {}) {
  const clock = new FakeClock();
  const nowS = Math.floor(clock.now() / 1000);
  const store = new InMemoryFillerStore(clock);
  const built = buildCantonSourceOrder({
    ownerPartyId: OWNER, requestId: 'req-1', instrumentAdmin: 'cancore::1220aa', instrumentId: 'CNRX', amount: '100', destinationChainId: '11155111',
    wantToken: `0x${'11'.repeat(20)}`, wantDecimals: 0, minReceived: '99', recipient: `0x${'22'.repeat(20)}`, createdAt: nowS - 600, fillDeadline: nowS + 600,
    feeRate: '0.003', cantonOriginId: '9223372036854775811', fillerId: FILLER,
  });
  const order = built.order as unknown as OrderJson;
  const orderHash = built.orderHash.toLowerCase() as Hex;
  const refundAfter = String(nowS + (options.refundAfterS ?? 4_200));
  const intent: CantonIntent = {
    intentCid: '00si', templateId: `${'cd'.repeat(32)}:Intent.SwapIntent:SwapIntent`, orderHash, owner: OWNER, operator: OPERATOR, filler: ME, fillerId: FILLER, requestId: 'req-1',
    asset: { admin: 'cancore::1220aa', id: 'CNRX' }, amount: '100.0000000000', destination: { chainId: '11155111', token: `0x${'11'.repeat(20)}`, recipient: `0x${'22'.repeat(20)}` },
    minReceived: { units: '99', decimals: 0 }, feeRate: '0.0030000000', fillDeadline: String(nowS + 600), refundAfter, orderCreatedAt: String(nowS - 600), allocationCid: '00al', allocation: null,
  };
  const repayTo = repayToFromParty(ME);
  const ticket: TicketJson = { orderHash, fillerId: fillerIdHash(FILLER), deliveryKey: `0x${'dd'.repeat(20)}`, repayTo, attempt: 0, validFrom: String(nowS - 400), validUntil: String(nowS - 100) };
  const filledAt = nowS - 200;
  const fill: FillRecord = {
    orderHash, attempt: 0, chain: 'eip155:11155111', txRef: `0x${'cc'.repeat(32)}`, amount: '100', received: '100', state: 'confirmed',
    inclusion: { blockNumber: '500', blockHash: `0x${'bb'.repeat(32)}`, header: { timestamp: `0x${filledAt.toString(16)}` }, receipt: {}, seenAtMs: clock.now() },
    updatedAtMs: clock.now(),
  };
  await store.withOrder(orderHash, async (tx) => {
    await tx.putTicket({
      orderHash, attempt: 0, state: 'filled',
      offer: { type: 'ticket.offer', orderHash, attempt: 0, order, amountOut: '100', validFrom: ticket.validFrom, validUntil: ticket.validUntil } as never,
      issued: { type: 'ticket.issued', form: 'evm', orderHash, attempt: 0, ticket, ticketSig: '0x' } as never,
      updatedAtMs: clock.now(),
    } as TicketRecord);
    await tx.putFill(fill);
  });
  const proof: FillProofJson = {
    kind: 1, orderHash, destination: order.destination, fillRef: fill.txRef as Hex, recipient: order.recipient, outputAsset: order.outputAsset, amountDelivered: '100',
    filledAt: String(filledAt), fillerId: fillerIdHash(FILLER), repayTo, attempt: 0, setId: 1,
  };
  const delivery = (p: FillProofJson = proof): Delivery => {
    const frame = {
      type: 'settle.attestations', id: 'att-1', fillerId: FILLER, sentAt: clock.now(), orderHash, attempt: 0, sourceChainId: 'canton:devnet', proof: p,
      signatures: [
        { signer: `0x${'01'.repeat(20)}`, pubKey: `0x${'30'.repeat(88)}`, signature: `0x${'30'.repeat(70)}` },
        { signer: `0x${'02'.repeat(20)}`, pubKey: `0x${'30'.repeat(88)}`, signature: `0x${'30'.repeat(70)}` },
      ],
      setId: p.setId, threshold: 2, refundAfter, sig: `0x${'00'.repeat(65)}`,
    };
    const raw = utf8ToBytes(JSON.stringify(frame));
    return { frame: frame as never, raw, id: `0x${bytesToHex(keccak_256(raw))}`, channel: 'ws', firstSeen: true };
  };

  const registered: CantonParty = { party: ME, publicKey: null, registry: { state: 'ACTIVE', proposalCid: null, entryCid: '00en' } };
  const runs: Array<{ op: string; params: unknown; check: (prepared: never, txs: never[]) => unknown }> = [];
  const canton = {
    publicKey: `0x${NODE_KEY}` as Hex,
    registries: CANTON_TRANSFER_FACTORIES,
    intent: jest.fn(async () => structuredClone(intent)),
    party: jest.fn(async () => registered),
    run: jest.fn(async (op: string, params: unknown, check: (prepared: never, txs: never[]) => unknown) => {
      runs.push({ op, params, check });
      return { type: 'canton.submitted', op, operationId: 'op-1', updateId: '1220abcd', result: {} };
    }),
  };
  const events = createRecordingEventSink();
  const logger = createRecordingLogger();
  const chains = new FillerChains({}, {}, logger);
  const executor = new Executor({ store, chains, fillSigners: {}, fillerId: FILLER, receipted: async () => undefined, instanceId: 'r1', clock, logger, events });
  const handlers = new Map<string, FrameHandler>();
  const pulls: Hex[] = [];
  const protocol = {
    on: (type: string, handler: FrameHandler) => void handlers.set(type, handler),
    onLogin: () => undefined,
    pullAttestations: async (hash: Hex) => (pulls.push(hash), false),
  } as unknown as FillerProtocolClient;
  const settler = new Settler({
    store, chains, executor, protocol, fillerId: FILLER, instanceId: 'r1', clock, logger, events,
    ...(options.canton === false ? {} : { canton: canton as unknown as Pick<CantonOperations, 'run' | 'intent' | 'party' | 'publicKey' | 'registries'>, cantonParty: ME }),
  });
  settler.register();
  const push = async (d: Delivery) => {
    await handlers.get('settle.attestations')!(d);
    await flush();
  };
  const stages = (stage: string) => events.events.filter((e): e is StageEvent => e.type === 'stage' && e.stage === stage);
  const settlement = () => store.withOrder(orderHash, (tx) => tx.getSettlement());
  const alertKinds = () => stages('settle.alert').map((e) => e.detail?.kind);
  /** Moves the clock to `s` seconds from the start of the world. */
  const at = (s: number) => clock.advance((nowS + s) * 1000 - clock.now());
  return { clock, settler, push, delivery, proof, canton, runs, stages, settlement, orderHash, handlers, pulls, alertKinds, at, registered, refundAfter, store, logger };
}

describe('Settler on a Canton source: SwapIntent_SettleWithProof by the party (CAN-2321)', () => {
  test('the attestations of its own fill: intent.settle is prepared, checked, signed; the settlement is confirmed with the update id', async () => {
    const w = await world();
    await w.push(w.delivery());
    expect(w.runs).toHaveLength(1);
    expect(w.runs[0]).toMatchObject({ op: 'intent.settle', params: { orderHash: w.orderHash } });
    // The check is a real one: an empty prepared transaction is refused, never signed.
    expect(() => w.runs[0]!.check({ summary: {} } as never, [])).toThrow(CantonRefusal);
    expect(w.canton.intent).toHaveBeenCalledWith(w.orderHash);
    await expect(w.settlement()).resolves.toMatchObject({ state: 'confirmed', chain: 'canton:devnet', updateId: '1220abcd' });
    expect(w.stages('settle.confirmed')).toHaveLength(1);
  });

  test('TC-ATT-2146-04 (CAN-2146): order.settled overtakes the answer of the submit — the settlement is settled and keeps the update id of its SwapIntent_SettleWithProof', async () => {
    const w = await world();
    const settled = { type: 'order.settled', orderHash: w.orderHash, payout: '99', fee: '1', penaltyWithheld: '0', txRef: '1220abcd' };
    w.canton.run.mockImplementationOnce(async (op: string, params: unknown, check: (prepared: never, txs: never[]) => unknown) => {
      w.runs.push({ op, params, check });
      await w.handlers.get('order.settled')!({ frame: settled as never, raw: new Uint8Array(), id: '0x02', channel: 'ws', firstSeen: true });
      return { type: 'canton.submitted', op, operationId: 'op-1', updateId: '1220abcd', result: {} };
    });
    await w.push(w.delivery());
    await expect(w.settlement()).resolves.toMatchObject({ state: 'settled', chain: 'canton:devnet', updateId: '1220abcd', orderSettled: settled });
    expect(w.stages('settle.confirmed').map((e) => e.detail?.updateId)).toEqual(['1220abcd']);
  });

  test('a proof of another fill is divergent: nothing is prepared, an alert', async () => {
    const w = await world();
    await w.push(w.delivery({ ...w.proof, fillRef: `0x${'c1'.repeat(32)}` }));
    expect(w.runs).toHaveLength(0);
    expect(w.stages('settle.alert').map((e) => e.detail?.kind)).toContain('divergent');
  });

  test('from refundAfter on nothing is submitted (T-37)', async () => {
    const w = await world({ refundAfterS: 0 });
    await w.push(w.delivery());
    expect(w.runs).toHaveLength(0);
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toMatchObject({ reason: 'deadline-passed' });
  });

  test('a prepared transaction the check refuses: the claim is released, the refusal named', async () => {
    const w = await world();
    w.canton.run.mockRejectedValueOnce(new CantonRefusal('-', 'intent.settle: the party is credited 0, not 99.7008973081'));
    await w.push(w.delivery());
    await expect(w.settlement()).resolves.toMatchObject({ state: 'pending', leaseUntilMs: 0 });
    expect(w.stages('settle.refused').map((e) => e.detail?.reason)).toContain('mismatch');
  });

  test('an intent that no longer hashes to the order delivered for is refused before any prepare', async () => {
    const w = await world();
    w.canton.intent.mockResolvedValueOnce({ ...(await w.canton.intent()), amount: '100.5' });
    await w.push(w.delivery());
    expect(w.runs).toHaveLength(0);
  });

  test('a node without a Canton party cannot settle a Canton source', async () => {
    const w = await world({ canton: false });
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toBeInstanceOf(SettleError);
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toMatchObject({ reason: 'canton-source' });
  });
});

describe('Settler on a Canton source: the settle window, as on an EVM source (BUG-1614, S-07)', () => {
  // refundAfter = +4200 s, fillDeadline = +600 s: proof window 3600 s; filled at -200 s, so half the window at +1600 s.
  test('no set held: refund-near alertBeforeRefundMs before refundAfter, half-window at half of refundAfter − fillDeadline after the fill', async () => {
    const w = await world();
    await w.settler.sweep();
    expect(w.alertKinds()).toEqual([]);
    w.at(600);
    await w.settler.sweep();
    expect(w.stages('settle.alert').map((e) => e.detail)).toEqual([{ kind: 'refund-near', refundAfter: w.refundAfter }]);
    w.at(1_599);
    await w.settler.sweep();
    expect(w.alertKinds()).toEqual(['refund-near']);
    w.at(1_600);
    await w.settler.sweep();
    expect(w.stages('settle.alert').map((e) => e.detail).at(-1)).toMatchObject({ kind: 'half-window', proofWindow: '3600' });
    expect(w.pulls).toHaveLength(4);
  });

  test('no set held: the pulls stop at refundAfter, when SwapIntent_SettleWithProof refuses (now < refundAfter); the intent is read once', async () => {
    const w = await world();
    await w.settler.sweep();
    w.at(4_199);
    await w.settler.sweep();
    expect(w.pulls).toHaveLength(2);
    w.at(4_200);
    await w.settler.sweep();
    w.at(4_200 + 7 * 24 * 3_600);
    await w.settler.sweep();
    expect(w.pulls).toHaveLength(2);
    expect(w.canton.intent).toHaveBeenCalledTimes(1);
  });

  test('a held set that keeps failing to settle (the registry entry is not ACTIVE): refund-near from its own refundAfter, even with the intent unreadable', async () => {
    const w = await world();
    w.registered.registry = { state: 'PENDING', proposalCid: '00pr', entryCid: null } as never;
    await w.push(w.delivery());
    expect(w.runs).toHaveLength(0);
    w.canton.intent.mockRejectedValue(new Error('filler-gateway unreachable'));
    w.at(600);
    await w.settler.sweep();
    expect(w.alertKinds()).toEqual(['refund-near']);
    expect(w.pulls).toHaveLength(0);
  });

  test('an intent that cannot be read: the pulls go on with refundAfter unknown and no alert, a warning per failed read; the next sweep reads it again', async () => {
    const w = await world();
    const read = w.canton.intent.getMockImplementation()!;
    w.canton.intent.mockRejectedValue(new Error('filler-gateway unreachable'));
    w.at(600);
    await w.settler.sweep();
    await w.settler.sweep();
    expect(w.pulls).toHaveLength(2);
    expect(w.alertKinds()).toEqual([]);
    expect(w.logger.entries.filter((e) => e.level === 'warn').map((e) => e.fields?.error)).toEqual(['filler-gateway unreachable', 'filler-gateway unreachable']);
    w.canton.intent.mockImplementation(read);
    await w.settler.sweep();
    expect(w.pulls).toHaveLength(3);
    expect(w.alertKinds()).toEqual(['refund-near']);
  });

  test('a node without Canton operations: refundAfter unknown, the pulls go on as before, no sweep error', async () => {
    const w = await world({ canton: false });
    w.at(4_200);
    await w.settler.sweep();
    expect(w.pulls).toHaveLength(1);
    expect(w.logger.entries.filter((e) => e.level === 'warn')).toEqual([]);
  });

  test('the refundAfter read is dropped once the settlement is confirmed, or the order leaves the open orders', async () => {
    const cached = (w: { settler: unknown }) => [...(w.settler as { refundAfters: Map<Hex, bigint> }).refundAfters.keys()];
    const confirmed = await world();
    await confirmed.settler.sweep();
    expect(cached(confirmed)).toEqual([confirmed.orderHash]);
    await confirmed.push(confirmed.delivery());
    await expect(confirmed.settlement()).resolves.toMatchObject({ state: 'confirmed' });
    expect(cached(confirmed)).toEqual([]);

    const settled = await world();
    await settled.settler.sweep();
    const frame = { type: 'order.settled', orderHash: settled.orderHash, payout: '99', fee: '1', penaltyWithheld: '0', txRef: '1220abcd' };
    await settled.handlers.get('order.settled')!({ frame: frame as never, raw: new Uint8Array(), id: '0x02', channel: 'ws', firstSeen: true });
    await settled.settler.sweep();
    expect(cached(settled)).toEqual([]);
  });

  test('no half-window alert without a fill time, or without a proof window (refundAfter at fillDeadline)', async () => {
    const untimed = await world();
    const { inclusion: _inclusion, ...fill } = (await untimed.store.withOrder(untimed.orderHash, (tx) => tx.getFill(0)))!;
    await untimed.store.withOrder(untimed.orderHash, (tx) => tx.putFill(fill));
    const windowless = await world({ refundAfterS: 600 });
    for (const w of [untimed, windowless]) {
      w.at(599);
      await w.settler.sweep();
      expect(w.alertKinds()).not.toContain('half-window');
    }
  });

  test('an order with neither an EVM nor a Canton source (origin 0) is not swept: no intent read, no pull', async () => {
    const w = await world();
    const ticket = (await w.store.withOrder(w.orderHash, (tx) => tx.getTicket(0)))!;
    await w.store.withOrder(w.orderHash, (tx) => tx.putTicket({ ...ticket, offer: { ...ticket.offer!, order: { ...ticket.offer!.order, originChainId: '0' } } }));
    await w.settler.sweep();
    expect(w.pulls).toHaveLength(0);
    expect(w.canton.intent).not.toHaveBeenCalled();
  });
});
