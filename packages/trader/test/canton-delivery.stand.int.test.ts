/**
 * CAN-1867, the integration test: EVM → Canton on the full intent stand
 * (meta `intent-stand`, Cancore-io/meta#712, runbook
 * docs/runbooks/intent-stand.md) — a Canton participant with the
 * `cancore-intent` and CNRX packages, the real filler-gateway, trading,
 * registry-api and attestors, anvil with the deployed CancoreRouter. Nothing
 * is played: the SDK filler logs in to filler-gateway, takes the ticket,
 * checks the DeliveryOrder and the escrow, signs `CantonTicketReceipt`,
 * delivers with `DeliveryOrder_Fill` (prepared by trading, checked here,
 * signed with the party key, submitted by trading), pulls the attestations
 * and settles on the router.
 *
 * The stand provisions the filler (ACTIVE, its routes, its external party
 * with a live registry entry and ≥ 1000 free CNRX), the recipient's CNRX
 * preapproval and the maker (funded, Permit2-approved). The order is opened on
 * the router by the maker with the stand's quote signer; trading picks it up
 * from the indexer.
 *
 * Skipped without INTENT_STAND_ENV (the path of the stand's env file; the job
 * also exports every key). Run by the shared stand job:
 *
 *   gh workflow run intent-stand-dispatch.yml -R Cancore-io/.github -f test-repo=sdk -f test-ref=<branch> \
 *     -f test-command='npm ci && npm run build -w @cancore/contracts && npx jest --selectProjects int --runInBand packages/trader/test/canton-delivery.stand.int.test.ts'
 */
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
  routerDomain,
  type Hex,
  type OrderJson,
} from '@cancore/contracts';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { CANTON_TRANSFER_FACTORIES, type CantonTransferFactory } from '../src/filler/canton/factories';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { ChainClient } from '../src/filler/chain/client';
import { hashOrder } from '../src/filler/chain/hashes';
import { INTENT_STATUS, RouterReader } from '../src/filler/chain/router';
import type { EvmChainId } from '../src/filler/chains';
import { createFiller, type Filler } from '../src/filler/filler';
import type { EvmRpc } from '../src/filler/rpc';
import type { WebSocketFactory } from '../src/filler/runtime';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, InMemoryFillerStore } from '../src/filler/testing';

const STAND = process.env.INTENT_STAND_ENV;
const live = STAND ? describe : describe.skip;
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`intent-stand env: ${name} is not set (Cancore-io/meta docs/runbooks/intent-stand.md)`);
  return value;
};

