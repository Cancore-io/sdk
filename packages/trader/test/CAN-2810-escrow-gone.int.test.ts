/**
 * CAN-2810 against the real `CancoreRouter` of the local stand (meta
 * `make evm-genesis && make intent-genesis`): an intent opened on anvil
 * (Permit2 witness by FRANK, quote by QUOTESIGNER) and delivered by the
 * executor from FILLER1, then a reorg past the open (`evm_snapshot` taken
 * before it, `evm_revert`, `anvil_mine` for the longer fork). The settlement
 * sweep must report `escrow-gone` — not `refund-near` on the `refundAfter` 0
 * an absent escrow reads — and keep reading the order: once the open is
 * included again, the sweep goes on to pull the attestations.
 *
 * The stand is one network, so the revert takes the delivery with it; the
 * filler's confirmed fill record stands for a delivery on another chain that
 * the source reorg does not touch.
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
  type TicketJson,
} from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { FillerChains, hashOrder, INTENT_STATUS, type ChainConfig } from '../src/filler/chain';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { Executor } from '../src/filler/delivery/executor';
import type { StageEvent } from '../src/filler/events';
import type { FillerProtocolClient } from '../src/filler/protocol/client';
import type { EvmRpc } from '../src/filler/rpc';
import type { Clock } from '../src/filler/runtime';
import { Settler } from '../src/filler/settlement/settler';
import type { TicketRecord } from '../src/filler/store';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, InMemoryFillerStore } from '../src/filler/testing';

const INTENT = process.env.CANCORE_INTENT_JSON;
const ACTORS = process.env.CANCORE_ACTORS_ENV;
const live = INTENT && ACTORS ? describe : describe.skip;

const FILLER = 'stand-filler-1';
const PERMIT2: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

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

live('CAN-2810: settlement sweep after a source reorg past the open (stand router)', () => {
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
  const mine = (blocks: number) => rpc.request({ method: 'anvil_mine', params: [`0x${blocks.toString(16)}`] });
  const send = async (privateKey: Hex, to: Hex, data: Hex): Promise<void> => {
    const signer = createTestFillSigner(privateKey);
    const nonce = BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [signer.address, 'pending'] }));
    const raw = await signer.signTransaction({ chainId: BigInt(stand.chainId), nonce, to, data, value: 0n, gasLimit: 1_000_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const hash = await rpc.request<Hex>({ method: 'eth_sendRawTransaction', params: [raw] });
    const receipt = await waitFor(async () => (await rpc.request<{ status: string } | null>({ method: 'eth_getTransactionReceipt', params: [hash] })) ?? undefined, `receipt of ${hash}`);
    if (receipt.status !== '0x1') throw new Error(`transaction to ${to} reverted`);
  };

  test('CAN-2810: an open reorged out after the delivery — the sweep alerts escrow-gone, not refund-near, and goes on once the open is back', async () => {
    const user = createTestFillSigner(key('FRANK'));
    const delivery = createTestFillSigner(key('FILLER1'));
    const mint = (amount: bigint) => `0xa0712d68${amount.toString(16).padStart(64, '0')}` as Hex;
    const approve = (spender: Hex) => encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'approve'), [spender, 2n ** 255n]);
    await send(key('FRANK'), token, mint(10n ** 21n));
    await send(key('FRANK'), token, approve(PERMIT2));
    await send(key('FILLER1'), token, mint(10n ** 21n));
    await send(key('FILLER1'), token, approve(router));

    // -- open ------------------------------------------------------------------------------------
    const now = await chainTime();
    const order: OrderJson = {
      user: user.address.toLowerCase() as Hex,
      originChainId: String(stand.chainId),
      inputToken: token,
      inputAmount: '1003000000000000000',
      destination,
      outputAsset: `0x${'00'.repeat(12)}${token.slice(2)}`,
      minReceived: '990000000000000000',
      recipient: `0x${'00'.repeat(12)}${'0e'.repeat(19)}${(Number(now) % 256).toString(16).padStart(2, '0')}`,
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
    const openFor = encodeFunctionCall(entryOf(abi(CANCORE_ROUTER_ABI), 'function', 'openFor'), [order, permit, permitSig, quoteDeadline, quoteSig]);
    const beforeOpen = await rpc.request<string>({ method: 'evm_snapshot', params: [] });
    await send(key('FRANK'), router, openFor);

    // -- deliver -----------------------------------------------------------------------------------
    const clockOffset = Number(now) * 1000 - Date.now();
    const clock: Clock = { now: () => Date.now() + clockOffset, schedule: (ms, cb) => { const h = setTimeout(cb, ms); return () => clearTimeout(h); } };
    const store = new InMemoryFillerStore(clock);
    const ticket: TicketJson = { orderHash, fillerId: fillerIdHash(FILLER), deliveryKey: delivery.address.toLowerCase() as Hex, repayTo: repayToFromEvm(delivery.address), attempt: 0, validFrom: String(now - 5n), validUntil: String(now + 600n) };
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
    const executor = new Executor({ store, chains, fillSigners: { [chain]: delivery }, fillerId: FILLER, receipted: async (h, a) => store.withOrder(h, (tx) => tx.getTicket(a)), instanceId: 'int-2810', clock, logger, events, delivery: { pollIntervalMs: 200 } });
    await executor.start();
    expect(await executor.deliver(orderHash, 0)).toMatchObject({ status: 'sent' });
    const fill = await waitFor(async () => {
      const f = await store.withOrder(orderHash, (tx) => tx.getFill(0));
      return f?.state === 'confirmed' ? f : undefined;
    }, 'the fill confirmed');
    executor.stop();
    const reader = chains.get(chain)!.router;
    expect((await reader.intents(orderHash)).status).toBe(INTENT_STATUS.Opened);

    // -- reorg past the open -------------------------------------------------------------------------
    await rpc.request({ method: 'evm_revert', params: [beforeOpen] });
    await mine(3);
    expect((await reader.intents(orderHash)).status).toBe(INTENT_STATUS.None);

    let pulls = 0;
    const protocol = {
      on: () => undefined,
      onLogin: () => undefined,
      pullAttestations: async () => {
        pulls++;
        return false;
      },
    } as unknown as FillerProtocolClient;
    // refundAfter of a real open is well past this margin: a refund-near alert could only come from the absent escrow.
    const settler = new Settler({ store, chains, executor, protocol, fillerId: FILLER, instanceId: 'int-2810', clock, logger, events, settlement: { alertBeforeRefundMs: 60_000 } });
    settler.register();
    const alerts = () => events.events.filter((e): e is StageEvent => e.type === 'stage' && e.stage === 'settle.alert');

    await settler.sweep();
    await settler.sweep();
    expect(alerts().map((a) => a.detail!.kind)).toEqual(['escrow-gone']);
    expect(alerts()[0]!.detail).toMatchObject({ chain, fillTx: fill.txRef });
    expect(await store.withOrder(orderHash, (tx) => tx.getSettlement())).toBeUndefined();
    expect(pulls).toBe(0);

    // -- the open included again ---------------------------------------------------------------------
    await send(key('FRANK'), router, openFor);
    expect((await reader.intents(orderHash)).status).toBe(INTENT_STATUS.Opened);
    await settler.sweep();
    expect(pulls).toBe(1);
    expect(alerts().map((a) => a.detail!.kind)).toEqual(['escrow-gone']);
  }, 60_000);
});
