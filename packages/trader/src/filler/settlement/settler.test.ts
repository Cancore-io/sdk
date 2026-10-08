import { fillerIdHash, repayToFromEvm, type AttestationEvm, type FillProofJson, type Hex, type OrderJson, type TicketJson } from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { FillerChains, hashFillProof, hashOrder, type ChainConfig } from '../chain';
import { Executor } from '../delivery/executor';
import type { StageEvent } from '../events';
import type { Delivery, FillerProtocolClient, FrameHandler } from '../protocol/client';
import type { FillRecord, TicketRecord } from '../store';
import { addressOfPublicKey } from '../signer';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, FakeChain, FakeClock, InMemoryFillerStore } from '../testing';
import { fillProofOf } from './attestations';
import { Settler, SettleError } from './settler';

const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ATTESTOR_KEYS: Hex[] = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
];
const OUTSIDER: Hex = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356';
const SRC_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
const INPUT: Hex = '0x0000000000000000000000000000000000000056';
const FILLER = 'acme-1';
const SRC = 'eip155:56' as const;

const fillSigner = createTestFillSigner(FILL_KEY);
const POLICY: ChainConfig = { router: SRC_ROUTER, openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 0n };

const flush = async () => {
  for (let i = 0; i < 80; i++) await new Promise((resolve) => setImmediate(resolve));
};
const addressOf = (key: Hex): Hex => addressOfPublicKey(secp256k1.getPublicKey(hexToBytes(key.slice(2)), false));
const sign = (key: Hex, digest: Hex): AttestationEvm => {
  const sig = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(key.slice(2)), { lowS: true });
  return { signer: addressOf(key), signature: `0x${bytesToHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}` };
};
const ascending = (entries: AttestationEvm[]) => [...entries].sort((a, b) => (a.signer < b.signer ? -1 : 1));

