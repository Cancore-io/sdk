import { buildCantonSourceOrder, fillerIdHash, repayToFromParty, type CantonIntent, type CantonParty, type FillProofJson, type Hex, type OrderJson, type TicketJson } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
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
  const protocol = {
    on: (type: string, handler: FrameHandler) => void handlers.set(type, handler),
    onLogin: () => undefined,
    pullAttestations: async () => false,
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
  return { clock, settler, push, delivery, proof, canton, runs, stages, settlement, orderHash };
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
