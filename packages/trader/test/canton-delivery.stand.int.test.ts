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
 * preapproval, the maker (funded, Permit2-approved, its wallet linked to the
 * stand user). The order goes the user's way: POST /v1/intents/quote (the SDK
 * filler answers the quote.request), POST /v1/intents/quote/{id}/pick of the
 * stand filler, then openFor on the router with the pick's quote signature —
 * trading tickets only a picked order and records the Canton recipient with
 * the quote.
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
  encodeCantonAmount,
  encodeCantonDestination,
  encodeCantonOutputAsset,
  encodeCantonRecipient,
  fillerIdHash,
  hashPermitWitness,
  type Hex,
  type OrderJson,
} from '@cancore/contracts';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { CantonTransferFactory } from '../src/filler/canton/factories';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { ChainClient } from '../src/filler/chain/client';
import { RouterEventWatcher, type RouterEventUpdate } from '../src/filler/chain/events';
import { hashOrder } from '../src/filler/chain/hashes';
import { INTENT_STATUS, RouterReader } from '../src/filler/chain/router';
import type { EvmChainId } from '../src/filler/chains';
import { createFiller, type Filler } from '../src/filler/filler';
import type { EvmRpc } from '../src/filler/rpc';
import type { WebSocketFactory } from '../src/filler/runtime';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, InMemoryFillerStore } from '../src/filler/testing';
import { activeContracts, cantonToken, env } from './stand/canton-ledger';

const STAND = process.env.INTENT_STAND_ENV;
/** Every key this spec reads (Cancore-io/meta docs/runbooks/intent-stand.md); TRADING_URL or GATEWAY_URL besides. */
const REQUIRED = [
  'CANTON_CHAIN', 'CANTON_PARTICIPANT_UID', 'CANTON_PROOF_WINDOW_S', 'CANTON_TRANSFER_FACTORIES_JSON', 'CNRX_ADMIN_PARTY',
  'EVM_CHAIN_ID', 'EVM_RPC_URL', 'FILLER_GATEWAY_SIGNER', 'FILLER_GATEWAY_WS_URL', 'INPUT_TOKEN_ADDRESS', 'INTENT_ROUTER_ADDRESS',
  'MAKER_EVM_KEY', 'STAND_CANTON_RECIPIENT_PARTY', 'STAND_FILLER_CANTON_PARTY', 'STAND_FILLER_CANTON_PARTY_KEY', 'STAND_FILLER_EVM_KEY',
  'STAND_FILLER_ID', 'STAND_FILLER_MESSAGE_KEY', 'STAND_FILLER_REPAY_TO', 'STAND_USER_CLIENT_ID', 'STAND_USER_CLIENT_SECRET',
  'STAND_USER_NAME', 'STAND_USER_PASSWORD', 'STAND_USER_TOKEN_URL', 'TICKET_SIGNERS', 'PERMIT2_ADDRESS',
  'CANTON_JSON_API_URL', 'CANTON_TOKEN_URL', 'CANTON_CLIENT_ID', 'CANTON_CLIENT_SECRET',
] as const;

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

/**
 * The stand user's bearer token, fresh per call (a token lives minutes, the run
 * longer): a password grant for STAND_USER_NAME (a Keycloak username) through
 * the gateway's own client (CAN-2380 admits it).
 */
async function userToken(): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'password',
    client_id: env('STAND_USER_CLIENT_ID'),
    client_secret: env('STAND_USER_CLIENT_SECRET'),
    username: env('STAND_USER_NAME'),
    password: env('STAND_USER_PASSWORD'),
    scope: 'openid',
  });
  const response = await fetch(env('STAND_USER_TOKEN_URL'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) throw new Error(`stand user login: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/**
 * The unlocked holdings of `party` in `asset` on the ledger itself (JSON Ledger API v2, the active contracts of
 * the registry's holding template), Numeric 10 × 10¹⁰ — read independently of the SDK and of filler-gateway.
 */
async function ledgerHoldings(party: string, asset: { admin: string; id: string }, registry: CantonTransferFactory): Promise<bigint> {
  const templateId = `#${process.env.CANTON_REGISTRY_PACKAGE_NAME || 'cnrx-registry'}:${registry.holding}`;
  const events = await activeContracts(party, { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } }, await cantonToken());
  type View = { account?: { owner?: string | null }; instrumentId?: { admin?: string; id?: string }; amount?: string; lock?: unknown };
  let total = 0n;
  for (const event of events) {
    const view = event.createArgument?.[registry.holdingView] as View | undefined;
    if (!view || view.account?.owner !== party || view.lock) continue;
    if (view.instrumentId?.admin !== asset.admin || view.instrumentId?.id !== asset.id || typeof view.amount !== 'string') continue;
    total += encodeCantonAmount(view.amount);
  }
  return total;
}