/** A BSC → Ethereum order this filler delivered (fill confirmed), its escrow open on the fake BSC router, attestor set 1 of 2-of-3. */
async function world(options: { refundAfterS?: number; proofWindowS?: bigint } = {}) {
  const clock = new FakeClock();
  const nowS = BigInt(Math.floor(clock.now() / 1000));
  const src = new FakeChain(56n, 'bsc');
  src.setTimestamp(src.head, nowS);
  src.blockTime = 1n;
  const store = new InMemoryFillerStore(clock);
  const order: OrderJson = {
    user: '0x2222222222222222222222222222222222222222',
    originChainId: '56',
    inputToken: INPUT,
    inputAmount: '105',
    destination: `0x${'00'.repeat(31)}01`,
    outputAsset: `0x${'00'.repeat(12)}${'aa'.repeat(20)}`,
    minReceived: '99',
    recipient: `0x${'00'.repeat(12)}${'0b'.repeat(20)}`,
    createdAt: String(nowS - 600n),
    fillDeadline: String(nowS + 3_600n),
    feeBps: '500',
  };
  const orderHash = hashOrder(order, { chainId: 56n, router: SRC_ROUTER });
  const router = src.router(SRC_ROUTER);
  const refundAfter = nowS + BigInt(options.refundAfterS ?? 2_700);
  router.openIntent(orderHash, { refundAfter, openedAt: nowS - 500n });
  router.attestationSetFor.set(orderHash.toLowerCase(), 1);
  router.attestorSets.set(1, { members: ascending(ATTESTOR_KEYS.map((k) => ({ signer: addressOf(k), signature: '0x' }))).map((a) => a.signer), threshold: 2, activeFrom: 0n, retiredAt: 0n });
  router.proofWindow.set(order.destination.toLowerCase(), options.proofWindowS ?? 2_700n);
  src.token(INPUT).setBalance(SRC_ROUTER, 1_000n);

  const repayTo = repayToFromEvm(fillSigner.address);
  const ticket: TicketJson = { orderHash, fillerId: fillerIdHash(FILLER), deliveryKey: `0x${'dd'.repeat(20)}`, repayTo, attempt: 0, validFrom: String(nowS - 400n), validUntil: String(nowS - 100n) };
  const filledAt = nowS - 200n;
  const fill: FillRecord = {
    orderHash,
    attempt: 0,
    chain: 'eip155:1',
    txRef: `0x${'cc'.repeat(32)}`,
    amount: '100',
    received: '100',
    state: 'confirmed',
    inclusion: { blockNumber: '500', blockHash: `0x${'bb'.repeat(32)}`, header: { timestamp: `0x${filledAt.toString(16)}` }, receipt: {}, seenAtMs: clock.now() },
    updatedAtMs: clock.now(),
  };
  await store.withOrder(orderHash, async (tx) => {
    await tx.putTicket({
      orderHash,
      attempt: 0,
      state: 'filled',
      offer: { type: 'ticket.offer', orderHash, attempt: 0, order, amountOut: '100', validFrom: ticket.validFrom, validUntil: ticket.validUntil } as never,
      issued: { type: 'ticket.issued', form: 'evm', orderHash, attempt: 0, ticket, ticketSig: '0x' } as never,
      updatedAtMs: clock.now(),
    } as TicketRecord);
    await tx.putFill(fill);
  });

  const proof: FillProofJson = {
    kind: 1,
    orderHash,
    destination: order.destination,
    fillRef: fill.txRef as Hex,
    recipient: order.recipient,
    outputAsset: order.outputAsset,
    amountDelivered: '100',
    filledAt: filledAt.toString(),
    fillerId: fillerIdHash(FILLER),
    repayTo,
    attempt: 0,
    setId: 1,
  };
  const digestOf = (p: FillProofJson) => hashFillProof(fillProofOf(p), { chainId: 56n, router: SRC_ROUTER });
  let frameIds = 0;
  /** A `settle.attestations` as filler-gateway would deliver it (its envelope is verified upstream, by the protocol client). */
  const delivery = (overrides: { proof?: FillProofJson; signatures?: AttestationEvm[]; setId?: number } = {}, channel: 'ws' | 'rest' = 'ws'): Delivery => {
    const p = overrides.proof ?? proof;
    const frame = {
      type: 'settle.attestations',
      id: `att-${frameIds++}`,
      fillerId: FILLER,
      sentAt: clock.now(),
      orderHash,
      attempt: 0,
      sourceChainId: SRC,
      proof: { ...p, setId: overrides.setId ?? p.setId },
      signatures: overrides.signatures ?? ascending(ATTESTOR_KEYS.map((k) => sign(k, digestOf(p)))),
      setId: overrides.setId ?? p.setId,
      threshold: 2,
      refundAfter: refundAfter.toString(),
      sig: `0x${'00'.repeat(65)}`,
    };
    const raw = utf8ToBytes(JSON.stringify(frame));
    return { frame: frame as never, raw, id: `0x${bytesToHex(keccak_256(raw))}`, channel, firstSeen: true };
  };

  const events = createRecordingEventSink();
  const logger = createRecordingLogger();
  const chains = new FillerChains({ [SRC]: [src] }, { [SRC]: POLICY }, logger);
  const executor = new Executor({ store, chains, fillSigners: { [SRC]: fillSigner }, fillerId: FILLER, receipted: async () => undefined, instanceId: 'r1', clock, logger, events, delivery: { pollIntervalMs: 1_000 } });
  const handlers = new Map<string, FrameHandler>();
  const ready: { next?: Delivery } = {};
  const pulls: Hex[] = [];
  const protocol = {
    on: (type: string, handler: FrameHandler) => void handlers.set(type, handler),
    onLogin: () => undefined,
    pullAttestations: async (hash: Hex) => {
      pulls.push(hash);
      const next = ready.next;
      if (!next) return false;
      await handlers.get('settle.attestations')!(next);
      return true;
    },
  } as unknown as FillerProtocolClient;
  const settler = new Settler({ store, chains, executor, protocol, fillerId: FILLER, instanceId: 'r1', clock, logger, events, settlement: { pullIntervalMs: 5_000 } });
  settler.register();

  const tick = async (ms: number) => {
    for (let left = ms; left > 0; left -= 1_000) {
      clock.advance(Math.min(1_000, left));
      const target = BigInt(Math.floor(clock.now() / 1000));
      while (src.timestampOf(src.head) < target) src.mine();
      await flush();
    }
  };
  const push = async (d: Delivery) => {
    await handlers.get('settle.attestations')!(d);
    await flush();
  };
  const settles = () => [...src.mempool.values(), ...src.minedTransactions.values()].filter((t) => t.to === SRC_ROUTER);
  const stages = (stage: string) => events.events.filter((e): e is StageEvent => e.type === 'stage' && e.stage === stage);
  const settlement = () => store.withOrder(orderHash, (tx) => tx.getSettlement());
  const attestation = () => store.withOrder(orderHash, (tx) => tx.getAttestations(0));
  return { clock, src, router, store, order, orderHash, proof, digestOf, delivery, events, logger, executor, settler, handlers, ready, pulls, tick, push, settles, stages, settlement, attestation, refundAfter, repayTo };
}

