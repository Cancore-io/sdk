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
 * and settles on the router. TC-SDK-1867-INT-03 breaks the delivery's submit
 * twice: every answer lost and the node restarted on the same store; the
 * replica dead with the submit in flight and another one taking its signed fill
 * over once the lease runs out. Either way: one `DeliveryOrder_Fill` on the
 * ledger, settled from the attested proof.
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
 *     -f test-command='pnpm install --frozen-lockfile && pnpm --filter @cancore/contracts run build && npx jest --selectProjects int --runInBand packages/trader/test/canton-delivery.stand.int.test.ts'
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
import { cantonFillRef } from '../src/filler/delivery/canton';
import { createFiller, type Filler } from '../src/filler/filler';
import type { EvmRpc } from '../src/filler/rpc';
import type { HttpFetch, WebSocketFactory } from '../src/filler/runtime';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, InMemoryFillerStore } from '../src/filler/testing';
import { attestationsOf, bytes32Hex, createArgumentOf, ledgerEffects, standLedger } from './stand/attestors';
import { activeContracts, cantonToken, env, exercisedAfter, ledger, ledgerEnd, type CreatedEvent } from './stand/canton-ledger';
import { cursor, eventsAfter, ofOrder, STREAMS } from './stand/filler-gateway';
import { standToken } from './stand/keycloak';

