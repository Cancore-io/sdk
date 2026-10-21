/**
 * V-E2 against reorgs of the open, on the real `CancoreRouter` of the stand
 * (CAN-2808, part of the O-1 reorg review CAN-2807): an open reorged out
 * before and after it was `openConfirmations` deep, the read pinned to one
 * block hash, and `safe` / `finalized` as anvil serves them. anvil plays the
 * chain: `evm_snapshot` / `evm_revert` drop the block with the open, and
 * `anvil_mine` builds the new chain past the old height.
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
  type Hex,
  type OrderJson,
  type TicketIssuedEvm,
  type TicketOffer,
} from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { FillerChains, hashOrder, INTENT_STATUS, RouterEventWatcher, type ChainConfig, type OpenDepth, type RouterEventUpdate } from '../src/filler/chain';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { toQuantity } from '../src/filler/chain/client';
import type { EvmRpc, EvmRpcRequest } from '../src/filler/rpc';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, FakeClock } from '../src/filler/testing';
import { TicketVerifier, type EscrowVerification } from '../src/filler/tickets/checks';

const INTENT = process.env.CANCORE_INTENT_JSON;
const ACTORS = process.env.CANCORE_ACTORS_ENV;
const live = INTENT && ACTORS ? describe : describe.skip;

const FILLER = 'stand-filler-2808';
const PERMIT2: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** anvil's `--slots-in-an-epoch` default: it serves `safe` at head − 32 and `finalized` at head − 64 (foundry v1.8.3 `convert_block_number`). */
const ANVIL_SLOTS_IN_AN_EPOCH = 32;

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

