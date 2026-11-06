/**
 * Self-settle against the real `CancoreRouter` of the local stand (meta
 * `make evm-genesis && make intent-genesis`, a router built from CAN-2140 on):
 * an intent opened on anvil (Permit2 witness by FRANK, quote by QUOTESIGNER),
 * delivered by the executor from FILLER1, attested by ATTESTOR1–3, settled by
 * `selfSettle` — the payout lands on the ticket's `repayTo` (CAN-1856).
 *
 * The attestor signatures reach the SDK only through filler-gateway
 * (`settle.attestations`, `GET /v1/filler/attestations/{orderHash}`). This
 * suite plays filler-gateway: the stand's attestor keys sign the `FillProof`
 * and the frame is served to the settlement as the REST pull would (its
 * envelope check is the protocol client's, covered by its own tests). The
 * chain is never played: what was or was not sent is read from anvil — the
 * delivery key's nonce, the router's intent status, the payee's balance.
 *
 * The router's owner (DEPLOYER) revokes an attestor and rotates the attestor
 * set, and anvil's clock is moved forward; each of those tests runs between
 * `evm_snapshot` and `evm_revert`, so the suites after it see the stand as
 * `up.mjs` left it.
 *
 *   CANCORE_INTENT_JSON=<meta>/docker/modules/genesis/out/intent.json \
 *   CANCORE_ACTORS_ENV=<meta>/docker/modules/genesis/out/local-actors.env \
 *   npm run test:int
 *
 * Skipped without the stand. In this repository's CI the `stand` job brings it
 * up on anvil (test/stand/up.mjs) and runs it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CANCORE_ROUTER_ABI,
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  IBURN_MINT_ERC20_ABI,
  QUOTE_TYPES,
  fillerIdHash,
  hashPermitWitness,
  repayToFromEvm,
  routerDomain,
  type AttestationEvm,
  type FillProofJson,
  type Hex,
  type OrderJson,
  type TicketJson,
} from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { FillerChains, hashFillProof, hashOrder, INTENT_STATUS, type ChainConfig } from '../src/filler/chain';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { Executor } from '../src/filler/delivery/executor';
import { TransactionDriver } from '../src/filler/delivery/transactions';
import type { StageEvent } from '../src/filler/events';
import type { Delivery, FillerProtocolClient, FrameHandler } from '../src/filler/protocol/client';
import type { EvmRpc } from '../src/filler/rpc';
import type { Clock } from '../src/filler/runtime';
import { fillProofOf } from '../src/filler/settlement/attestations';
import { SettleError, Settler, type SettlementOptions } from '../src/filler/settlement/settler';
import { addressOfPublicKey } from '../src/filler/signer';
import type { TicketRecord } from '../src/filler/store';
import { orderOf } from '../src/filler/tickets/terms';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, decodeSignedTransaction, InMemoryFillerStore } from '../src/filler/testing';

const INTENT = process.env.CANCORE_INTENT_JSON;
const ACTORS = process.env.CANCORE_ACTORS_ENV;
const live = INTENT && ACTORS ? describe : describe.skip;

const FILLER = 'stand-filler-1';
const PERMIT2: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** secp256k1 group order: `s` above half of it is the high-s twin of a signature `ECDSA.recover` refuses. */
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** AttestorSet.SET_DELAY of the stand router (evm-contracts `contracts/lib/AttestorSet.sol`): a proposed set activates this long after. */
const SET_DELAY_S = 72 * 3600;