const abi = (entries: unknown) => entries as unknown as readonly AbiEntry[];
const httpRpc = (url: string): EvmRpc => {
  let id = 0;
  return {
    label: 'stand-anvil',
    async request<T>({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<T> {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw body.error;
      return body.result as T;
    },
  };
};

/** Node's global WebSocket as the SDK's factory. */
const nativeWebSocket: WebSocketFactory = (url, h, protocols) => {
  const ws = new WebSocket(url, [...protocols]);
  ws.addEventListener('open', () => h.onOpen());
  ws.addEventListener('message', (e) => void (typeof e.data === 'string' ? h.onMessage(e.data) : undefined));
  ws.addEventListener('close', (e) => h.onClose(e.code, e.reason));
  ws.addEventListener('error', (e) => h.onError(e));
  return { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
};

const signDigest = (key: Hex, digest: Hex): Hex => {
  const sig = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(key.slice(2)), { lowS: true });
  return `0x${bytesToHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}`;
};

async function waitFor<T>(what: string, read: () => Promise<T | undefined>, timeoutMs: number, diagnostics: () => string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}\n${diagnostics()}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

live('CAN-1867: EVM → Canton on the full intent stand', () => {
  // describe.skip still runs this body: without the stand nothing below may read the env.
  if (!STAND) {
    test('TC-CAN-1867-STAND-01: needs the intent stand (INTENT_STAND_ENV)', () => undefined);
    return;
  }
  const chain = `eip155:${env('EVM_CHAIN_ID')}` as EvmChainId;
  const router = env('INTENT_ROUTER_ADDRESS').toLowerCase() as Hex;
  const rpc = httpRpc(env('EVM_RPC_URL'));
  const logger = createRecordingLogger();
  const events = createRecordingEventSink();
  const store = new InMemoryFillerStore();
  const asset = { admin: env('CNRX_ADMIN_PARTY'), id: 'CNRX' };
  const proofWindowSec = Number(env('CANTON_PROOF_WINDOW_S'));
  const fillKey = env('STAND_FILLER_EVM_KEY') as Hex;
  const fillSigner = createTestFillSigner(fillKey);
  const client = new ChainClient({ chain, endpoints: [rpc], maxHeadLagBlocks: 5, logger });
  const reader = new RouterReader(chain, router, client);
  let filler: Filler;

  /** What happened, for a red run: the SDK's stages and its warnings. */
  const diagnostics = () =>
    [
      ...events.events.filter((e) => e.type === 'stage' || e.type === 'declined').map((e) => JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      ...logger.entries.filter((l) => l.level !== 'debug').slice(-40).map((l) => `${l.level} ${l.message} ${JSON.stringify(l.fields ?? {})}`),
    ].join('\n');

  beforeAll(async () => {
    // The stand's CNRX admin differs from dev's: its registry is pinned for this run from the stand ledger's
    // package id (CANTON_TRANSFER_FACTORIES_JSON). The delivery check runs unchanged against that pin.
    const stand = JSON.parse(env('CANTON_TRANSFER_FACTORIES_JSON')) as Record<string, CantonTransferFactory[]>;
    Object.assign(CANTON_TRANSFER_FACTORIES as Record<string, readonly CantonTransferFactory[]>, stand);

    const seed = hexToBytes(env('STAND_FILLER_CANTON_PARTY_KEY').replace(/^0x/, ''));
    filler = createFiller({
      gatewayUrl: env('FILLER_GATEWAY_WS_URL'),
      fillerId: env('STAND_FILLER_ID'),
      gatewaySigner: env('FILLER_GATEWAY_SIGNER') as Hex,
      ticketSigners: env('TICKET_SIGNERS').split(',').map((s) => s.trim() as Hex),
      quoteSigner: createTestTypedDataSigner(env('STAND_FILLER_MESSAGE_KEY') as Hex),
      fillSigners: { [chain]: fillSigner },
      rpc: { [chain]: [rpc] },
      chains: { [chain]: { router, openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: proofWindowSec, sendGuardSec: 10, minGasWei: 0n, fillConfirmations: 1 } },
      tickets: { deltaIssueMs: 3_000 },
      canton: {
        party: env('STAND_FILLER_CANTON_PARTY'),
        partySigner: { publicKey: `0x${bytesToHex(ed25519.getPublicKey(seed))}` as Hex, signHash: async (hash) => `0x${bytesToHex(ed25519.sign(hash, seed))}` as Hex },
        participantUid: env('CANTON_PARTICIPANT_UID'),
        destination: { minTicketTtlSec: 60, requiredProofWindowSec: proofWindowSec, sendGuardSec: 20 },
      },
      store,
      webSocket: nativeWebSocket,
      logger,
      events,
      settlement: { pullIntervalMs: 5_000 },
    });
    filler.onQuoteRequest(async () => null);
    filler.onReconfirm(async () => true);
    filler.onTicketOffer(async () => 'accept');
    await filler.start();
  }, 120_000);

  afterAll(async () => {
    await filler?.stop();
  });

  test('TC-CAN-1867-STAND-01: an order to canton:devnet is delivered by the filler’s party and settled on the router: repayTo paid, the party’s CNRX spent', async () => {
    // -- the route as Cancore serves it ------------------------------------------------------
    // trading serves the catalog (RouteCatalogService over INTENT_ROUTES); the gateway may not proxy it on the stand.
    type Route = { src: string; dst: string; feeBps: number; fillDeadlineTtlS: number; inputs: Array<{ asset: unknown; decimals: number }> };
    let route: Route | undefined;
    for (const base of [process.env.TRADING_URL, process.env.GATEWAY_URL].filter((u): u is string => !!u)) {
      const response = await fetch(`${base}/v1/intents/routes`).catch(() => undefined);
      if (!response?.ok) continue;
      route = ((await response.json()) as { routes: Route[] }).routes.find((r) => r.src === chain && r.dst === env('CANTON_CHAIN'));
      if (route) break;
    }
    if (!route) throw new Error(`no route ${chain} → ${env('CANTON_CHAIN')} at TRADING_URL or GATEWAY_URL /v1/intents/routes`);

    // -- open, as the maker, on the router -----------------------------------------------------
    const maker = createTestFillSigner(env('MAKER_EVM_KEY') as Hex);
    const token = env('INPUT_TOKEN_ADDRESS').toLowerCase() as Hex;
    // The stand's test tokens carry their own decimals: the catalog's, else the token's own.
    const listed = route.inputs.find((i) => typeof i.asset === 'string' && i.asset.toLowerCase() === token);
    const decimals = listed?.decimals ?? Number(BigInt(await client.call(token, '0x313ce567')));
    const permit2 = env('PERMIT2_ADDRESS') as Hex;
    const head = await client.block('latest');
    const now = BigInt((await rpc.request<{ timestamp: string }>({ method: 'eth_getBlockByHash', params: [head.hash, false] })).timestamp);
    const order: OrderJson = {
      user: maker.address.toLowerCase() as Hex,
      originChainId: env('EVM_CHAIN_ID'),
      inputToken: token,
      inputAmount: (10n * 10n ** BigInt(decimals)).toString(),
      destination: encodeCantonDestination('devnet'),
      outputAsset: encodeCantonOutputAsset(asset),
      minReceived: encodeCantonAmount('5').toString(),
      recipient: encodeCantonRecipient(env('STAND_CANTON_RECIPIENT_PARTY')),
      createdAt: String(now - 5n),
      fillDeadline: String(now + BigInt(route.fillDeadlineTtlS)),
      feeBps: String(route.feeBps),
      fillerId: fillerIdHash(env('STAND_FILLER_ID')),
    };
    const orderHash = hashOrder(order, { chainId: BigInt(env('EVM_CHAIN_ID')), router });
    const quoteDeadline = now + 300n;
    const quoteSig = await createTestTypedDataSigner(env('QUOTE_SIGNER_KEY') as Hex).signTypedData({ domain: routerDomain(Number(env('EVM_CHAIN_ID')), router), types: QUOTE_TYPES, primaryType: 'Quote', message: { orderHash, quoteDeadline } });
    const permit = { permitted: { token, amount: order.inputAmount }, nonce: BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(orderHash)))}`) >> 8n, deadline: order.fillDeadline };
    const permitSig = signDigest(env('MAKER_EVM_KEY') as Hex, hashPermitWitness({ ...permit, spender: router, witness: order }, Number(env('EVM_CHAIN_ID')), permit2));
    const data = encodeFunctionCall(entryOf(abi(CANCORE_ROUTER_ABI), 'function', 'openFor'), [order, permit, permitSig, quoteDeadline, quoteSig]);
    const nonce = BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [maker.address, 'pending'] }));
    const raw = await maker.signTransaction({ chainId: BigInt(env('EVM_CHAIN_ID')), nonce, to: router, data, value: 0n, gasLimit: 1_500_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    await rpc.request({ method: 'eth_sendRawTransaction', params: [raw] });
    await waitFor('the intent opened', async () => ((await reader.intents(orderHash)).status === INTENT_STATUS.Opened ? true : undefined), 60_000, diagnostics);

    // The payee: the filler's EVM key on the source, padded into repayTo (the stand gives either form).
    const payee = fillSigner.address.toLowerCase() as Hex;
    const standRepayTo = env('STAND_FILLER_REPAY_TO').toLowerCase();
    expect(standRepayTo.length === 66 ? `0x${standRepayTo.slice(26)}` : standRepayTo).toBe(payee);
    const balanceOf = async (owner: Hex) => BigInt(await client.call(token, encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'balanceOf'), [owner])));
    const payeeBefore = await balanceOf(payee);
    const free = async () => (await filler.canton!.holdings()).filter((h) => !h.locked && h.asset.admin === asset.admin && h.asset.id === asset.id).reduce((sum, h) => sum + encodeCantonAmount(h.amount), 0n);
    const cnrxBefore = await free();

    // -- ticket, receipt, delivery on Canton ----------------------------------------------------
    const fill = await waitFor(
      'the Canton delivery confirmed (ticket → receipt → delivery.fill)',
      async () => {
        const f = await store.withOrder(orderHash, async (tx) => {
          for (const t of await tx.listTickets()) {
            const r = await tx.getFill(t.attempt);
            if (r?.state === 'confirmed') return r;
          }
          return undefined;
        });
        return f;
      },
      8 * 60_000,
      diagnostics,
    );
    expect(fill).toMatchObject({ chain: env('CANTON_CHAIN'), state: 'confirmed' });
    expect(fill.txRef).not.toBe('');
    expect(BigInt(fill.amount)).toBeGreaterThanOrEqual(BigInt(order.minReceived));
    expect(events.events).toContainEqual(expect.objectContaining({ type: 'filled', orderHash }));
    // The party paid the delivery out of its own free CNRX.
    expect(cnrxBefore - (await free())).toBe(BigInt(fill.amount));

    // -- attested and settled on the router -----------------------------------------------------
    await waitFor('the intent settled on the router (attestations → selfSettle)', async () => ((await reader.intents(orderHash)).status === INTENT_STATUS.Settled ? true : undefined), 10 * 60_000, diagnostics);
    const payout = (BigInt(order.inputAmount) * 10_000n) / (10_000n + BigInt(order.feeBps));
    expect((await balanceOf(payee)) - payeeBefore).toBe(payout);
  }, 20 * 60_000);
});