const payee = (w: Awaited<ReturnType<typeof world>>) => w.src.token(INPUT).balances.get(`0x${w.repayTo.slice(26)}`) ?? 0n;

describe('settle from settle.attestations (T-33, T-34)', () => {
  test('pushed set: the lowest k signers, ascending, after eth_call; settle pays repayTo; attested and confirmed', async () => {
    const w = await world();
    await w.push(w.delivery());
    const [tx] = w.settles();
    expect(tx).toBeDefined();
    expect(tx!.from).toBe(fillSigner.address.toLowerCase());
    const sent = w.stages('settle.sent')[0]!;
    const k = ascending(ATTESTOR_KEYS.map((key) => sign(key, w.digestOf(w.proof)))).slice(0, 2);
    expect(sent.detail!.signers).toBe(k.map((x) => x.signer).join(','));
    expect(w.events.events.find((e) => e.type === 'attested')).toMatchObject({ orderHash: w.orderHash, attempt: 0, setId: 1, threshold: 2, signers: k.map((x) => x.signer) });
    expect(await w.attestation()).toMatchObject({ verified: true, channel: 'ws' });
    expect(await w.settlement()).toMatchObject({ state: 'sent', txHash: tx!.hash, chain: SRC });
    expect(w.src.calls.some((c) => c.method === 'eth_call' && String((c.params![0] as { data: string }).data).startsWith(tx!.data.slice(0, 10)))).toBe(true);

    await w.tick(1_000);
    expect(await w.settlement()).toMatchObject({ state: 'confirmed', txHash: tx!.hash });
    expect(w.stages('settle.confirmed')).toHaveLength(1);
    expect(payee(w)).toBe(100n); // 105 × 10⁴ / (10⁴ + 500)
    expect(w.router.intents.get(w.orderHash.toLowerCase())!.status).toBe(2);
  });

  test('the same set on both channels: kept once, one settle', async () => {
    const w = await world();
    await w.push(w.delivery({}, 'ws'));
    await w.push(w.delivery({}, 'rest'));
    expect(w.settles()).toHaveLength(1);
    expect(w.stages('attestations.received')).toHaveLength(1);
  });

  test('pulled: GET /v1/filler/attestations/{orderHash} for a confirmed fill without a settlement, every pullIntervalMs until ready', async () => {
    const w = await world();
    w.settler.start();
    await flush();
    expect(w.pulls).toEqual([w.orderHash]);
    expect(w.settles()).toHaveLength(0);
    w.ready.next = w.delivery({}, 'rest');
    await w.tick(5_000);
    expect(w.settles()).toHaveLength(1);
    expect(await w.attestation()).toMatchObject({ channel: 'rest', verified: true });
    w.settler.stop();
  });

  test('selfSettle sends once and answers the same hash again', async () => {
    const w = await world();
    w.ready.next = w.delivery({}, 'rest');
    const { txHash } = await w.settler.selfSettle(w.orderHash);
    expect(w.settles().map((t) => t.hash)).toEqual([txHash]);
    await expect(w.settler.selfSettle(w.orderHash)).resolves.toEqual({ txHash });
  });

  test('selfSettle with nothing at filler-gateway yet: not-ready, nothing sent', async () => {
    const w = await world();
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toMatchObject({ reason: 'not-ready' });
    expect(w.settles()).toHaveLength(0);
  });

  test('order.settled: the settled event, the settlement closed', async () => {
    const w = await world();
    const frame = { type: 'order.settled', orderHash: w.orderHash, payout: '100', fee: '5', penaltyWithheld: '0', txRef: `0x${'77'.repeat(32)}` };
    await w.handlers.get('order.settled')!({ frame: frame as never, raw: new Uint8Array(), id: '0x01', channel: 'ws', firstSeen: true });
    expect(w.events.events.filter((e) => e.type === 'settled')).toEqual([{ type: 'settled', orderHash: w.orderHash, payout: '100', penaltyWithheld: '0', txRef: frame.txRef }]);
    expect(await w.settlement()).toMatchObject({ state: 'settled' });
  });
});

