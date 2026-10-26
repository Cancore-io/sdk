/**
 * A COMPONENT suite, not the CAN-1867 integration test: the chain is real, the
 * Canton side and filler-gateway are played (see below). The integration test
 * against a Canton participant, filler-gateway and trading belongs on a stand
 * that runs them.
 *
 * EVM → Canton against the real `CancoreRouter` of the stand (CAN-1867): an
 * intent with a Canton destination opened on anvil (Permit2 witness by FRANK,
 * quote by QUOTESIGNER); the Canton-form ticket checked by the SDK — V-E1…V-E4
 * read from the router and the input token with the node's own RPC; the
 * delivery recorded as `delivery.fill` commits it; the `FillProof` of the
 * delivery (`fillRef = keccak256(utf8(updateId))`, Canton `recipient`,
 * `outputAsset`, `amountDelivered` in Numeric 10 × 10¹⁰) attested by
 * ATTESTOR1–3 and settled by `selfSettle` — the payout lands on `repayTo`.
 *
 * This stand has no Canton participant and no filler-gateway: as in
 * `settle.int.test.ts`, the suite plays filler-gateway — it serves the
 * `DeliveryOrder` and holdings reads and the `canton.submitted` answer of
 * `delivery.fill` (the check of the decoded `DeliveryOrder_Fill` before the
 * party key signs is `src/filler/canton/delivery-check.test.ts`). Every chain
 * fact — escrow, proof window, attestor set, settle — is the real router's.
 *
 *   CANCORE_INTENT_JSON=<stand>/intent.json CANCORE_ACTORS_ENV=<stand>/local-actors.env npm run test:int
 *
 * Skipped without the stand; this repository's CI `stand` job runs it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CANCORE_ROUTER_ABI,
  IBURN_MINT_ERC20_ABI,
  QUOTE_TYPES,
  encodeCantonAmount,
  encodeCantonDestination,
  encodeCantonOutputAsset,
  encodeCantonRecipient,
  fillerIdHash,
  hashPermitWitness,
  repayToFromEvm,
  routerDomain,
  type AttestationEvm,
  type CantonDeliveryOrder,
  type CantonHolding,
  type FillProofJson,
  type Hex,
  type OrderJson,
  type TicketIntentMessage,
  type TicketIssuedCanton,
  type TicketOffer,
} from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { FillerChains, hashFillProof, hashOrder, type ChainConfig } from '../src/filler/chain';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { cantonFillRef } from '../src/filler/delivery/canton';
import { Executor } from '../src/filler/delivery/executor';
import type { Delivery, FillerProtocolClient, FrameHandler } from '../src/filler/protocol/client';
import type { EvmRpc } from '../src/filler/rpc';
import type { Clock } from '../src/filler/runtime';
import { fillProofOf } from '../src/filler/settlement/attestations';
import { Settler } from '../src/filler/settlement/settler';
import { addressOfPublicKey } from '../src/filler/signer';
import type { TicketRecord } from '../src/filler/store';
import { TicketVerifier } from '../src/filler/tickets/checks';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, InMemoryFillerStore } from '../src/filler/testing';

const INTENT = process.env.CANCORE_INTENT_JSON;
const ACTORS = process.env.CANCORE_ACTORS_ENV;
const live = INTENT && ACTORS ? describe : describe.skip;

const FILLER = 'stand-filler-1867';
const PERMIT2: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PARTY = `filler-stand::1220${'6c'.repeat(32)}`;
const RECIPIENT = `alice-stand::1220${'cd'.repeat(32)}`;
const ASSET = { admin: `cancore::1220${'4f'.repeat(32)}`, id: 'CNRX' };
const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Hex;

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
const signDigest = (key: Hex, digest: Hex): Hex => {
  const sig = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(key.slice(2)), { lowS: true });
  return `0x${bytesToHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}`;
};
const addressOf = (key: Hex): Hex => addressOfPublicKey(secp256k1.getPublicKey(hexToBytes(key.slice(2)), false));

live('component: EVM → Canton against the stand router, filler-gateway played (CAN-1867)', () => {
  const stand = (INTENT ? JSON.parse(readFileSync(INTENT, 'utf8')) : {}) as { chainId: number; rpcUrlHost: string; contracts: { CancoreRouter: Hex } };
  const evm = (INTENT ? JSON.parse(readFileSync(process.env.CANCORE_EVM_JSON ?? join(dirname(INTENT), 'evm.json'), 'utf8')) : {}) as { tokens: Record<string, { address: Hex }> };
  const actors = ACTORS ? env(ACTORS) : {};
  const key = (name: string) => actors[`${name}_EVM_PRIVATE_KEY`] as Hex;
  const chain = `eip155:${stand.chainId}` as const;
  const router = stand.contracts?.CancoreRouter?.toLowerCase() as Hex;
  const rpc = httpRpc(stand.rpcUrlHost);
  const token = Object.values(evm.tokens ?? {})[0]?.address?.toLowerCase() as Hex;
  const logger = createRecordingLogger();
  const policy: ChainConfig = { router, openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 900, sendGuardSec: 10, minGasWei: 0n, fillConfirmations: 1 };
  const cantonPolicy = { minTicketTtlSec: 60, requiredProofWindowSec: 900, sendGuardSec: 20 };
  // Every executor is stopped after its test, passed or not: no timer outlives the suite.
  const running: Executor[] = [];
  afterEach(() => {
    for (const e of running.splice(0)) e.stop();
  });
  const chains = () => new FillerChains({ [chain]: [rpc] }, { [chain]: policy }, logger);

  const chainTime = async (): Promise<bigint> => BigInt((await rpc.request<{ timestamp: string }>({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
  const send = async (privateKey: Hex, to: Hex, data: Hex): Promise<void> => {
    const signer = createTestFillSigner(privateKey);
    const nonce = BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [signer.address, 'pending'] }));
    const raw = await signer.signTransaction({ chainId: BigInt(stand.chainId), nonce, to, data, value: 0n, gasLimit: 1_000_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const hash = await rpc.request<Hex>({ method: 'eth_sendRawTransaction', params: [raw] });
    const receipt = await waitFor(async () => (await rpc.request<{ status: string } | null>({ method: 'eth_getTransactionReceipt', params: [hash] })) ?? undefined, `receipt of ${hash}`);
    if (receipt.status !== '0x1') throw new Error(`transaction to ${to} reverted`);
  };
  const balanceOf = async (owner: Hex): Promise<bigint> =>
    BigInt(await chains().get(chain)!.client.call(token, encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'balanceOf'), [owner])));

  /** An intent to Canton devnet, opened on the stand router by FRANK; `salt` keeps orders apart. */
  async function openToCanton(salt: number): Promise<{ order: OrderJson; orderHash: Hex; now: bigint }> {
    const user = createTestFillSigner(key('FRANK'));
    await send(key('FRANK'), token, `0xa0712d68${(10n ** 21n).toString(16).padStart(64, '0')}` as Hex);
    await send(key('FRANK'), token, encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'approve'), [PERMIT2, 2n ** 255n]));
    const now = await chainTime();
    const order: OrderJson = {
      user: user.address.toLowerCase() as Hex,
      originChainId: String(stand.chainId),
      inputToken: token,
      inputAmount: String(1_003_000_000_000_000_000n + BigInt(salt)),
      destination: encodeCantonDestination('devnet'),
      outputAsset: encodeCantonOutputAsset(ASSET),
      minReceived: encodeCantonAmount('25').toString(),
      recipient: encodeCantonRecipient(RECIPIENT),
      createdAt: String(now - 5n),
      fillDeadline: String(now + 1_800n),
      feeBps: '30',
      fillerId: fillerIdHash(FILLER),
    };
    const orderHash = hashOrder(order, { chainId: stand.chainId, router });
    const quoteDeadline = now + 300n;
    const quoteSig = await createTestTypedDataSigner(key('QUOTESIGNER')).signTypedData({ domain: routerDomain(stand.chainId, router), types: QUOTE_TYPES, primaryType: 'Quote', message: { orderHash, quoteDeadline } });
    const permit = { permitted: { token, amount: order.inputAmount }, nonce: BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(orderHash)))}`) >> 8n, deadline: order.fillDeadline };
    const permitSig = signDigest(key('FRANK'), hashPermitWitness({ ...permit, spender: router, witness: order }, stand.chainId, PERMIT2));
    await send(key('FRANK'), router, encodeFunctionCall(entryOf(abi(CANCORE_ROUTER_ABI), 'function', 'openFor'), [order, permit, permitSig, quoteDeadline, quoteSig]));
    return { order, orderHash, now };
  }

  /** The offer, the filler's consent, the Canton-form ticket and its DeliveryOrder, as filler-gateway would send and serve them. */
  function ticketOf(order: OrderJson, orderHash: Hex, now: bigint, clock: Clock) {
    const repayTo = repayToFromEvm(createTestFillSigner(key('FILLER1')).address);
    const validFrom = String(now - 5n);
    const validUntil = String(now + 600n);
    const offer = { type: 'ticket.offer', orderHash, attempt: 0, order, amountOut: order.minReceived, validFrom, validUntil, acceptBy: clock.now() + 5_000 } as unknown as TicketOffer;
    const intent = { type: 'ticket.intent', orderHash, attempt: 0, validFrom, validUntil, deliveryKey: ZERO_ADDRESS, repayTo } as unknown as TicketIntentMessage;
    const deliveryOrderCid = `00${bytesToHex(keccak_256(utf8ToBytes(orderHash)))}`;
    const issued = { type: 'ticket.issued', form: 'canton', orderHash, attempt: 0, deliveryOrderCid, validUntil, repayTo } as unknown as TicketIssuedCanton;
    const deliveryOrder: CantonDeliveryOrder = { deliveryOrderCid, orderHash, attempt: 0, asset: ASSET, amount: '25.0000000000', recipient: RECIPIENT, repayTo, validUntil };
    return { offer, intent, issued, deliveryOrder, repayTo };
  }

  const standClock = (now: bigint): Clock => {
    const offset = Number(now) * 1000 - Date.now();
    return { now: () => Date.now() + offset, schedule: (ms, cb) => { const h = setTimeout(cb, ms); return () => clearTimeout(h); } };
  };

  const verifierFor = (clock: Clock, orders: CantonDeliveryOrder[], holdings: CantonHolding[]) =>
    new TicketVerifier({
      chains: chains(),
      fillSigners: { [chain]: createTestFillSigner(key('FILLER1')) },
      fillerId: FILLER,
      cantonParty: PARTY,
      ticketSigners: [addressOf(key('TICKETSIGNER'))],
      deltaIssueMs: 3_000,
      clock,
      events: createRecordingEventSink(),
      logger,
      canton: { party: PARTY, policy: cantonPolicy, deliveryOrders: async () => orders, holdings: async () => holdings },
    });

  test('TC-SDK-1867-COMP-01: a Canton-form ticket on a real escrow passes every check, from the router and the input token', async () => {
    const { order, orderHash, now } = await openToCanton(1);
    const clock = standClock(now);
    const t = ticketOf(order, orderHash, now, clock);
    const verdict = await verifierFor(clock, [t.deliveryOrder], [{ contractId: 'h1', asset: ASSET, amount: '30.0', locked: false }]).verify({ offer: t.offer, issued: t.issued, issuedAtMs: clock.now(), intent: t.intent });
    expect(verdict).toMatchObject({ ok: true });
    expect(verdict.checks.map((c) => [c.check, c.status])).toEqual(['form', 'V-T4', 'V-T2', 'V-T3', 'V-E1', 'V-E2', 'V-E3', 'V-E4', 'V-E5'].map((c) => [c, 'passed']));
  }, 60_000);

  test('TC-SDK-1867-COMP-02: refused on the real escrow — another order, an operator repayTo (T-48), no inventory', async () => {
    const { order, orderHash, now } = await openToCanton(2);
    const clock = standClock(now);
    const t = ticketOf(order, orderHash, now, clock);
    const holdings: CantonHolding[] = [{ contractId: 'h1', asset: ASSET, amount: '30', locked: false }];
    const verify = (orders: CantonDeliveryOrder[], held: CantonHolding[], offer = t.offer) => verifierFor(clock, orders, held).verify({ offer, issued: t.issued, issuedAtMs: clock.now(), intent: t.intent });

    // One order field changed: the ticket's hash is no longer this order's digest in the router domain.
    expect(await verify([t.deliveryOrder], holdings, { ...t.offer, order: { ...order, feeBps: '31' } })).toMatchObject({ ok: false, reason: 'ESCROW_MISMATCH' });
    const evilRepayTo = repayToFromEvm(addressOf(key('BOB')));
    expect(await verify([{ ...t.deliveryOrder, repayTo: evilRepayTo }], holdings)).toMatchObject({ ok: false, reason: 'TICKET_MISMATCH', detail: expect.stringContaining('repayTo') });
    // CAN-3026: the floor the issued ticket names is the offered one.
    const laterFloor = { ...t.issued, validFrom: String(BigInt(t.offer.validFrom) + 1n) } as TicketIssuedCanton;
    expect(await verifierFor(clock, [t.deliveryOrder], holdings).verify({ offer: t.offer, issued: laterFloor, issuedAtMs: clock.now(), intent: t.intent })).toMatchObject({ ok: false, reason: 'TICKET_MISMATCH', detail: expect.stringContaining('validFrom') });
    expect(await verify([t.deliveryOrder], [{ ...holdings[0]!, amount: '10' }, { contractId: 'h2', asset: ASSET, amount: '100', locked: true }])).toMatchObject({ ok: false, reason: 'NO_INVENTORY' });
  }, 60_000);

  /** The executor delivering through `delivery.fill`, filler-gateway answering `canton.submitted` with `updateId`. */
  async function deliver(order: OrderJson, orderHash: Hex, now: bigint, updateId: string | undefined, store: InMemoryFillerStore, clock: Clock) {
    const t = ticketOf(order, orderHash, now, clock);
    await store.withOrder(orderHash, (tx) =>
      tx.putTicket({ orderHash, attempt: 0, state: 'receipted', sentAtMs: clock.now(), updatedAtMs: clock.now(), offer: t.offer, intent: t.intent, issued: t.issued, receipt: { type: 'ticket.receipt', form: 'canton' } as never } as TicketRecord),
    );
    const asked: unknown[] = [];
    const operations = {
      fill: async (expect: unknown) => {
        asked.push(expect);
        return { type: 'canton.submitted', op: 'delivery.fill', operationId: 'op-1', ...(updateId ? { updateId } : {}), result: { receiptCid: `00${'cc'.repeat(33)}` }, delivered: order.minReceived } as never;
      },
    };
    const events = createRecordingEventSink();
    const executor = new Executor({
      store, chains: chains(), fillSigners: { [chain]: createTestFillSigner(key('FILLER1')) }, fillerId: FILLER, cantonParty: PARTY,
      receipted: async (h, a) => store.withOrder(h, (tx) => tx.getTicket(a)), instanceId: 'int-1867', clock, logger, events, delivery: { pollIntervalMs: 200 },
      canton: { operations, sendGuardSec: cantonPolicy.sendGuardSec },
    });
    running.push(executor);
    await executor.start();
    const result = await executor.deliver(orderHash, 0);
    return { executor, events, result, asked, t };
  }

  /** Attestors sign the proof of the Canton delivery; filler-gateway serves it to the settlement. */
  async function attestAndSettle(order: OrderJson, orderHash: Hex, fillRef: Hex, repayTo: Hex, filledAt: bigint, executor: Executor, store: InMemoryFillerStore, clock: Clock) {
    const reader = chains().get(chain)!.router;
    const setId = await reader.attestationSetFor(orderHash);
    const proof: FillProofJson = {
      kind: 1, orderHash, destination: order.destination, fillRef, recipient: order.recipient, outputAsset: order.outputAsset,
      amountDelivered: order.minReceived, filledAt: filledAt.toString(), fillerId: fillerIdHash(FILLER), repayTo, attempt: 0, setId,
    };
    const digest = hashFillProof(fillProofOf(proof), { chainId: stand.chainId, router });
    const signatures: AttestationEvm[] = ['ATTESTOR1', 'ATTESTOR2', 'ATTESTOR3']
      .map((name) => ({ signer: addressOf(key(name)), signature: signDigest(key(name), digest) }))
      .sort((a, b) => (a.signer < b.signer ? -1 : 1));
    const set = await reader.getAttestorSet(setId);
    const frame = { type: 'settle.attestations', id: `stand-${orderHash.slice(2, 10)}`, fillerId: FILLER, sentAt: clock.now(), orderHash, attempt: 0, sourceChainId: chain, proof, signatures, setId, threshold: set.threshold, refundAfter: String((await reader.intents(orderHash)).refundAfter), sig: `0x${'00'.repeat(65)}` };
    const raw = utf8ToBytes(JSON.stringify(frame));
    const handlers = new Map<string, FrameHandler>();
    const protocol = {
      on: (type: string, handler: FrameHandler) => void handlers.set(type, handler),
      onLogin: () => undefined,
      pullAttestations: async () => {
        await handlers.get('settle.attestations')!({ frame: frame as never, raw, id: `0x${bytesToHex(keccak_256(raw))}`, channel: 'rest', firstSeen: true } as Delivery);
        return true;
      },
    } as unknown as FillerProtocolClient;
    const events = createRecordingEventSink();
    const settler = new Settler({ store, chains: chains(), executor, protocol, fillerId: FILLER, instanceId: 'int-1867', clock, logger, events });
    settler.register();
    const { txHash } = await settler.selfSettle(orderHash);
    await waitFor(async () => ((await store.withOrder(orderHash, (tx) => tx.getSettlement()))?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
    return { txHash, reader };
  }

  test('TC-SDK-1867-COMP-03: delivered on Canton, attested with fillRef = keccak256(utf8(updateId)), settled on the source: repayTo is paid', async () => {
    const { order, orderHash, now } = await openToCanton(3);
    const clock = standClock(now);
    const store = new InMemoryFillerStore(clock);
    const updateId = `1220${bytesToHex(keccak_256(utf8ToBytes(`update-${orderHash}`)))}`;
    const { executor, events, result, asked, t } = await deliver(order, orderHash, now, updateId, store, clock);

    // The delivery asked exactly for the node's own ticket, held to the order and its own payee.
    expect(asked).toEqual([expect.objectContaining({ fillerId: FILLER, orderHash, attempt: 0, deliveryOrderCid: t.issued.deliveryOrderCid, validUntil: t.issued.validUntil, repayTo: t.repayTo, amountOut: order.minReceived })]);
    expect(result).toMatchObject({ status: 'sent', txHash: cantonFillRef(updateId) });
    expect(await store.withOrder(orderHash, (tx) => tx.getFill(0))).toMatchObject({ state: 'confirmed', txRef: updateId, chain: 'canton:devnet', received: order.minReceived });
    expect((await store.withOrder(orderHash, (tx) => tx.getTicket(0)))?.state).toBe('filled');
    expect(events.events).toContainEqual({ type: 'filled', orderHash, attempt: 0, txHash: cantonFillRef(updateId), amount: order.minReceived });
    // A recorded fill is never delivered again.
    expect(await executor.deliver(orderHash, 0)).toMatchObject({ status: 'tracking' });
    expect(asked).toHaveLength(1);

    const payeeBefore = await balanceOf(createTestFillSigner(key('FILLER1')).address.toLowerCase() as Hex);
    const { reader } = await attestAndSettle(order, orderHash, cantonFillRef(updateId), t.repayTo, await chainTime(), executor, store, clock);
    expect((await reader.intents(orderHash)).status).toBe(2);
    const payout = (BigInt(order.inputAmount) * 10_000n) / (10_000n + BigInt(order.feeBps));
    expect((await balanceOf(createTestFillSigner(key('FILLER1')).address.toLowerCase() as Hex)) - payeeBefore).toBe(payout);
    executor.stop();
  }, 60_000);

  test('TC-SDK-1867-COMP-04: a delivery whose update id was lost settles from the attested proof that is otherwise its own', async () => {
    const { order, orderHash, now } = await openToCanton(4);
    const clock = standClock(now);
    const store = new InMemoryFillerStore(clock);
    const { executor, result, t } = await deliver(order, orderHash, now, undefined, store, clock);
    expect(result).toMatchObject({ status: 'sent', detail: expect.stringContaining('no update id') });
    expect(await store.withOrder(orderHash, (tx) => tx.getFill(0))).toMatchObject({ state: 'sent', txRef: '' });

    const attestedRef = cantonFillRef(`1220${'ab'.repeat(32)}`);
    const { reader } = await attestAndSettle(order, orderHash, attestedRef, t.repayTo, await chainTime(), executor, store, clock);
    expect((await reader.intents(orderHash)).status).toBe(2);
    executor.stop();
  }, 60_000);
});