const httpRpc = (url: string): EvmRpc => {
  let id = 0;
  return {
    label: 'anvil',
    async request<T>({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<T> {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw body.error;
      return body.result as T;
    },
  };
};

const env = (path: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

async function waitFor<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const abi = (entries: unknown) => entries as unknown as readonly AbiEntry[];
const ROUTER = abi(CANCORE_ROUTER_ABI);
const signDigest = (key: Hex, digest: Hex): Hex => {
  const sig = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(key.slice(2)), { lowS: true });
  return `0x${bytesToHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}`;
};
/** The same signature with `s` mirrored to `n − s` and `v` flipped: it recovers to the same signer, and the router refuses it. */
const highS = (signature: Hex): Hex => {
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = parseInt(signature.slice(130, 132), 16);
  return `${signature.slice(0, 66)}${(CURVE_N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
};
const addressOf = (key: Hex): Hex => addressOfPublicKey(secp256k1.getPublicKey(hexToBytes(key.slice(2)), false));
const keyOf = (label: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(label)))}`;
const ascending = (a: AttestationEvm, b: AttestationEvm) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1);

live('selfSettle against the stand router (make intent-genesis)', () => {
  const stand = (INTENT ? JSON.parse(readFileSync(INTENT, 'utf8')) : {}) as { chainId: number; rpcUrlHost: string; contracts: { CancoreRouter: Hex }; destinations: Record<string, { destination: Hex; isEvm: boolean }> };
  const evm = (INTENT ? JSON.parse(readFileSync(process.env.CANCORE_EVM_JSON ?? join(dirname(INTENT), 'evm.json'), 'utf8')) : {}) as { tokens: Record<string, { address: Hex }> };
  const actors = ACTORS ? env(ACTORS) : {};
  const key = (name: string) => actors[`${name}_EVM_PRIVATE_KEY`] as Hex;
  const chain = `eip155:${stand.chainId}` as const;
  const router = stand.contracts?.CancoreRouter?.toLowerCase() as Hex;
  const rpc = httpRpc(stand.rpcUrlHost);
  const token = Object.values(evm.tokens ?? {})[0]?.address?.toLowerCase() as Hex;
  const destination = Object.values(stand.destinations ?? {}).find((d) => d.isEvm)?.destination as Hex;
  const logger = createRecordingLogger();
  const policy: ChainConfig = { router, openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 900, sendGuardSec: 10, minGasWei: 0n, fillConfirmations: 1 };
  const createReaders = () => new FillerChains({ [chain]: [rpc] }, { [chain]: policy }, logger).get(chain)!;
  const attestorKeys = () => ['ATTESTOR1', 'ATTESTOR2', 'ATTESTOR3'].map(key);

  const chainTime = async (): Promise<bigint> => BigInt((await rpc.request<{ timestamp: string }>({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
  const mine = (blocks = 1) => rpc.request({ method: 'anvil_mine', params: [`0x${blocks.toString(16)}`] });
  const pendingNonce = async (address: Hex) => BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [address, 'pending'] }));
  const send = async (privateKey: Hex, to: Hex, data: Hex): Promise<void> => {
    const signer = createTestFillSigner(privateKey);
    const nonce = await pendingNonce(signer.address);
    const raw = await signer.signTransaction({ chainId: BigInt(stand.chainId), nonce, to, data, value: 0n, gasLimit: 1_000_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const hash = await rpc.request<Hex>({ method: 'eth_sendRawTransaction', params: [raw] });
    const receipt = await waitFor(async () => (await rpc.request<{ status: string } | null>({ method: 'eth_getTransactionReceipt', params: [hash] })) ?? undefined, `receipt of ${hash}`);
    if (receipt.status !== '0x1') throw new Error(`transaction to ${to} reverted`);
  };
  const balanceOf = async (owner: Hex): Promise<bigint> => createReaders().client.call(token, encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'balanceOf'), [owner])).then(BigInt);
  /** Runs `body` on a copy of the chain: the router owner's changes and the moved clock are dropped afterwards. */
  const onSnapshot = async (body: () => Promise<void>) => {
    const id = await rpc.request<string>({ method: 'evm_snapshot', params: [] });
    try {
      await body();
    } finally {
      await rpc.request({ method: 'evm_setAutomine', params: [true] });
      await rpc.request({ method: 'evm_revert', params: [id] });
    }
  };

  beforeAll(async () => {
    const mint = `0xa0712d68${(10n ** 24n).toString(16).padStart(64, '0')}` as Hex;
    const approve = (spender: Hex) => encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'approve'), [spender, 2n ** 255n]);
    await send(key('FRANK'), token, mint);
    await send(key('FRANK'), token, approve(PERMIT2));
    await send(key('FILLER1'), token, mint);
    await send(key('FILLER1'), token, approve(router));
  });

  // Every executor is stopped after its test, passed or not: no timer outlives the suite.
  const built: Executor[] = [];
  afterEach(async () => {
    for (const e of built.splice(0)) e.stop();
    await rpc.request({ method: 'evm_setAutomine', params: [true] });
  });

  let opened = 0;

  /** Opens an EVM → EVM order on the stand's one network, delivers it from FILLER1 and waits for the fill confirmed. */
  async function delivered(settlementOptions: SettlementOptions = {}) {
    const user = createTestFillSigner(key('FRANK'));
    const delivery = createTestFillSigner(key('FILLER1'));
    const now = await chainTime();
    opened += 1;
    const order: OrderJson = {
      user: user.address.toLowerCase() as Hex,
      originChainId: String(stand.chainId),
      inputToken: token,
      inputAmount: '1003000000000000000',
      destination,
      outputAsset: `0x${'00'.repeat(12)}${token.slice(2)}`,
      minReceived: '990000000000000000',
      recipient: `0x${'00'.repeat(12)}${'0c'.repeat(18)}${opened.toString(16).padStart(4, '0')}`,
      createdAt: String(now - 5n),
      fillDeadline: String(now + 1_800n),
      feeBps: '30',
      fillerId: fillerIdHash(FILLER),
    };
    const orderHash = hashOrder(order, { chainId: stand.chainId, router });
    const quoteDeadline = now + 300n;
    const quoteSig = await createTestTypedDataSigner(key('QUOTESIGNER')).signTypedData({ domain: routerDomain(stand.chainId, router), types: QUOTE_TYPES, primaryType: 'Quote', message: { orderHash, quoteDeadline } });
    const permit = { permitted: { token, amount: order.inputAmount }, nonce: BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(orderHash)))}`) >> 8n, deadline: order.fillDeadline };
    // The witness is a nested struct, which hashTypedData does not encode: the package's own Permit2 digest.
    const permitSig = signDigest(key('FRANK'), hashPermitWitness({ ...permit, spender: router, witness: order }, stand.chainId, PERMIT2));
    await send(key('FRANK'), router, encodeFunctionCall(entryOf(ROUTER, 'function', 'openFor'), [order, permit, permitSig, quoteDeadline, quoteSig]));

    let clockOffset = Number(now) * 1000 - Date.now();
    const clock: Clock = { now: () => Date.now() + clockOffset, schedule: (ms, cb) => { const h = setTimeout(cb, ms); return () => clearTimeout(h); } };
    /** The process clock follows anvil's: after the chain's time is moved, so is the filler's. */
    const syncClock = async () => {
      clockOffset = Number(await chainTime()) * 1000 - Date.now();
    };
    const store = new InMemoryFillerStore(clock);
    const repayTo = repayToFromEvm(delivery.address);
    const ticket: TicketJson = { orderHash, fillerId: fillerIdHash(FILLER), deliveryKey: delivery.address.toLowerCase() as Hex, repayTo, attempt: 0, validFrom: String(now - 5n), validUntil: String(now + 600n) };
    const ticketSig = await createTestTypedDataSigner(key('TICKETSIGNER')).signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: { ...ticket } });
    await store.withOrder(orderHash, (tx) =>
      tx.putTicket({
        orderHash, attempt: 0, state: 'receipted', sentAtMs: clock.now(), updatedAtMs: clock.now(),
        offer: { type: 'ticket.offer', orderHash, attempt: 0, order, amountOut: order.minReceived, validFrom: ticket.validFrom, validUntil: ticket.validUntil } as never,
        issued: { type: 'ticket.issued', form: 'evm', orderHash, attempt: 0, ticket, ticketSig } as never,
        receipt: { type: 'ticket.receipt' } as never,
      } as TicketRecord),
    );
    const events = createRecordingEventSink();
    const chains = new FillerChains({ [chain]: [rpc] }, { [chain]: policy }, logger);
    const executorFor = (instanceId: string) => {
      const e = new Executor({ store, chains, fillSigners: { [chain]: delivery }, fillerId: FILLER, receipted: async (h, a) => store.withOrder(h, (tx) => tx.getTicket(a)), instanceId, clock, logger, events, delivery: { pollIntervalMs: 200, nonceLeaseTtlMs: 1_000 } });
      built.push(e);
      return e;
    };
    const executor = executorFor('int-settle');
    await executor.start();
    expect(await executor.deliver(orderHash, 0)).toMatchObject({ status: 'sent' });
    const fill = await waitFor(async () => {
      const f = await store.withOrder(orderHash, (tx) => tx.getFill(0));
      return f?.state === 'confirmed' ? f : undefined;
    }, 'the fill confirmed');

    const reader = chains.get(chain)!.router;
    const setId = await reader.attestationSetFor(orderHash);
    const proof: FillProofJson = {
      kind: 1, orderHash, destination, fillRef: fill.txRef as Hex, recipient: order.recipient, outputAsset: order.outputAsset,
      amountDelivered: fill.received ?? fill.amount, filledAt: BigInt(String(fill.inclusion!.header.timestamp)).toString(),
      fillerId: fillerIdHash(FILLER), repayTo, attempt: 0, setId,
    };
    const digestOf = (p: FillProofJson) => hashFillProof(fillProofOf(p), { chainId: stand.chainId, router });
    const signed = (keys: readonly Hex[], p: FillProofJson = proof): AttestationEvm[] => keys.map((k) => ({ signer: addressOf(k), signature: signDigest(k, digestOf(p)) }));
    /** The `settle.attestations` filler-gateway would serve for this fill. */
    const frameOf = async (signatures: readonly AttestationEvm[], p: FillProofJson = proof) => {
      const set = await reader.getAttestorSet(p.setId);
      return { type: 'settle.attestations', id: `stand-${opened}`, fillerId: FILLER, sentAt: clock.now(), orderHash, attempt: 0, sourceChainId: chain, proof: p, signatures: [...signatures].sort(ascending), setId: p.setId, threshold: set.threshold, refundAfter: String((await reader.intents(orderHash)).refundAfter), sig: `0x${'00'.repeat(65)}` };
    };

    /**
     * A settlement over the shared store, as replica `instanceId`: the REST pull answers with what `serve` holds
     * (nothing until it is set), exactly as filler-gateway's 404 ATTESTATIONS_NOT_READY and its payload would.
     */
    const settlerFor = (instanceId = 'int-settle', exec: Executor = executor) => {
      const handlers = new Map<string, FrameHandler>();
      let serve: object | undefined;
      const protocol = {
        on: (type: string, handler: FrameHandler) => void handlers.set(type, handler),
        onLogin: () => undefined,
        pullAttestations: async () => {
          if (!serve) return false;
          const raw = utf8ToBytes(JSON.stringify(serve));
          await handlers.get('settle.attestations')!({ frame: serve as never, raw, id: `0x${bytesToHex(keccak_256(raw))}`, channel: 'rest', firstSeen: true } as Delivery);
          return true;
        },
      } as unknown as FillerProtocolClient;
      const settler = new Settler({ store, chains, executor: exec, protocol, fillerId: FILLER, instanceId, clock, logger, events, settlement: settlementOptions });
      settler.register();
      return { settler, serve: (frame: object | undefined) => void (serve = frame) };
    };
    const settlement = () => store.withOrder(orderHash, (tx) => tx.getSettlement());
    const stages = (name: string) => events.events.filter((e): e is StageEvent => e.type === 'stage' && e.stage === name && e.orderHash === orderHash);
    const alerts = () => stages('settle.alert').map((e) => (e.detail as { kind: string }).kind);
    const status = async () => (await reader.intents(orderHash)).status;
    return { order, orderHash, store, chains, clock, syncClock, events, executor, executorFor, fill, proof, repayTo, delivery, reader, digestOf, signed, frameOf, settlerFor, settlement, stages, alerts, status };
  }
  type Delivered = Awaited<ReturnType<typeof delivered>>;
  const payoutOf = (order: OrderJson) => (BigInt(order.inputAmount) * 10_000n) / (10_000n + BigInt(order.feeBps));

  /** selfSettle refuses with `reason`; the delivery key sent nothing and the intent is still open on the router. */
  const expectNothingSent = async (d: Delivered, settle: () => Promise<unknown>, reason: string) => {
    const before = await pendingNonce(d.delivery.address);
    await expect(settle()).rejects.toMatchObject({ name: 'SettleError', reason });
    expect(await pendingNonce(d.delivery.address)).toBe(before);
    expect(await d.status()).toBe(INTENT_STATUS.Opened);
  };

  test('TC-SDK-1856-INT-01: open → fill → attested by 2 of 3 plus an outsider → selfSettle: the outsider is dropped, repayTo is paid', async () => {
    const d = await delivered();
    const outsider = keyOf('stand-outsider');
    const { settler, serve } = d.settlerFor();
    serve(await d.frameOf(d.signed([...attestorKeys(), outsider])));
    const payeeBefore = await balanceOf(d.delivery.address.toLowerCase() as Hex);
    const { txHash } = await settler.selfSettle(d.orderHash);
    const set = await d.reader.getAttestorSet(d.proof.setId);
    expect(d.events.events.find((e) => e.type === 'attested')).toMatchObject({ setId: d.proof.setId, threshold: set.threshold, signers: expect.not.arrayContaining([addressOf(outsider)]) });
    await waitFor(async () => ((await d.settlement())?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
    expect((await d.settlement())!.txHash).toBe(txHash);
    expect(await d.status()).toBe(INTENT_STATUS.Settled);
    // FILLER1 is both the delivery key and the payee: it spent the fill, it got the payout.
    expect((await balanceOf(d.delivery.address.toLowerCase() as Hex)) - payeeBefore).toBe(payoutOf(d.order));
    d.executor.stop();
  }, 60_000);

  test.each([
    ['only 1 of 3 signatures is valid — one attestor, an outsider, an attestor over another digest', 'insufficient-signatures'],
    ['the attested proof is of another fill — refused before eth_call', 'divergent'],
    ['the attestors signed different FillProof digests — no threshold on one digest', 'insufficient-signatures'],
    ['eth_call of settle reverts IntentNotOpen — another transaction settled it first', 'already-settled'],
  ] as const)('TC-SDK-1856-INT-02: no settle is sent when %s (%s)', async (situation, reason) => {
    const d = await delivered();
    const [a1, a2, a3] = attestorKeys() as [Hex, Hex, Hex];
    const other: FillProofJson = { ...d.proof, amountDelivered: (BigInt(d.proof.amountDelivered) + 1n).toString() };
    const foreign: FillProofJson = { ...d.proof, fillRef: keyOf(`foreign-fill-${d.orderHash}`) };
    const { settler, serve } = d.settlerFor();
    if (situation.startsWith('only 1')) {
      // a2's signature is listed under its own address but signs another digest: it recovers to someone else.
      serve(await d.frameOf([...d.signed([a1, keyOf('stand-outsider')]), { signer: addressOf(a2), signature: d.signed([a2], other)[0]!.signature }]));
    } else if (situation.startsWith('the attested proof')) {
      serve(await d.frameOf(d.signed([a1, a2, a3], foreign), foreign));
    } else if (situation.startsWith('the attestors signed')) {
      serve(await d.frameOf([...d.signed([a1]), ...d.signed([a2, a3], other)]));
    } else {
      // Anyone may call settle (fillers.md T-33): RELAYER submits the same attested proof first.
      const sigs = d.signed([a1, a2, a3]).sort(ascending).slice(0, 2).map((x) => x.signature);
      await send(key('RELAYER'), router, encodeFunctionCall(entryOf(ROUTER, 'function', 'settle'), [orderOf(d.order), fillProofOf(d.proof), sigs]));
      serve(await d.frameOf(d.signed([a1, a2, a3])));
      const before = await pendingNonce(d.delivery.address);
      await expect(settler.selfSettle(d.orderHash)).rejects.toMatchObject({ name: 'SettleError', reason });
      expect(await pendingNonce(d.delivery.address)).toBe(before);
      expect(await d.status()).toBe(INTENT_STATUS.Settled);
      d.executor.stop();
      return;
    }
    await expectNothingSent(d, () => settler.selfSettle(d.orderHash), reason);
    expect(d.stages('settle.refused').map((e) => (e.detail as { reason: string }).reason)).toContain(reason);
    d.executor.stop();
  }, 60_000);

  test('TC-SDK-1856-INT-03: a duplicate signer refuses the frame whole; a revoked attestor and a high-s twin are dropped before sending — nothing goes below k, the settle goes once k are valid', async () => {
    await onSnapshot(async () => {
      const d = await delivered();
      const [a1, a2, a3] = attestorKeys() as [Hex, Hex, Hex];
      await send(key('DEPLOYER'), router, encodeFunctionCall(entryOf(ROUTER, 'function', 'revokeAttestor'), [addressOf(a3)]));
      expect(await d.reader.revokedAttestors(addressOf(a3))).toBe(true);
      const [one, two, three] = d.signed([a1, a2, a3]) as [AttestationEvm, AttestationEvm, AttestationEvm];
      const { settler, serve } = d.settlerFor();

      // A duplicate signer breaks the strictly ascending order of the set: that frame is refused whole (an order of its own).
      const inOrder = (sigs: AttestationEvm[]) => [...sigs].sort(ascending);
      const dup = await delivered();
      const dupSettle = dup.settlerFor('int-settle-dup');
      const [first] = inOrder(dup.signed([a1, a2]));
      dupSettle.serve(await dup.frameOf([first!, ...inOrder(dup.signed([a1, a2]))]));
      await expectNothingSent(dup, () => dupSettle.settler.selfSettle(dup.orderHash), 'mismatch');
      expect(dup.stages('settle.refused').map((e) => String((e.detail as { detail: string }).detail)).join(' ')).toContain('ascending');

      // a3 revoked, a2 only as its high-s twin, ascending: one valid signature, below k = 2.
      serve(await d.frameOf(inOrder([one, { signer: two.signer, signature: highS(two.signature) }, three])));
      await expectNothingSent(d, () => settler.selfSettle(d.orderHash), 'insufficient-signatures');
      const refused = d.stages('settle.refused').map((e) => String((e.detail as { detail: string }).detail)).join(' ');
      for (const reason of ['revoked', 'high-s']) expect(refused).toContain(reason);

      // A frame that failed verification is replaced by the next one: a2's low-s signature makes k.
      serve(await d.frameOf(inOrder([one, two, three])));
      const payeeBefore = await balanceOf(d.delivery.address.toLowerCase() as Hex);
      await settler.selfSettle(d.orderHash);
      await waitFor(async () => ((await d.settlement())?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
      expect(d.events.events.filter((e) => e.type === 'attested').at(-1)).toMatchObject({ signers: [one.signer, two.signer].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1)) });
      expect((await balanceOf(d.delivery.address.toLowerCase() as Hex)) - payeeBefore).toBe(payoutOf(d.order));
      d.executor.stop();
    });
  }, 90_000);

  test('TC-SDK-1856-INT-04: an intent opened before an attestor set rotation settles with attestationSetFor(orderHash), not currentSetId; repayTo is paid', async () => {
    await onSnapshot(async () => {
      const d = await delivered();
      const before = await d.reader.currentSetId();
      expect(d.proof.setId).toBe(before);
      const successors = ['rotated-1', 'rotated-2', 'rotated-3'].map((l) => addressOf(keyOf(l))).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      await send(key('DEPLOYER'), router, encodeFunctionCall(entryOf(ROUTER, 'function', 'proposeAttestorSet'), [successors, 2n]));
      await rpc.request({ method: 'evm_increaseTime', params: [SET_DELAY_S + 60] });
      await mine();
      await d.syncClock();
      const rotated = await d.reader.currentSetId();
      expect(rotated).toBeGreaterThan(before);
      expect((await d.reader.getAttestorSet(rotated)).activeFrom).toBeLessThanOrEqual(await chainTime());
      expect(await d.reader.attestationSetFor(d.orderHash)).toBe(before);

      const { settler, serve } = d.settlerFor();
      serve(await d.frameOf(d.signed(attestorKeys())));
      const payeeBefore = await balanceOf(d.delivery.address.toLowerCase() as Hex);
      await settler.selfSettle(d.orderHash);
      await waitFor(async () => ((await d.settlement())?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
      expect(d.events.events.find((e) => e.type === 'attested')).toMatchObject({ setId: before });
      expect(await d.status()).toBe(INTENT_STATUS.Settled);
      expect((await balanceOf(d.delivery.address.toLowerCase() as Hex)) - payeeBefore).toBe(payoutOf(d.order));
      d.executor.stop();
    });
  }, 90_000);

  test('TC-SDK-1856-INT-05: the sweep alerts at half the proof window and settleMargin before refundAfter, and settles as soon as the attestations arrive (fillers.md R-4, T-34)', async () => {
    const alertBeforeRefundMs = 600_000;
    await onSnapshot(async () => {
      const d = await delivered({ alertBeforeRefundMs });
      const { settler, serve } = d.settlerFor();
      const filledAt = BigInt(d.proof.filledAt);
      const window = await d.reader.proofWindow(destination);
      const { refundAfter } = await d.reader.intents(d.orderHash);
      const at = async (t: bigint) => {
        await rpc.request({ method: 'evm_setNextBlockTimestamp', params: [Number(t)] });
        await mine();
        await d.syncClock();
        await settler.sweep();
      };

      // No attestations yet: nothing is sent, and no alert before half the window.
      await at(filledAt + window / 2n - 2n);
      expect(d.alerts()).toEqual([]);
      expect(d.stages('settle.sent')).toEqual([]);
      await at(filledAt + window / 2n);
      expect(d.alerts()).toEqual(['half-window']);
      await at(refundAfter - BigInt(alertBeforeRefundMs / 1000) - 2n);
      expect(d.alerts()).toEqual(['half-window']);
      await at(refundAfter - BigInt(alertBeforeRefundMs / 1000));
      expect(d.alerts()).toEqual(['half-window', 'refund-near']);
      expect(await d.status()).toBe(INTENT_STATUS.Opened);

      // filler-gateway now holds the set: the next sweep settles at once.
      serve(await d.frameOf(d.signed(attestorKeys())));
      await settler.sweep();
      await waitFor(async () => ((await d.settlement())?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
      expect(await d.status()).toBe(INTENT_STATUS.Settled);
      d.executor.stop();
    });
  }, 90_000);

  /** The `settle` call the settlement builds for `d`: k = 2 of the stand's attestors, strictly ascending. */
  const settleCall = (d: Delivered) => {
    const sigs = d.signed(attestorKeys()).sort(ascending).slice(0, 2).map((x) => x.signature);
    return { to: router, data: encodeFunctionCall(entryOf(ROUTER, 'function', 'settle'), [orderOf(d.order), fillProofOf(d.proof), sigs]), value: 0n };
  };

  /** A replica that recorded a signed settle on its nonce (write-ahead) and died before broadcasting it. */
  const recordedByDeadReplica = async (d: Delivered, owner: string, leaseTtlMs: number) => {
    const dead = new TransactionDriver({ chain, client: d.chains.get(chain)!.client, signer: d.delivery, store: d.store, owner, leaseTtlMs, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20 }, logger });
    const lease = await dead.acquire();
    const call = { ...settleCall(d), gasLimit: 400_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const raw = await d.delivery.signTransaction({ chainId: BigInt(stand.chainId), nonce: lease.nonce, ...call });
    const { hash } = decodeSignedTransaction(raw);
    expect(await d.store.nonces.recordTransaction(lease, { hash, raw, kind: 'settle', orderHash: d.orderHash, attempt: 0, ...call, sentAtMs: d.clock.now() })).toBe(true);
    return { hash, nonce: lease.nonce };
  };

  test('TC-SDK-1856-INT-07: a settle recorded on its nonce and never broadcast by a replica that died is sent by the next one on that nonce — one settle on chain', async () => {
    const d = await delivered();
    d.executor.stop();
    const nonceBefore = await pendingNonce(d.delivery.address);
    const { hash, nonce } = await recordedByDeadReplica(d, 'int-dead', 1_000);
    expect(nonce).toBe(nonceBefore);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // Held in the mempool until the settlement has adopted it: mined at once, eth_call would read it settled already.
    await rpc.request({ method: 'evm_setAutomine', params: [false] });
    const restarted = d.executorFor('int-restarted');
    await restarted.start();
    const { settler, serve } = d.settlerFor('int-restarted', restarted);
    serve(await d.frameOf(d.signed(attestorKeys())));
    expect(await settler.selfSettle(d.orderHash)).toEqual({ txHash: hash });
    await rpc.request({ method: 'evm_setAutomine', params: [true] });
    await mine(2);
    await waitFor(async () => ((await d.settlement())?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
    expect(await d.status()).toBe(INTENT_STATUS.Settled);
    // One transaction on one nonce: the recorded bytes, nothing signed twice.
    expect(await pendingNonce(d.delivery.address)).toBe(nonceBefore + 1n);
    expect((await rpc.request<{ nonce: string } | null>({ method: 'eth_getTransactionByHash', params: [hash] }))?.nonce).toBe(`0x${nonce.toString(16)}`);
    restarted.stop();
  }, 60_000);

  test('TC-SDK-1856-INT-08: while another replica holds the lease on a recorded settle, this one sends nothing and does not take that hash for its own', async () => {
    const d = await delivered();
    d.executor.stop();
    const nonceBefore = await pendingNonce(d.delivery.address);
    const { hash } = await recordedByDeadReplica(d, 'int-replica-a', 600_000);

    const replicaB = d.executorFor('int-replica-b');
    await replicaB.start();
    const { settler, serve } = d.settlerFor('int-replica-b', replicaB);
    serve(await d.frameOf(d.signed(attestorKeys())));
    await expect(settler.selfSettle(d.orderHash)).rejects.toMatchObject({ name: 'SettleError', reason: 'unavailable' });
    expect(await pendingNonce(d.delivery.address)).toBe(nonceBefore);
    expect(await rpc.request<unknown>({ method: 'eth_getTransactionByHash', params: [hash] })).toBeNull();
    const settlement = await d.settlement();
    expect(settlement?.txHash).toBeUndefined();
    expect(settlement?.state).not.toBe('sent');
    expect((await d.store.nonces.listOpen(chain, d.delivery.address.toLowerCase() as Hex)).find((r) => r.transactions.some((t) => t.hash === hash))?.owner).toBe('int-replica-a');
    replicaB.stop();
  }, 60_000);

  test('TC-SDK-1856-INT-09: the nonce journal fails before the write-ahead record — no false sent, and the retry sends one settle on the same nonce', async () => {
    const d = await delivered();
    const { settler, serve } = d.settlerFor();
    serve(await d.frameOf(d.signed(attestorKeys())));
    const nonceBefore = await pendingNonce(d.delivery.address);
    const record = d.store.nonces.recordTransaction.bind(d.store.nonces);
    // Down until lifted: the settle the arriving frame starts and the selfSettle below both meet it.
    let journalDown = true;
    d.store.nonces.recordTransaction = async (...args) => {
      if (journalDown) throw new Error('journal unavailable (injected)');
      return record(...args);
    };
    await expect(settler.selfSettle(d.orderHash)).rejects.toBeInstanceOf(SettleError);
    const failed = await d.settlement();
    expect(failed?.txHash).toBeUndefined();
    expect(failed?.state).not.toBe('sent');
    expect(await pendingNonce(d.delivery.address)).toBe(nonceBefore);

    journalDown = false;
    const { txHash } = await settler.selfSettle(d.orderHash);
    await waitFor(async () => ((await d.settlement())?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
    expect(await d.status()).toBe(INTENT_STATUS.Settled);
    expect(await pendingNonce(d.delivery.address)).toBe(nonceBefore + 1n);
    expect((await rpc.request<{ nonce: string } | null>({ method: 'eth_getTransactionByHash', params: [txHash] }))?.nonce).toBe(`0x${nonceBefore.toString(16)}`);
    d.executor.stop();
  }, 60_000);

  test('TC-SDK-1856-INT-10: a stored settle.attestations without a proof does not break loading; the next frame replaces it and settles on anvil', async () => {
    const d = await delivered();
    const broken = { ...(await d.frameOf(d.signed(attestorKeys()))), proof: undefined };
    await d.store.withOrder(d.orderHash, (tx) => tx.putAttestations({ orderHash: d.orderHash, attempt: 0, channel: 'rest', raw: utf8ToBytes(JSON.stringify(broken)), verified: false, receivedAtMs: d.clock.now() }));

    const { settler, serve } = d.settlerFor();
    await expect(settler.selfSettle(d.orderHash)).rejects.toMatchObject({ name: 'SettleError', reason: 'mismatch' });
    expect((await d.store.withOrder(d.orderHash, (tx) => tx.getAttestations(0)))?.reason).toMatch(/does not parse/);

    serve(await d.frameOf(d.signed(attestorKeys())));
    await settler.sweep();
    await waitFor(async () => ((await d.settlement())?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
    expect(await d.status()).toBe(INTENT_STATUS.Settled);
    d.executor.stop();
  }, 60_000);
});