const STAND = process.env.INTENT_STAND_ENV;
/** Every key this spec reads (Cancore-io/meta docs/runbooks/intent-stand.md); TRADING_URL or GATEWAY_URL besides. */
const REQUIRED = [
  'CANTON_CHAIN', 'CANTON_PARTICIPANT_UID', 'CANTON_PROOF_WINDOW_S', 'CANTON_TRANSFER_FACTORIES_JSON', 'CNRX_ADMIN_PARTY',
  'EVM_CHAIN_ID', 'EVM_RPC_URL', 'FILLER_GATEWAY_SIGNER', 'FILLER_GATEWAY_WS_URL', 'INPUT_TOKEN_ADDRESS', 'INTENT_ROUTER_ADDRESS',
  'MAKER_EVM_KEY', 'STAND_CANTON_RECIPIENT_PARTY', 'STAND_FILLER_CANTON_PARTY', 'STAND_FILLER_CANTON_PARTY_KEY', 'STAND_FILLER_EVM_KEY',
  'STAND_FILLER_ID', 'STAND_FILLER_MESSAGE_KEY', 'STAND_FILLER_REPAY_TO', 'STAND_USER_CLIENT_ID', 'STAND_USER_CLIENT_SECRET',
  'STAND_USER_NAME', 'STAND_USER_PASSWORD', 'STAND_USER_TOKEN_URL', 'TICKET_SIGNERS', 'PERMIT2_ADDRESS',
  'CANTON_JSON_API_URL', 'CANTON_TOKEN_URL', 'CANTON_CLIENT_ID', 'CANTON_CLIENT_SECRET', 'INTENT_OPERATOR_PARTY_ID',
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

  /**
   * The SDK filler's REST: the stand's own, with one fault on `canton.submit` (TC-SDK-1867-INT-03). The request always
   * reaches Cancore; `lost-answers` loses every answer on the way back, `replica-dies` never returns the first one —
   * the replica that sent it is dead before it could read it. Every `delivery.fill` prepare is recorded by how
   * filler-gateway answered it: the frame type, or the error code.
   */
  type Fault = 'none' | 'lost-answers' | 'replica-dies';
  const fault: { mode: Fault; submitInFlight: boolean } = { mode: 'none', submitInFlight: false };
  const fillPrepares: string[] = [];
  const answerOf = async (response: Response): Promise<string> => {
    const body = (await response.json().catch(() => undefined)) as { type?: string; code?: string } | undefined;
    return body?.type === 'error' ? String(body.code) : (body?.type ?? `HTTP ${response.status}`);
  };
  const throughStand: HttpFetch = async (url, request) => {
    const path = new URL(url).pathname;
    const fillPrepare = path === '/v1/filler/canton/prepare' && (JSON.parse(request.body ?? '{}') as { op?: string }).op === 'delivery.fill';
    const response = await fetch(url, { method: request.method, headers: { ...request.headers }, ...(request.body !== undefined ? { body: request.body } : {}) });
    if (fillPrepare) fillPrepares.push(await answerOf(response.clone()));
    if (path !== '/v1/filler/canton/submit') return response;
    if (fault.mode === 'lost-answers') throw new TypeError('fetch failed: the connection to filler-gateway dropped');
    if (fault.mode === 'replica-dies' && !fault.submitInFlight) {
      fault.submitInFlight = true;
      return new Promise<never>(() => undefined);
    }
    return response;
  };

  /**
   * The stand filler on `store`: a restart is a new one on the same store. `nonceLeaseTtlMs` bounds how long a dead
   * replica's signed fill stays its own before another replica takes it over; `deltaIssueMs` and `webSocket` are the
   * node's own, for a case that holds a frame back.
   */
  const newFiller = ({ delivery, deltaIssueMs = 3_000, webSocket = nativeWebSocket }: { delivery?: { nonceLeaseTtlMs: number }; deltaIssueMs?: number; webSocket?: WebSocketFactory } = {}): Filler => {
    const seed = hexToBytes(env('STAND_FILLER_CANTON_PARTY_KEY').replace(/^0x/, ''));
    const created = createFiller({
      gatewayUrl: env('FILLER_GATEWAY_WS_URL'),
      fillerId: env('STAND_FILLER_ID'),
      gatewaySigner: env('FILLER_GATEWAY_SIGNER') as Hex,
      ticketSigners: env('TICKET_SIGNERS').split(',').map((s) => s.trim() as Hex),
      quoteSigner: createTestTypedDataSigner(env('STAND_FILLER_MESSAGE_KEY') as Hex),
      fillSigners: { [chain]: fillSigner },
      rpc: { [chain]: [rpc] },
      chains: { [chain]: { router, openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: proofWindowSec, sendGuardSec: 10, minGasWei: 0n, fillConfirmations: 1 } },
      tickets: { deltaIssueMs },
      canton: {
        party: env('STAND_FILLER_CANTON_PARTY'),
        partySigner: { publicKey: `0x${bytesToHex(ed25519.getPublicKey(seed))}` as Hex, signHash: async (hash) => `0x${bytesToHex(ed25519.sign(hash, seed))}` as Hex },
        participantUid: env('CANTON_PARTICIPANT_UID'),
        destination: { minTicketTtlSec: 60, requiredProofWindowSec: proofWindowSec, sendGuardSec: 20 },
        registries,
      },
      store,
      webSocket,
      fetch: throughStand,
      logger,
      events,
      settlement: { pullIntervalMs: 5_000 },
      ...(delivery ? { delivery } : {}),
    });
    // The stand filler prices the Canton route only: 5 CNRX for any input, firm a minute past the quote's own
    // life (windowCloseAt + quoteTtlMs): a shorter validUntil is skipped as short-ttl.
    created.onQuoteRequest(async (request) =>
      request.route.dst === env('CANTON_CHAIN')
        ? { amountOut: encodeCantonAmount('5'), validUntil: BigInt(Math.ceil((request.windowCloseAt + request.quoteTtlMs) / 1000) + 60) }
        : null,
    );
    created.onReconfirm(async () => true);
    created.onTicketOffer(async () => 'accept');
    return created;
  };

  beforeAll(async () => {
    // The stand's CNRX admin differs from dev's: its registry, read from the stand ledger, is the filler's
    // FillerConfig.canton.registries; the delivery check holds the transfer to it.
    registries = JSON.parse(env('CANTON_TRANSFER_FACTORIES_JSON')) as Record<string, CantonTransferFactory[]>;
    filler = newFiller();
    await filler.start();
  }, 120_000);

  afterAll(async () => {
    await filler?.stop();
  });

  /** The stand filler's free CNRX on its party. */
  const free = async () => (await filler.canton!.holdings()).filter((h) => !h.locked && h.asset.admin === asset.admin && h.asset.id === asset.id).reduce((sum, h) => sum + encodeCantonAmount(h.amount), 0n);

  /**
   * quote → pick → openFor as a user of Cancore, with the stand filler picked; resolves once the intent is open.
   * `sourceAheadS` opens it on a block that many seconds ahead of the wall clock.
   */
  const openOrder = async (sourceAheadS: number): Promise<{ order: OrderJson; orderHash: Hex; openBlock: bigint }> => {
    const token = env('INPUT_TOKEN_ADDRESS').toLowerCase() as Hex;
    // -- quote → pick → openFor, as a user of Cancore (backend quote.service): only a picked order is ticketed,
    // and the Canton recipient is recorded with the quote (the readiness check and DeliveryBook_Dispatch read it).
    // trading serves /v1/intents/quote with its own JWT guard; the gateway is tried when trading refuses the token.
    const bases = [process.env.TRADING_URL, process.env.GATEWAY_URL].filter((u): u is string => !!u);
    const api = async <T>(path: string, body: unknown): Promise<T> => {
      let last = '';
      for (const base of bases) {
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await standToken('user')}` }, body: JSON.stringify(body) });
        const text = await response.text();
        if (response.ok) return JSON.parse(text) as T;
        last = `${base}${path}: ${response.status} ${text.slice(0, 500)}`;
        if (response.status !== 401 && response.status !== 404) break;
      }
      throw new Error(`POST ${last}\n${diagnostics()}`);
    };
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
    if (sourceAheadS > 0) {
      const latest = BigInt((await rpc.request<{ timestamp: string }>({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
      const ahead = BigInt(Math.floor(Date.now() / 1000) + sourceAheadS);
      await rpc.request({ method: 'evm_setNextBlockTimestamp', params: [Number(ahead > latest ? ahead : latest + 1n)] });
    }
    const nonce = BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [maker.address, 'pending'] }));
    const raw = await maker.signTransaction({ chainId: BigInt(toSign.chainId), nonce, to: router, data, value: 0n, gasLimit: 1_500_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const openTx = await rpc.request<Hex>({ method: 'eth_sendRawTransaction', params: [raw] });
    const openBlock = await waitFor('the open mined', async () => {
      const receipt = await rpc.request<{ status: string; blockNumber: string } | null>({ method: 'eth_getTransactionReceipt', params: [openTx] });
      if (receipt && receipt.status !== '0x1') throw new Error(`openFor reverted\n${diagnostics()}`);
      return receipt ? BigInt(receipt.blockNumber) : undefined;
    }, 60_000, diagnostics);
    await waitFor('the intent opened', async () => ((await reader.intents(orderHash)).status === INTENT_STATUS.Opened ? true : undefined), 60_000, diagnostics);
    return { order, orderHash, openBlock };
  };

  /**
   * quote → pick → openFor → ticket → `DeliveryOrder_Fill` → attestations → settle. `sourceAheadS` opens the
   * order on a block that many seconds ahead of the wall clock — the source chain's clock ahead of the Canton
   * participant's, so the order's `openedAt`, and with it the ticket's `validFrom`, lies in the ledger's future.
   * `fault` breaks the delivery's submit (see `throughStand`): with `lost-answers` the SDK ends the delivery `sent` with
   * the outcome unknown and the node is restarted on the same store; with `replica-dies` the replica is stopped with
   * its signed fill `pending`, and a new replica on the same store takes it over once its lease runs out. Either way
   * no second `DeliveryOrder_Fill` reaches the ledger and the order settles from the attested proof.
   */
  const deliverAndSettle = async (sourceAheadS: number, { fault: mode = 'none' as Fault } = {}) => {
    fault.mode = mode;
    fault.submitInFlight = false;
    if (mode === 'replica-dies') {
      await filler.stop();
      filler = newFiller({ delivery: SHORT_LEASE });
      await filler.start();
    }
    const preparesFrom = fillPrepares.length;
    const ledgerFrom = await ledgerEnd(await cantonToken());
    const token = env('INPUT_TOKEN_ADDRESS').toLowerCase() as Hex;
    // Both balances are read before the open reaches the chain: from then on the filler may deliver at any moment.
    // The payee: the filler's EVM key on the source, padded into repayTo (the stand gives either form).
    const payee = fillSigner.address.toLowerCase() as Hex;
    const standRepayTo = env('STAND_FILLER_REPAY_TO').toLowerCase();
    expect(standRepayTo.length === 66 ? `0x${standRepayTo.slice(26)}` : standRepayTo).toBe(payee);
    const balanceOf = async (owner: Hex) => BigInt(await client.call(token, encodeFunctionCall(entryOf(abi(IBURN_MINT_ERC20_ABI), 'function', 'balanceOf'), [owner])));
    const payeeBefore = await balanceOf(payee);
    const cnrxBefore = await free();
    const recipient = env('STAND_CANTON_RECIPIENT_PARTY');
    const registry = (registries[asset.admin] ?? [])[0];
    if (!registry) throw new Error(`CANTON_TRANSFER_FACTORIES_JSON has no registry of ${asset.admin}`);
    const recipientBefore = await ledgerHoldings(recipient, asset, registry);

    const { order, orderHash, openBlock } = await openOrder(sourceAheadS);

    // -- ticket, receipt, delivery on Canton ----------------------------------------------------
    const takeover = mode === 'replica-dies' ? await replicaDiesMidDelivery(orderHash) : undefined;
    const ended = mode === 'none' ? 'confirmed' : 'sent';
    const fill = await waitFor(
      `the Canton delivery ${ended} (ticket → receipt → delivery.fill)`,
      async () => {
        const f = await store.withOrder(orderHash, async (tx) => {
          for (const t of await tx.listTickets()) {
            const r = await tx.getFill(t.attempt);
            if (r?.state === ended) return r;
          }
          return undefined;
        });
        return f;
      },
      8 * 60_000,
      diagnostics,
    );
    expect(fill).toMatchObject({ chain: env('CANTON_CHAIN'), state: ended });
    // Exactly the quoted amount: the order's minReceived, the filler's offer.
    expect(fill.amount).toBe(order.minReceived);
    // One prepare was answered `canton.prepared`; a repeat — the retry after a lost answer, the takeover of a dead
    // replica's fill — meets the delivery already committed and is refused TICKET_CLOSED.
    const answers = fillPrepares.slice(preparesFrom);
    expect(answers[0]).toBe('canton.prepared');
    expect(answers.slice(1).filter((a) => a !== 'TICKET_CLOSED')).toEqual([]);
    if (mode === 'none') expect(answers).toHaveLength(1);
    if (takeover) expect(fillPrepares.slice(takeover.preparesFrom)).toEqual(expect.arrayContaining(['TICKET_CLOSED']));
    if (mode === 'lost-answers') {
      // The node dies and comes back on the same store, answers flowing again: it settles what it delivered once.
      fault.mode = 'none';
      await filler.stop();
      filler = newFiller();
      await filler.start();
    }
    const preparesBeforeSettle = fillPrepares.length;
    // The party paid it out of its own free CNRX, and the recipient's ledger holdings grew by exactly it — once.
    expect(cnrxBefore - (await free())).toBe(BigInt(fill.amount));
    expect((await ledgerHoldings(recipient, asset, registry)) - recipientBefore).toBe(BigInt(fill.amount));

    // One delivery: one fill recorded over every attempt, one `filled`; and it came after the escrow was open at depth.
    const fills = await store.withOrder(orderHash, async (tx) => (await Promise.all((await tx.listTickets()).map((t) => tx.getFill(t.attempt)))).filter((f) => f && f.state !== 'failed'));
    expect(fills).toHaveLength(1);
    const ofOrder = events.events.filter((e) => 'orderHash' in e && e.orderHash === orderHash);
    const at = (stage: string, detail?: Record<string, unknown>) =>
      ofOrder.findIndex((e) => e.type === 'stage' && e.stage === stage && (!detail || Object.entries(detail).every(([k, v]) => (e.detail as Record<string, unknown>)[k] === v)));
    const escrowOpen = at('ticket.checked', { check: 'V-E2', status: 'passed' });
    const delivered = at('fill.sent');
    expect(escrowOpen).toBeGreaterThanOrEqual(0);
    expect(delivered).toBeGreaterThan(escrowOpen);
    if (mode === 'none') {
      expect(fill.txRef).not.toBe('');
      expect(ofOrder.filter((e) => e.type === 'filled')).toHaveLength(1);
    } else {
      // Ended by the outcome unknown, not by a commit without its update id: no fill reference, no `filled`.
      expect(fill.txRef).toBe('');
      expect(ofOrder.filter((e) => e.type === 'filled')).toHaveLength(0);
      expect(at('fill.sent', { outcome: 'unknown' })).toBeGreaterThan(escrowOpen);
    }
    // The replica that took over ended it: its `fill.sent` came after the dead one stopped.
    if (takeover) expect(events.events.indexOf(ofOrder[at('fill.sent', { outcome: 'unknown' })]!)).toBeGreaterThanOrEqual(takeover.eventsFrom);

    // -- attested and settled on the router -----------------------------------------------------
    await waitFor('the intent settled on the router (attestations → selfSettle)', async () => ((await reader.intents(orderHash)).status === INTENT_STATUS.Settled ? true : undefined), 10 * 60_000, diagnostics);
    // Nothing was prepared again once the delivery had ended.
    expect(fillPrepares.length).toBe(preparesBeforeSettle);
    // On the ledger itself: the party exercised DeliveryOrder_Fill once over every DeliveryOrder of this order.
    const deliveryOrders = await store.withOrder(orderHash, async (tx) => (await tx.listTickets()).map((t) => (t.issued as { deliveryOrderCid?: string } | undefined)?.deliveryOrderCid));
    const fillsOnLedger = (await exercisedAfter(env('STAND_FILLER_CANTON_PARTY'), ledgerFrom, await cantonToken())).filter((e) => e.choice === 'DeliveryOrder_Fill' && deliveryOrders.includes(e.contractId));
    expect(fillsOnLedger).toHaveLength(1);
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
    const ticket = await store.withOrder(orderHash, async (tx) => (await tx.listTickets()).find((t) => t.attempt === fill.attempt));
    return { orderHash, fill, ticket, openedAt: (await reader.intents(orderHash)).openedAt };
  };

  /** A replica's signed fill is someone else's this long after it dies. */
  const SHORT_LEASE = { nonceLeaseTtlMs: 15_000 };

  /**
   * The replica dies once it has signed the delivery and its submit reached Cancore, before the answer: its fill stays
   * `pending`, signed, under its lease. A new replica starts on the same store.
   */
  const replicaDiesMidDelivery = async (orderHash: Hex) => {
    await waitFor(
      'the delivery signed with its submit in flight',
      async () => {
        if (!fault.submitInFlight) return undefined;
        return store.withOrder(orderHash, async (tx) => {
          for (const t of await tx.listTickets()) {
            const f = await tx.getFill(t.attempt);
            if (f?.state === 'pending' && f.sentAtMs !== undefined) return true;
          }
          return undefined;
        });
      },
      8 * 60_000,
      diagnostics,
    );
    // Its stop never waits for the submit it will not see answered; nothing of it writes to the store again.
    await Promise.race([filler.stop(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    const takeover = { preparesFrom: fillPrepares.length, eventsFrom: events.events.length };
    fault.mode = 'none';
    filler = newFiller({ delivery: SHORT_LEASE });
    await filler.start();
    return takeover;
  };

  let delivered: { orderHash: Hex; from: string } | undefined;

  test('TC-CAN-1867-STAND-01: an order to canton:devnet is delivered by the filler’s party and settled on the router: repayTo paid, the party’s CNRX spent', async () => {
    const from = await cursor(STREAMS.ticketEvents);
    const { orderHash } = await deliverAndSettle(0);
    delivered = { orderHash, from };
  }, 20 * 60_000);

  test('TC-ATT-2146-03 (CAN-2146): every attestor signs the Canton delivery of TC-CAN-1867-STAND-01 with fillerId = keccak256(utf8(stand filler id)) and the repayTo of its DeliveryReceipt and DeliveryOrder on the ledger', async () => {
    if (!delivered) throw new Error('TC-CAN-1867-STAND-01 delivered nothing');
    const { orderHash } = delivered;
    const fillUpdateId = await store.withOrder(orderHash, async (tx) => {
      for (const t of await tx.listTickets()) {
        const f = await tx.getFill(t.attempt);
        if (f?.state === 'confirmed' && f.txRef) return f.txRef;
      }
      return undefined;
    });
    if (!fillUpdateId) throw new Error(`no confirmed Canton fill of ${orderHash} with its update id`);
    // The operator signs both the DeliveryOrder and the DeliveryReceipt, so it sees them (canton-contracts Intent.DeliveryReceipt).
    const operator = env('INTENT_OPERATOR_PARTY_ID');
    const effects = await ledgerEffects(standLedger, fillUpdateId, operator);
    const fillExercise = effects.find((e) => e.ExercisedEvent?.choice === 'DeliveryOrder_Fill')?.ExercisedEvent;
    const receipt = effects.find((e) => e.CreatedEvent?.templateId.endsWith(':Intent.DeliveryReceipt:DeliveryReceipt'))?.CreatedEvent?.createArgument;
    if (!fillExercise || !receipt) throw new Error(`update ${fillUpdateId} holds no DeliveryOrder_Fill with its DeliveryReceipt`);
    const deliveryOrder = await createArgumentOf(standLedger, fillExercise.contractId, operator);
    expect([bytes32Hex(receipt.orderHash), bytes32Hex(deliveryOrder.orderHash)]).toEqual([orderHash, orderHash]);
    expect([receipt.fillerId, deliveryOrder.fillerId]).toEqual([env('STAND_FILLER_ID'), env('STAND_FILLER_ID')]);
    const repayTo = bytes32Hex(receipt.repayTo);
    expect(bytes32Hex(deliveryOrder.repayTo)).toBe(repayTo);

    const fillerId = fillerIdHash(env('STAND_FILLER_ID')).toLowerCase();
    const attestations = await attestationsOf(env('EVM_CHAIN_ID'), orderHash);
    const fillRef = cantonFillRef(fillUpdateId).toLowerCase();
    expect(attestations.map(({ attestor, proof }) => ({ attestor, orderHash: proof.orderHash.toLowerCase(), fillRef: proof.fillRef.toLowerCase(), fillerId: proof.fillerId.toLowerCase(), repayTo: proof.repayTo.toLowerCase() }))).toEqual(
      attestations.map(({ attestor }) => ({ attestor, orderHash, fillRef, fillerId, repayTo })),
    );
  }, 5 * 60_000);

  // CAN-1861, CAN-2151: what filler-gateway recorded of that delivery's ticket, on the stream trading reads.
  test('TC-SDK-1861-INT-01 TC-SDK-2151-INT-01: the ticket of TC-CAN-1867-STAND-01 went offer → intent → issued → receipt at filler-gateway; the sealed receipt was taken, nothing declined or refused', async () => {
    if (!delivered) throw new Error('TC-CAN-1867-STAND-01 delivered nothing');
    const kinds = (await eventsAfter(STREAMS.ticketEvents, delivered.from, ofOrder(delivered.orderHash))).map((e) => e.kind);
    const at = (kind: string) => kinds.indexOf(kind);
    expect(at('ticket.offered')).toBeGreaterThanOrEqual(0);
    expect(at('ticket.intent')).toBeGreaterThan(at('ticket.offered'));
    expect(at('ticket.issued')).toBeGreaterThan(at('ticket.intent'));
    expect(at('ticket.receipt')).toBeGreaterThan(at('ticket.issued'));
    expect(kinds.filter((k) => k === 'ticket.receipt')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'ticket.declined' || k.endsWith('.refused'))).toEqual([]);
  }, 60_000);

  // The finding of CAN-3026 end to end: the source block opens the order 15 s ahead of the participant's clock. The
  // ticket's validFrom is that openedAt, the node waits for it, DeliveryOrder_Fill lands at or after it, and the
  // router — which refuses filledAt < openedAt (FilledBeforeOpen) — settles the delivery.
  test('TC-CAN-3026-STAND-01: with the source chain 15 s ahead, the filler fills no earlier than validFrom = openedAt and the router settles it', async () => {
    const { fill, ticket, openedAt } = await deliverAndSettle(15);
    const issued = ticket?.issued as { validFrom?: string } | undefined;
    const validFrom = BigInt(issued?.validFrom ?? (ticket?.offer as { validFrom: string } | undefined)?.validFrom ?? '0');
    expect(validFrom).toBeGreaterThanOrEqual(openedAt);
    expect(BigInt(fill.sentAtMs ?? 0)).toBeGreaterThanOrEqual(openedAt * 1000n);
  }, 20 * 60_000);

  test('TC-SDK-1867-INT-03: every answer to the delivery submit is lost and the node restarts — one DeliveryOrder_Fill on the ledger, the recipient credited once, the delivery not failed, settled on the router', async () => {
    await deliverAndSettle(0, { fault: 'lost-answers' });
  }, 20 * 60_000);

  test('TC-SDK-1867-INT-03: the replica dies with the delivery submit in flight — another replica takes the signed fill over after its lease, one DeliveryOrder_Fill on the ledger, the recipient credited once, settled on the router', async () => {
    await deliverAndSettle(0, { fault: 'replica-dies' });
  }, 20 * 60_000);

  /** The recipient's CNRX transfer preapprovals: the one contract a Canton recipient needs to take a delivery. */
  const PREAPPROVAL = '#cnrx-registry:Cnrx.Transfer:CnrxTransferPreapproval';
  const recipientPreapprovals = async (recipient: string): Promise<CreatedEvent[]> =>
    (await activeContracts(recipient, { TemplateFilter: { value: { templateId: PREAPPROVAL, includeCreatedEventBlob: false } } }, await cantonToken())).filter(
      (c) => c.createArgument?.receiver === recipient && c.createArgument?.admin === asset.admin,
    );
  let ledgerCommands = 0;
  /** A command of the custodial stand recipient, as the stand provisions it: its own signatory acts. */
  const asRecipient = async (recipient: string, command: Record<string, unknown>): Promise<void> => {
    await ledger('/v2/commands/submit-and-wait', await cantonToken(), { commands: [command], commandId: `can-1867-int-04-${Date.now()}-${ledgerCommands++}`, actAs: [recipient], readAs: [] });
  };

  test('TC-SDK-1867-INT-04: the recipient revokes its preapproval after the ticket is issued — V-R1 declines RECIPIENT_NOT_READY, no DeliveryOrder_Fill, the party’s CNRX untouched', async () => {
    const recipient = env('STAND_CANTON_RECIPIENT_PARTY');
    const live = await recipientPreapprovals(recipient);
    expect(live.length).toBeGreaterThan(0);
    // trading checks the recipient before it issues the ticket, so the revocation must come between the issue and
    // the node's checks: the node's socket holds the Canton-form ticket.issued until the recipient has archived every
    // preapproval. The node allows the hold in δ_issue; the frame stays fresh (maxMessageAgeMs).
    const revokeOnIssue: WebSocketFactory = (url, h, protocols) =>
      nativeWebSocket(url, {
        ...h,
        onMessage: (text) => {
          const frame = JSON.parse(text) as { type?: string; form?: string };
          if (frame.type !== 'ticket.issued' || frame.form !== 'canton') return h.onMessage(text);
          void Promise.all(live.map((c) => asRecipient(recipient, { ExerciseCommand: { templateId: PREAPPROVAL, contractId: c.contractId, choice: 'Archive', choiceArgument: {} } }))).then(
            () => h.onMessage(text),
            (error: unknown) => logger.error('the recipient could not revoke its preapproval', { error: String(error) }),
          );
        },
      }, protocols);
    await filler.stop();
    filler = newFiller({ deltaIssueMs: 60_000, webSocket: revokeOnIssue });
    await filler.start();
    const preparesFrom = fillPrepares.length;
    const cnrxBefore = await free();
    try {
      const { orderHash } = await openOrder(0);
      const declined = await waitFor('the ticket declined', async () => {
        const t = await store.withOrder(orderHash, async (tx) => (await tx.listTickets())[0]);
        return t?.state === 'declined' ? t : undefined;
      }, 5 * 60_000, diagnostics);
      expect(declined.decline).toMatchObject({ reason: 'RECIPIENT_NOT_READY' });
      const vR1 = events.events.find((e) => e.type === 'stage' && e.stage === 'ticket.checked' && 'orderHash' in e && e.orderHash === orderHash && (e.detail as Record<string, unknown>).check === 'V-R1');
      expect(vR1 && 'detail' in vR1 ? vR1.detail : undefined).toMatchObject({ status: 'failed', reason: 'RECIPIENT_NOT_READY' });
      expect(await recipientPreapprovals(recipient)).toEqual([]);
      expect(fillPrepares.slice(preparesFrom)).toEqual([]);
      expect(await free()).toBe(cnrxBefore);
    } finally {
      // The stand is shared: the recipient takes deliveries again, as provisioned.
      if ((await recipientPreapprovals(recipient)).length === 0) {
        for (const c of live) await asRecipient(recipient, { CreateCommand: { templateId: PREAPPROVAL, createArguments: c.createArgument } });
      }
      await filler.stop();
      filler = newFiller();
      await filler.start();
    }
  }, 10 * 60_000);
});