const recordingRpc = (inner: EvmRpc): EvmRpc & { calls: EvmRpcRequest[] } => {
  const calls: EvmRpcRequest[] = [];
  return {
    label: inner.label,
    calls,
    request<T>(request: EvmRpcRequest): Promise<T> {
      calls.push(request);
      return inner.request<T>(request);
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

interface OpenedIntent {
  order: OrderJson;
  orderHash: Hex;
  /** The block the open was mined in, and its hash then. */
  block: bigint;
  blockHash: Hex;
  /** Chain time at the open, ms: the verifier's clock. */
  nowMs: number;
}

live('CAN-2808: V-E2 against reorgs of the open on the stand router', () => {
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
  const policy = (openConfirmations: OpenDepth): ChainConfig => ({ router, openConfirmations, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 60, sendGuardSec: 30, minGasWei: 0n });
  const readers = (openConfirmations: OpenDepth, endpoint: EvmRpc = rpc) => new FillerChains({ [chain]: [endpoint] }, { [chain]: policy(openConfirmations) }, logger).get(chain)!;
  const intentsCall = (orderHash: Hex) => encodeFunctionCall(entryOf(abi(CANCORE_ROUTER_ABI), 'function', 'intents'), [orderHash]);

  const block = (at: bigint | 'latest' | 'safe' | 'finalized') =>
    rpc.request<{ number: string; hash: Hex; timestamp: string }>({ method: 'eth_getBlockByNumber', params: [typeof at === 'bigint' ? toQuantity(at) : at, false] });
  const head = async () => BigInt((await block('latest')).number);
  const mine = (blocks: number) => rpc.request({ method: 'anvil_mine', params: [toQuantity(BigInt(blocks))] });
  const snapshot = () => rpc.request<string>({ method: 'evm_snapshot', params: [] });
  const revert = async (id: string) => expect(await rpc.request<boolean>({ method: 'evm_revert', params: [id] })).toBe(true);

  const send = async (privateKey: Hex, to: Hex, data: Hex): Promise<{ blockNumber: bigint; blockHash: Hex }> => {
    const signer = createTestFillSigner(privateKey);
    const nonce = BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [signer.address, 'pending'] }));
    const raw = await signer.signTransaction({ chainId: BigInt(stand.chainId), nonce, to, data, value: 0n, gasLimit: 1_000_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const hash = await rpc.request<Hex>({ method: 'eth_sendRawTransaction', params: [raw] });
    const receipt = await waitFor(async () => (await rpc.request<{ status: string; blockNumber: string; blockHash: Hex } | null>({ method: 'eth_getTransactionReceipt', params: [hash] })) ?? undefined, `receipt of ${hash}`);
    if (receipt.status !== '0x1') throw new Error(`transaction to ${to} reverted`);
    return { blockNumber: BigInt(receipt.blockNumber), blockHash: receipt.blockHash.toLowerCase() as Hex };
  };

  let opened = 0;
  /** An EVM → EVM order on the stand's one network, opened by FRANK with a Permit2 witness and a QUOTESIGNER quote. */
  async function openIntent(): Promise<OpenedIntent> {
    const user = createTestFillSigner(key('FRANK'));
    const now = BigInt((await block('latest')).timestamp);
    opened += 1;
    const order: OrderJson = {
      user: user.address.toLowerCase() as Hex,
      originChainId: String(stand.chainId),
      inputToken: token,
      inputAmount: '1003000000000000000',
      destination,
      outputAsset: `0x${'00'.repeat(12)}${token.slice(2)}`,
      minReceived: '990000000000000000',
      recipient: `0x${'00'.repeat(12)}${'28'.repeat(18)}${opened.toString(16).padStart(4, '0')}`,
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
    const mined = await send(key('FRANK'), router, encodeFunctionCall(entryOf(abi(CANCORE_ROUTER_ABI), 'function', 'openFor'), [order, permit, permitSig, quoteDeadline, quoteSig]));
    return { order, orderHash, block: mined.blockNumber, blockHash: mined.blockHash, nowMs: Number(now) * 1000 };
  }

  /** The checks before a receipt for `intent`, with the source's `openConfirmations`; every RPC request recorded. */
  async function verify(intent: OpenedIntent, openConfirmations: OpenDepth): Promise<{ result: EscrowVerification; escrowReadAt: Hex[] }> {
    const fill = createTestFillSigner(key('FILLER1'));
    const ticketSigner = createTestTypedDataSigner(key('TICKETSIGNER'));
    const clock = new FakeClock(intent.nowMs);
    const nowS = BigInt(Math.floor(intent.nowMs / 1000));
    const offer: TicketOffer = {
      type: 'ticket.offer', id: 'g-2808', fillerId: FILLER, sentAt: clock.now(), sig: '0x', orderHash: intent.orderHash, attempt: 0, order: intent.order,
      amountOut: intent.order.minReceived, validFrom: String(nowS), validUntil: String(nowS + 600n), acceptBy: clock.now() + 5_000,
    };
    const ticket = { orderHash: intent.orderHash, fillerId: fillerIdHash(FILLER), deliveryKey: fill.address.toLowerCase(), repayTo: repayToFromEvm(fill.address), attempt: 0, validFrom: offer.validFrom, validUntil: offer.validUntil };
    const ticketSig = await ticketSigner.signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
    const issued = { type: 'ticket.issued', form: 'evm', fillerId: FILLER, sentAt: clock.now(), sig: '0x', orderHash: intent.orderHash, attempt: 0, ticket, ticketSig } as unknown as TicketIssuedEvm;
    const recorded = recordingRpc(rpc);
    const chains = new FillerChains({ [chain]: [recorded] }, { [chain]: policy(openConfirmations) }, logger);
    const verifier = new TicketVerifier({ chains, fillSigners: { [chain]: fill }, fillerId: FILLER, ticketSigners: [ticketSigner.address], deltaIssueMs: 3_000, clock, events: createRecordingEventSink(), logger });
    const result = await verifier.verify({ offer, issued, issuedAtMs: clock.now() });
    const escrowReadAt = recorded.calls
      .filter((c) => c.method === 'eth_call' && (c.params![0] as { data: Hex }).data === intentsCall(intent.orderHash))
      .map((c) => (c.params![1] as { blockHash: Hex }).blockHash);
    return { result, escrowReadAt };
  }

  const escrowCheck = (result: EscrowVerification) => result.checks.find((c) => c.check === 'V-E2');
  const expectNotOpen = (result: EscrowVerification) => {
    expect(result).toMatchObject({ ok: false, reason: 'ESCROW_NOT_OPEN' });
    expect(result.checks.at(-1)).toMatchObject({ check: 'V-E2', status: 'failed', reason: 'ESCROW_NOT_OPEN' });
  };

  beforeAll(async () => {
    await send(key('FRANK'), token, `0xa0712d68${(10n ** 22n).toString(16).padStart(64, '0')}`);
    await send(key('FRANK'), token, encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'approve'), [PERMIT2, 2n ** 255n]));
    // safe and finalized below are a fixed depth only once the chain is longer than two epochs.
    const short = BigInt(2 * ANVIL_SLOTS_IN_AN_EPOCH + 1) - (await head());
    if (short > 0n) await mine(Number(short));
  });

  test('CAN-2808: an open reorged out before it is openConfirmations deep — V-E2 refuses ESCROW_NOT_OPEN on the new chain past the old height', async () => {
    const N = 3;
    const beforeOpen = await snapshot();
    const intent = await openIntent();
    expect((await readers(N).router.intents(intent.orderHash, 'latest')).status).toBe(INTENT_STATUS.Opened);
    expectNotOpen((await verify(intent, N)).result);

    await revert(beforeOpen);
    await mine(N + 1);
    expect(await head()).toBeGreaterThan(intent.block);
    expect((await block(intent.block)).hash.toLowerCase()).not.toBe(intent.blockHash);
    expect((await readers(N).router.intents(intent.orderHash, 'latest')).status).toBe(INTENT_STATUS.None);
    const { result } = await verify(intent, N);
    expectNotOpen(result);
    expect(result.detail).toBe(`V-E2: status ${INTENT_STATUS.None} at ${N} confirmations`);
  }, 60_000);

  test('CAN-2808: an open exactly openConfirmations deep is open; the read is pinned to the hash of the canonical block at head − N + 1', async () => {
    const N = 4;
    const intent = await openIntent();
    await mine(N - 2);
    const shallow = await verify(intent, N);
    expectNotOpen(shallow.result);

    await mine(1);
    const tip = await head();
    expect(tip - intent.block + 1n).toBe(BigInt(N));
    const canonical = (await block(tip - BigInt(N) + 1n)).hash.toLowerCase();
    expect(canonical).toBe(intent.blockHash);
    expect(await readers(N).client.pin({ confirmations: N })).toEqual({ blockHash: canonical });

    const { result, escrowReadAt } = await verify(intent, N);
    expect(escrowCheck(result)).toMatchObject({ status: 'passed' });
    expect(escrowReadAt).toEqual([canonical]);
  }, 60_000);

  test('CAN-2808: an open reorged out after it was openConfirmations deep — a later V-E2 refuses, and the watcher reports IntentOpened removed', async () => {
    const N = 3;
    const beforeOpen = await snapshot();
    const intent = await openIntent();
    await mine(N - 1);
    expect(escrowCheck((await verify(intent, N)).result)).toMatchObject({ status: 'passed' });

    const updates: RouterEventUpdate[] = [];
    const watcher = new RouterEventWatcher({ client: readers(N).client, router, confirmations: N, fromBlock: intent.block, onUpdate: (u) => void updates.push(u), logger });
    await watcher.poll();
    const ofThisOrder = () => updates.filter((u) => u.log.name === 'IntentOpened' && u.log.orderHash === intent.orderHash).map((u) => [u.kind, u.log.blockHash]);
    expect(ofThisOrder()).toEqual([['added', intent.blockHash]]);

    await revert(beforeOpen);
    await mine(N + 2);
    expect((await block(intent.block)).hash.toLowerCase()).not.toBe(intent.blockHash);
    expectNotOpen((await verify(intent, N)).result);

    await watcher.poll();
    expect(ofThisOrder()).toEqual([['added', intent.blockHash], ['removed', intent.blockHash]]);
  }, 60_000);

  test.each([
    ['safe', ANVIL_SLOTS_IN_AN_EPOCH],
    ['finalized', 2 * ANVIL_SLOTS_IN_AN_EPOCH],
  ] as const)(
    'CAN-2808: openConfirmations "%s" — anvil serves it at head − %i (slots-in-an-epoch 32, no consensus layer), so an open above that block is not open and at it is; the read is pinned to the tag block',
    async (tag, depth) => {
      const tagBlock = async () => BigInt((await block(tag)).number);
      expect(await tagBlock()).toBe((await head()) - BigInt(depth));

      const intent = await openIntent();
      expectNotOpen((await verify(intent, tag)).result);
      await mine(depth - 1);
      expect(await tagBlock()).toBe(intent.block - 1n);
      expectNotOpen((await verify(intent, tag)).result);

      await mine(1);
      expect(await tagBlock()).toBe(intent.block);
      const { result, escrowReadAt } = await verify(intent, tag);
      expect(escrowCheck(result)).toMatchObject({ status: 'passed' });
      expect(escrowReadAt).toEqual([(await block(tag)).hash.toLowerCase()]);
      expect(escrowReadAt).toEqual([intent.blockHash]);
    },
    60_000,
  );
});