describe('signatures: only what settle accepts goes out', () => {
  test('an extra invalid signature (outsider), a revoked member and a duplicate are dropped; k valid remain and settle', async () => {
    const w = await world();
    const digest = w.digestOf(w.proof);
    const [a, b, c] = ATTESTOR_KEYS.map((k) => sign(k, digest));
    w.router.revokedAttestors.add(c!.signer);
    await w.push(w.delivery({ signatures: ascending([a!, b!, c!, sign(OUTSIDER, digest)]) }));
    expect(w.stages('settle.sent')[0]!.detail!.signers).toBe(ascending([a!, b!]).map((x) => x.signer).join(','));
    await w.tick(1_000);
    expect(await w.settlement()).toMatchObject({ state: 'confirmed' });
  });

  test('fewer than k valid: nothing sent, alert', async () => {
    const w = await world();
    const digest = w.digestOf(w.proof);
    await w.push(w.delivery({ signatures: ascending([sign(ATTESTOR_KEYS[0]!, digest), sign(OUTSIDER, digest)]) }));
    expect(w.settles()).toHaveLength(0);
    expect(w.stages('settle.alert')[0]!.detail).toMatchObject({ kind: 'insufficient-signatures' });
    expect(await w.attestation()).toMatchObject({ verified: false, reason: expect.stringContaining('insufficient-signatures') });
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toMatchObject({ reason: 'insufficient-signatures' });
  });

  test('a proof that is not this filler\'s own fill (another fillRef, another repayTo): divergent, alert, nothing sent', async () => {
    for (const proof of [{ fillRef: `0x${'ee'.repeat(32)}` as Hex }, { repayTo: repayToFromEvm('0x00000000000000000000000000000000000000ee') }]) {
      const w = await world();
      await w.push(w.delivery({ proof: { ...w.proof, ...proof } }));
      expect(w.settles()).toHaveLength(0);
      expect(w.stages('settle.alert')[0]!.detail).toMatchObject({ kind: 'divergent' });
    }
  });

  test('a later set replaces one that failed verification', async () => {
    const w = await world();
    await w.push(w.delivery({ signatures: [sign(ATTESTOR_KEYS[0]!, w.digestOf(w.proof))] }));
    expect(w.settles()).toHaveLength(0);
    await w.push(w.delivery({}, 'rest'));
    expect(w.settles()).toHaveLength(1);
  });
});

