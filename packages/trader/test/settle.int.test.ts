/**
 * Self-settle against the real `CancoreRouter` of the local stand (meta
 * `make evm-genesis && make intent-genesis`, a router built from CAN-2140 on):
 * an intent opened on anvil (Permit2 witness by FRANK, quote by QUOTESIGNER),
 * delivered by the executor from FILLER1, attested by ATTESTOR1–3, settled by
 * `selfSettle` — the payout lands on the ticket's `repayTo`.
 *
 * The attestor signatures reach the SDK only through filler-gateway
 * (`settle.attestations`, `GET /v1/filler/attestations/{orderHash}`), and how
 * filler-gateway collects them is not decided (CAN-2189). This suite plays
 * filler-gateway: the stand's attestor keys sign the `FillProof` and the frame
 * is served to the settlement as the REST pull would (its envelope check is
 * the protocol client's, covered by its own tests). An outsider's extra
 * signature rides along and must be dropped.
 *
 *   CANCORE_INTENT_JSON=<meta>/docker/modules/genesis/out/intent.json \
 *   CANCORE_ACTORS_ENV=<meta>/docker/modules/genesis/out/local-actors.env \
 *   npm run test:int
 *
 * Skipped without the stand: CI of this repository has none (CAN-1876).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CANCORE_ROUTER_ABI,
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  IBURN_MINT_ERC20_ABI,
  ORDER_TYPES,
  QUOTE_TYPES,
  fillerIdHash,
  hashTypedData,
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
import { FillerChains, hashFillProof, hashOrder, type ChainConfig } from '../src/filler/chain';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { Executor } from '../src/filler/delivery/executor';
import type { Delivery, FillerProtocolClient, FrameHandler } from '../src/filler/protocol/client';
import type { EvmRpc } from '../src/filler/rpc';
import type { Clock } from '../src/filler/runtime';
import { fillProofOf } from '../src/filler/settlement/attestations';
import { Settler } from '../src/filler/settlement/settler';
import { addressOfPublicKey } from '../src/filler/signer';
import type { TicketRecord } from '../src/filler/store';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, InMemoryFillerStore } from '../src/filler/testing';

const INTENT = process.env.CANCORE_INTENT_JSON;
const ACTORS = process.env.CANCORE_ACTORS_ENV;
const live = INTENT && ACTORS ? describe : describe.skip;

const FILLER = 'stand-filler-1';
const PERMIT2: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** Permit2's own structs (Uniswap's, not a Cancore type); the witness is `Order` from @cancore/contracts. */
const PERMIT2_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Order' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  ...ORDER_TYPES,
} as const;

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
    (await createReaders().client.call(token, encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'balanceOf'), [owner])).then(BigInt));
  const createReaders = () => new FillerChains({ [chain]: [rpc] }, { [chain]: policy }, logger).get(chain)!;

  test('open → fill → attested by 2 of 3 plus an outsider → selfSettle: the outsider is dropped, repayTo is paid', async () => {
    const user = createTestFillSigner(key('FRANK'));
    const delivery = createTestFillSigner(key('FILLER1'));
    const mint = (amount: bigint) => `0xa0712d68${amount.toString(16).padStart(64, '0')}` as Hex;
    const approve = (spender: Hex) => encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'approve'), [spender, 2n ** 255n]);
    await send(key('FRANK'), token, mint(10n ** 21n));
    await send(key('FRANK'), token, approve(PERMIT2));
    await send(key('FILLER1'), token, mint(10n ** 21n));
    await send(key('FILLER1'), token, approve(router));

    // -- open --------------------------------------------------------------------------------
    const now = await chainTime();
    const order: OrderJson = {
      user: user.address.toLowerCase() as Hex,
      originChainId: String(stand.chainId),
      inputToken: token,
      inputAmount: '1003000000000000000',
      destination,
      outputAsset: `0x${'00'.repeat(12)}${token.slice(2)}`,
      minReceived: '990000000000000000',
      recipient: `0x${'00'.repeat(12)}${'0c'.repeat(19)}${(Number(now) % 256).toString(16).padStart(2, '0')}`,
      createdAt: String(now - 5n),
      fillDeadline: String(now + 1_800n),
      feeBps: '30',
    };
    const orderHash = hashOrder(order, { chainId: stand.chainId, router });
    const quoteDeadline = now + 300n;
    const quoteSig = await createTestTypedDataSigner(key('QUOTESIGNER')).signTypedData({ domain: routerDomain(stand.chainId, router), types: QUOTE_TYPES, primaryType: 'Quote', message: { orderHash, quoteDeadline } });
    const permit = { permitted: { token, amount: order.inputAmount }, nonce: BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(orderHash)))}`) >> 8n, deadline: order.fillDeadline };
    const permitSig = signDigest(
      key('FRANK'),
      hashTypedData({ domain: { name: 'Permit2', chainId: stand.chainId, verifyingContract: PERMIT2 }, types: PERMIT2_TYPES, primaryType: 'PermitWitnessTransferFrom', message: { ...permit, spender: router, witness: { ...order } } }),
    );
    await send(key('FRANK'), router, encodeFunctionCall(entryOf(abi(CANCORE_ROUTER_ABI), 'function', 'openFor'), [order, permit, permitSig, quoteDeadline, quoteSig]));

    // -- fill ----------------------------------------------------------------------------------
    const clockOffset = Number(now) * 1000 - Date.now();
    const clock: Clock = { now: () => Date.now() + clockOffset, schedule: (ms, cb) => { const h = setTimeout(cb, ms); return () => clearTimeout(h); } };
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
    const executor = new Executor({ store, chains, fillSigners: { [chain]: delivery }, fillerId: FILLER, receipted: async (h, a) => store.withOrder(h, (tx) => tx.getTicket(a)), instanceId: 'int-settle', clock, logger, events, delivery: { pollIntervalMs: 200 } });
    await executor.start();
    expect(await executor.deliver(orderHash, 0)).toMatchObject({ status: 'sent' });
    const fill = await waitFor(async () => {
      const f = await store.withOrder(orderHash, (tx) => tx.getFill(0));
      return f?.state === 'confirmed' ? f : undefined;
    }, 'the fill confirmed');

    // -- attest (playing filler-gateway) -------------------------------------------------------
    const reader = chains.get(chain)!.router;
    const setId = await reader.attestationSetFor(orderHash);
    const proof: FillProofJson = {
      kind: 1, orderHash, destination, fillRef: fill.txRef as Hex, recipient: order.recipient, outputAsset: order.outputAsset,
      amountDelivered: fill.received ?? fill.amount, filledAt: BigInt(String(fill.inclusion!.header.timestamp)).toString(),
      fillerId: fillerIdHash(FILLER), repayTo, attempt: 0, setId,
    };
    const digest = hashFillProof(fillProofOf(proof), { chainId: stand.chainId, router });
    const outsider: Hex = `0x${bytesToHex(keccak_256(utf8ToBytes('stand-outsider')))}`;
    const signatures: AttestationEvm[] = ['ATTESTOR1', 'ATTESTOR2', 'ATTESTOR3']
      .map((name) => ({ signer: addressOf(key(name)), signature: signDigest(key(name), digest) }))
      .concat([{ signer: addressOf(outsider), signature: signDigest(outsider, digest) }])
      .sort((a, b) => (a.signer < b.signer ? -1 : 1));
    const set = await reader.getAttestorSet(setId);
    const frame = { type: 'settle.attestations', id: 'stand-1', fillerId: FILLER, sentAt: clock.now(), orderHash, attempt: 0, sourceChainId: chain, proof, signatures, setId, threshold: set.threshold, refundAfter: String((await reader.intents(orderHash)).refundAfter), sig: `0x${'00'.repeat(65)}` };
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
    const settler = new Settler({ store, chains, executor, protocol, fillerId: FILLER, instanceId: 'int-settle', clock, logger, events });
    settler.register();

    // -- settle --------------------------------------------------------------------------------
    const payeeBefore = await balanceOf(delivery.address.toLowerCase() as Hex);
    const { txHash } = await settler.selfSettle(orderHash);
    expect(events.events.find((e) => e.type === 'attested')).toMatchObject({ setId, threshold: set.threshold, signers: expect.not.arrayContaining([addressOf(outsider)]) });
    await waitFor(async () => ((await store.withOrder(orderHash, (tx) => tx.getSettlement()))?.state === 'confirmed' ? true : undefined), 'the settle confirmed');
    expect((await store.withOrder(orderHash, (tx) => tx.getSettlement()))!.txHash).toBe(txHash);
    expect((await reader.intents(orderHash)).status).toBe(2);
    const payout = (BigInt(order.inputAmount) * 10_000n) / (10_000n + BigInt(order.feeBps));
    // FILLER1 is both the delivery key and the payee: it spent the fill, it got the payout.
    expect((await balanceOf(delivery.address.toLowerCase() as Hex)) - payeeBefore).toBe(payout);
    executor.stop();
  }, 60_000);
});