async function waitFor<T>(what: string, read: () => Promise<T | undefined>, timeoutMs: number, diagnostics: () => string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}\n${diagnostics()}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

describe('CAN-1867: EVM → Canton on the full intent stand', () => {
  // Without the stand the test is skipped, never passed; with the stand named but its env incomplete it fails,
  // naming every missing key. Nothing below reads the env before these two gates.
  if (!STAND) {
    test.skip('TC-CAN-1867-STAND-01: needs the intent stand (INTENT_STAND_ENV)', () => undefined);
    return;
  }
  const missing = [...REQUIRED.filter((k) => !process.env[k]), ...(process.env.TRADING_URL || process.env.GATEWAY_URL ? [] : ['TRADING_URL or GATEWAY_URL'])];
  if (missing.length > 0) {
    test('TC-CAN-1867-STAND-01: the intent-stand env is complete', () => {
      throw new Error(`INTENT_STAND_ENV is set but the stand env lacks: ${missing.join(', ')}`);
    });
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
  let registries: Record<string, CantonTransferFactory[]> = {};

  /** What happened, for a red run: the SDK's stages and its warnings. */
  const diagnostics = () =>
    [
      ...events.events.filter((e) => e.type === 'stage' || e.type === 'declined').map((e) => JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      ...logger.entries.filter((l) => l.level !== 'debug').slice(-40).map((l) => `${l.level} ${l.message} ${JSON.stringify(l.fields ?? {})}`),
    ].join('\n');

  beforeAll(async () => {
    // The stand's CNRX admin differs from dev's: its registry, read from the stand ledger, is the filler's
    // FillerConfig.canton.registries; the delivery check holds the transfer to it.
    registries = JSON.parse(env('CANTON_TRANSFER_FACTORIES_JSON')) as Record<string, CantonTransferFactory[]>;

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
        registries,
      },
      store,
      webSocket: nativeWebSocket,
      logger,
      events,
      settlement: { pullIntervalMs: 5_000 },
    });
    // The stand filler prices the Canton route only: 5 CNRX for any input, firm a minute past the quote's own
    // life (windowCloseAt + quoteTtlMs): a shorter validUntil is skipped as short-ttl.
    filler.onQuoteRequest(async (request) =>
      request.route.dst === env('CANTON_CHAIN')
        ? { amountOut: encodeCantonAmount('5'), validUntil: BigInt(Math.ceil((request.windowCloseAt + request.quoteTtlMs) / 1000) + 60) }
        : null,
    );
    filler.onReconfirm(async () => true);
    filler.onTicketOffer(async () => 'accept');
    await filler.start();
  }, 120_000);

  afterAll(async () => {
    await filler?.stop();
  });

  test('TC-CAN-1867-STAND-01: an order to canton:devnet is delivered by the filler’s party and settled on the router: repayTo paid, the party’s CNRX spent', async () => {
    // -- quote → pick → openFor, as a user of Cancore (backend quote.service): only a picked order is ticketed,
    // and the Canton recipient is recorded with the quote (the readiness check and DeliveryBook_Dispatch read it).
    // trading serves /v1/intents/quote with its own JWT guard; the gateway is tried when trading refuses the token.
    const bases = [process.env.TRADING_URL, process.env.GATEWAY_URL].filter((u): u is string => !!u);
    const api = async <T>(path: string, body: unknown): Promise<T> => {
      let last = '';
      for (const base of bases) {
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await userToken()}` }, body: JSON.stringify(body) });
        const text = await response.text();
        if (response.ok) return JSON.parse(text) as T;
        last = `${base}${path}: ${response.status} ${text.slice(0, 500)}`;
        if (response.status !== 401 && response.status !== 404) break;
      }
      throw new Error(`POST ${last}\n${diagnostics()}`);
    };
    const token = env('INPUT_TOKEN_ADDRESS').toLowerCase() as Hex;
    // The stand's test tokens carry their own decimals.
    const decimals = Number(BigInt(await client.call(token, '0x313ce567')));
    const quote = await api<{ quoteId: string; offers: Array<{ fillerId: string; amountOut: string }> }>('/v1/intents/quote', {
      src: chain,
      dst: env('CANTON_CHAIN'),
      inputToken: token,
      inputAmount: (10n * 10n ** BigInt(decimals)).toString(),
      outputAsset: asset,
      recipient: env('STAND_CANTON_RECIPIENT_PARTY'),
    });
    const offer = quote.offers.find((o) => o.fillerId === env('STAND_FILLER_ID'));
    if (!offer) throw new Error(`the quote has no offer of ${env('STAND_FILLER_ID')}: ${JSON.stringify(quote.offers)}\n${diagnostics()}`);
    // The filler's own quote (5 CNRX) is what the user is offered and what the order guarantees.
    expect(offer.amountOut).toBe(encodeCantonAmount('5').toString());
    const pick = await api<{ orderHash: Hex; toSign: { chainId: number; router: Hex; order: OrderJson; permit: { message: { permitted: { token: Hex; amount: string }; nonce: string; deadline: string } }; quoteDeadline: number; quoteSig: Hex } | null }>(
      `/v1/intents/quote/${quote.quoteId}/pick`,
      { fillerId: env('STAND_FILLER_ID') },
    );
    const toSign = pick.toSign;
    if (!toSign) throw new Error('the pick of an EVM-source quote came back without toSign');
    const order = toSign.order;
    const orderHash = pick.orderHash.toLowerCase() as Hex;
    expect(toSign.router.toLowerCase()).toBe(router);
    expect(hashOrder(order, { chainId: BigInt(toSign.chainId), router })).toBe(orderHash);
    expect(order.recipient.toLowerCase()).toBe(encodeCantonRecipient(env('STAND_CANTON_RECIPIENT_PARTY')));
    expect(order.outputAsset.toLowerCase()).toBe(encodeCantonOutputAsset(asset));
    expect(order.destination.toLowerCase()).toBe(encodeCantonDestination('devnet'));
    expect(order.fillerId.toLowerCase()).toBe(fillerIdHash(env('STAND_FILLER_ID')));
    expect(order.minReceived).toBe(offer.amountOut);

    const maker = createTestFillSigner(env('MAKER_EVM_KEY') as Hex);
    const permit2 = env('PERMIT2_ADDRESS') as Hex;
    const { permitted, nonce: permitNonce, deadline } = toSign.permit.message;
    const permit = { permitted, nonce: permitNonce, deadline };
    // The Permit2 witness is a nested struct: the package's own digest, signed with the maker's key.
    const permitSig = signDigest(env('MAKER_EVM_KEY') as Hex, hashPermitWitness({ ...permit, spender: router, witness: order }, toSign.chainId, permit2));
    const data = encodeFunctionCall(entryOf(abi(CANCORE_ROUTER_ABI), 'function', 'openFor'), [order, permit, permitSig, BigInt(toSign.quoteDeadline), toSign.quoteSig]);
    // Both balances are read before the open reaches the chain: from then on the filler may deliver at any moment.
    // The payee: the filler's EVM key on the source, padded into repayTo (the stand gives either form).
    const payee = fillSigner.address.toLowerCase() as Hex;
    const standRepayTo = env('STAND_FILLER_REPAY_TO').toLowerCase();
    expect(standRepayTo.length === 66 ? `0x${standRepayTo.slice(26)}` : standRepayTo).toBe(payee);
    const balanceOf = async (owner: Hex) => BigInt(await client.call(token, encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'balanceOf'), [owner])));
    const payeeBefore = await balanceOf(payee);
    const free = async () => (await filler.canton!.holdings()).filter((h) => !h.locked && h.asset.admin === asset.admin && h.asset.id === asset.id).reduce((sum, h) => sum + encodeCantonAmount(h.amount), 0n);
    const cnrxBefore = await free();
    const recipient = env('STAND_CANTON_RECIPIENT_PARTY');
    const registry = (registries[asset.admin] ?? [])[0];
    if (!registry) throw new Error(`CANTON_TRANSFER_FACTORIES_JSON has no registry of ${asset.admin}`);
    const recipientBefore = await ledgerHoldings(recipient, asset, registry);

    const nonce = BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [maker.address, 'pending'] }));
    const raw = await maker.signTransaction({ chainId: BigInt(toSign.chainId), nonce, to: router, data, value: 0n, gasLimit: 1_500_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const openTx = await rpc.request<Hex>({ method: 'eth_sendRawTransaction', params: [raw] });
    const openBlock = await waitFor('the open mined', async () => {
      const receipt = await rpc.request<{ status: string; blockNumber: string } | null>({ method: 'eth_getTransactionReceipt', params: [openTx] });
      if (receipt && receipt.status !== '0x1') throw new Error(`openFor reverted\n${diagnostics()}`);
      return receipt ? BigInt(receipt.blockNumber) : undefined;
    }, 60_000, diagnostics);
    await waitFor('the intent opened', async () => ((await reader.intents(orderHash)).status === INTENT_STATUS.Opened ? true : undefined), 60_000, diagnostics);

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
    // Exactly the quoted amount: the order's minReceived, the filler's offer.
    expect(fill.amount).toBe(order.minReceived);
    // The party paid it out of its own free CNRX, and the recipient's ledger holdings grew by exactly it — once.
    expect(cnrxBefore - (await free())).toBe(BigInt(fill.amount));
    expect((await ledgerHoldings(recipient, asset, registry)) - recipientBefore).toBe(BigInt(fill.amount));

    // One delivery: one fill recorded over every attempt, one `filled`; and it came after the escrow was open at depth.
    const fills = await store.withOrder(orderHash, async (tx) => (await Promise.all((await tx.listTickets()).map((t) => tx.getFill(t.attempt)))).filter((f) => f && f.state !== 'failed'));
    expect(fills).toHaveLength(1);
    const ofOrder = events.events.filter((e) => 'orderHash' in e && e.orderHash === orderHash);
    expect(ofOrder.filter((e) => e.type === 'filled')).toHaveLength(1);
    const at = (stage: string, detail?: Record<string, unknown>) =>
      ofOrder.findIndex((e) => e.type === 'stage' && e.stage === stage && (!detail || Object.entries(detail).every(([k, v]) => (e.detail as Record<string, unknown>)[k] === v)));
    const escrowOpen = at('ticket.checked', { check: 'V-E2', status: 'passed' });
    const delivered = at('fill.sent');
    expect(escrowOpen).toBeGreaterThanOrEqual(0);
    expect(delivered).toBeGreaterThan(escrowOpen);

    // -- attested and settled on the router -----------------------------------------------------
    await waitFor('the intent settled on the router (attestations → selfSettle)', async () => ((await reader.intents(orderHash)).status === INTENT_STATUS.Settled ? true : undefined), 10 * 60_000, diagnostics);
    const payout = (BigInt(order.inputAmount) * 10_000n) / (10_000n + BigInt(order.feeBps));
    expect((await balanceOf(payee)) - payeeBefore).toBe(payout);

    // One settle: the router logged this order opened once, settled once, never filled on this chain (it was
    // delivered on Canton); and the open preceded the settle.
    const logs: RouterEventUpdate[] = [];
    const watcher = new RouterEventWatcher({ client, router, confirmations: 0, fromBlock: openBlock, onUpdate: (u) => void logs.push(u), logger });
    await watcher.poll();
    await watcher.poll();
    const named = (name: string) => logs.filter((u) => u.kind === 'added' && u.log.orderHash === orderHash && u.log.name === name);
    expect(named('IntentOpened')).toHaveLength(1);
    expect(named('Settled')).toHaveLength(1);
    expect(named('Filled')).toHaveLength(0);
    expect(named('Settled')[0]!.log.blockNumber).toBeGreaterThan(openBlock);
  }, 20 * 60_000);
});