describe('the attestor set of the order (L3)', () => {
  test('setId comes from attestationSetFor(orderHash), not currentSetId: an intent opened before a rotation settles on its old set', async () => {
    const w = await world();
    w.router.currentSetId = 2;
    w.router.attestorSets.set(2, { members: [addressOf(OUTSIDER)], threshold: 1, activeFrom: 0n, retiredAt: 0n });
    await w.push(w.delivery());
    expect(w.settles()).toHaveLength(1);
  });

  test('a set other than attestationSetFor(orderHash): mismatch, nothing sent', async () => {
    const w = await world();
    w.router.attestorSets.set(2, { members: w.router.attestorSets.get(1)!.members, threshold: 2, activeFrom: 0n, retiredAt: 0n });
    const proof = { ...w.proof, setId: 2 };
    await w.push(w.delivery({ proof, setId: 2 }));
    expect(w.settles()).toHaveLength(0);
    expect(w.stages('settle.refused')[0]!.detail).toMatchObject({ reason: 'mismatch' });
  });

  test('the set no longer verifies (the intent outlived GRACE): set-not-active, alert, nothing sent', async () => {
    const w = await world();
    w.router.attestorSets.get(1)!.retiredAt = BigInt(Math.floor(w.clock.now() / 1000)) - 10n;
    await w.push(w.delivery());
    expect(w.settles()).toHaveLength(0);
    expect(w.stages('settle.alert')[0]!.detail).toMatchObject({ kind: 'set-not-active' });
  });
});

describe('eth_call before sending', () => {
  test('a revert is named and nothing is sent', async () => {
    const w = await world();
    // The router's own record says the escrow opened after the delivery: only the router knows it.
    w.router.intents.get(w.orderHash.toLowerCase())!.openedAt = BigInt(Math.floor(w.clock.now() / 1000));
    await w.push(w.delivery());
    expect(w.settles()).toHaveLength(0);
    expect(w.stages('settle.refused')[0]!.detail).toMatchObject({ reason: 'reverted', error: 'FilledBeforeOpen()' });
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toMatchObject({ reason: 'reverted', detail: 'FilledBeforeOpen()' });
  });

  test('settled by someone else first (IntentNotOpen, status Settled): a success, no error, no alert', async () => {
    const w = await world();
    w.router.intents.get(w.orderHash.toLowerCase())!.status = 2;
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toMatchObject({ reason: 'not-ready' });
    await w.push(w.delivery());
    expect(w.settles()).toHaveLength(0);
    expect(await w.settlement()).toMatchObject({ state: 'settled' });
    expect(w.stages('settle.alert')).toHaveLength(0);
  });

  test('refunded first (R-5): refunded, alert, nothing sent', async () => {
    const w = await world();
    w.router.intents.get(w.orderHash.toLowerCase())!.status = 3;
    await w.push(w.delivery());
    expect(w.settles()).toHaveLength(0);
    expect(await w.settlement()).toMatchObject({ state: 'failed', reason: expect.stringContaining('refunded') });
    expect(w.stages('settle.alert')[0]!.detail).toMatchObject({ kind: 'refunded' });
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toBeInstanceOf(SettleError);
  });
});

describe('alerts (R-4)', () => {
  test('unsettled at half the proof window, and alertBeforeRefundMs before refundAfter: one alert each', async () => {
    // filledAt = now − 200 s; a 300 s window is half gone at now − 50 s.
    const w = await world({ proofWindowS: 300n, refundAfterS: 10_000 });
    await w.settler.sweep();
    await w.settler.sweep();
    expect(w.stages('settle.alert').map((s) => s.detail!.kind)).toEqual(['half-window']);
    const v = await world({ proofWindowS: 10_000n, refundAfterS: 1_800 });
    await v.settler.sweep();
    expect(v.stages('settle.alert').map((s) => s.detail!.kind)).toEqual(['refund-near']);
  });

  test('a fill well inside its window raises nothing', async () => {
    const w = await world({ proofWindowS: 10_000n, refundAfterS: 20_000 });
    await w.settler.sweep();
    expect(w.stages('settle.alert')).toHaveLength(0);
  });
});

describe('review sdk#66', () => {
  test('F-2: a settle mined with status 0 while the intent stays Opened — alert, not terminal: selfSettle sends anew, never the reverted hash', async () => {
    const w = await world();
    await w.push(w.delivery());
    const first = w.stages('settle.sent')[0]!;
    const [revokedNow] = String(first.detail!.signers).split(',');
    w.router.revokedAttestors.add(revokedNow!); // revoked after eth_call, before mining: the settle reverts AttestorRevoked
    await w.tick(1_000);
    expect(w.src.minedTransactions.get(String(first.detail!.txHash))).toMatchObject({ status: 0, error: 'AttestorRevoked' });
    expect(await w.settlement()).toMatchObject({ state: 'failed', reason: expect.stringContaining('reverted') });
    expect(w.stages('settle.alert').map((s) => s.detail!.kind)).toEqual(['settle-reverted']);
    expect(w.router.intents.get(w.orderHash.toLowerCase())!.status).toBe(1);

    const again = await w.settler.selfSettle(w.orderHash);
    expect(again.txHash).not.toBe(first.detail!.txHash);
    expect(w.stages('settle.sent')[1]!.detail!.signers).not.toContain(revokedNow);
    await w.tick(1_000);
    expect(await w.settlement()).toMatchObject({ state: 'confirmed', txHash: again.txHash });
  });

  test('F-1: the sweep retries a reverted settle while the intent is open and before refundAfter, and runs the window alerts for it', async () => {
    const w = await world({ proofWindowS: 300n, refundAfterS: 10_000 });
    await w.push(w.delivery());
    w.router.revokedAttestors.add(String(w.stages('settle.sent')[0]!.detail!.signers).split(',')[0]!);
    await w.tick(1_000);
    expect(await w.settlement()).toMatchObject({ state: 'failed' });
    await w.settler.sweep();
    expect(w.stages('settle.sent')).toHaveLength(2);
    expect(w.stages('settle.alert').map((s) => s.detail!.kind)).toContain('half-window');
    await w.tick(1_000);
    expect(await w.settlement()).toMatchObject({ state: 'confirmed' });
  });

  test('F-1: no retry once refundAfter has come', async () => {
    const w = await world();
    await w.push(w.delivery());
    w.router.revokedAttestors.add(String(w.stages('settle.sent')[0]!.detail!.signers).split(',')[0]!);
    await w.tick(1_000);
    w.clock.advance(3_000_000); // past refundAfter; the intent is still open (nobody refunded yet)
    await w.settler.sweep();
    expect(w.stages('settle.sent')).toHaveLength(1);
  });

  test('F-1: a settle whose nonce another transaction spent is not left `sent`: the executor reports it lost and the sweep settles again', async () => {
    const w = await world();
    await w.push(w.delivery());
    const lost = [...w.src.mempool.values()][0]!;
    // Another transaction of the same key takes the nonce (out of band: not recorded by this replica).
    const raw = await fillSigner.signTransaction({ chainId: 56n, nonce: lost.nonce, to: fillSigner.address, data: '0x', value: 0n, gasLimit: 21_000n, maxFeePerGas: lost.maxFeePerGas * 2n, maxPriorityFeePerGas: lost.maxPriorityFeePerGas * 2n });
    await w.src.request({ method: 'eth_sendRawTransaction', params: [raw] });
    await w.tick(5_000);
    expect(await w.settlement()).toMatchObject({ state: 'failed', reason: 'its nonce was spent by another transaction' });
    await w.settler.sweep();
    const [, retry] = w.stages('settle.sent');
    expect(retry!.detail!.txHash).not.toBe(lost.hash);
    await w.tick(1_000);
    expect(await w.settlement()).toMatchObject({ state: 'confirmed', txHash: retry!.detail!.txHash });
  });

  test('load(): a stored frame that does not parse gets a reason, so the next frame replaces it', async () => {
    const w = await world();
    await w.store.withOrder(w.orderHash, (tx) => tx.putAttestations({ orderHash: w.orderHash, attempt: 0, channel: 'ws', raw: new TextEncoder().encode('{not json'), verified: false, receivedAtMs: w.clock.now() }));
    await expect(w.settler.selfSettle(w.orderHash)).rejects.toMatchObject({ reason: 'mismatch' });
    expect(await w.attestation()).toMatchObject({ reason: expect.stringContaining('does not parse') });
    await w.push(w.delivery({}, 'rest'));
    expect(w.settles()).toHaveLength(1);
  });
});
