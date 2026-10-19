/**
 * Canton → EVM end to end on the shared intent stand (operator decision Н-1,
 * meta docs/runbooks/intent-stand.md): CAN-1863 (V-C1…V-C6 before the
 * receipt) and CAN-2321 (the payout by SwapIntent_SettleWithProof). Every
 * component is the stand's own — Canton participant with cancore-intent and
 * cnrx-registry, trading and filler-gateway (decision T-1: the party's
 * operations go through Cancore), the attestor daemons, anvil with the
 * deployed CancoreRouter. Nothing is faked.
 *
 * 1. A filler on the stand's filler id logs in with its Canton party.
 * 2. The test opens a Canton-source intent naming that filler, as the
 *    custodial owner over the JSON Ledger API (IntentFactory_Open, the give
 *    committed to the filler).
 * 3. trading tickets it to the picked filler (CAN-2326); the SDK runs V-C1…V-C6
 *    against GET /v1/filler/canton/intents/{orderHash}, receipts, fills on anvil.
 * 4. The attestors sign, filler-gateway delivers settle.attestations, the SDK
 *    runs intent.settle: checks the prepared SwapIntent_SettleWithProof, signs
 *    it with the party key, trading submits.
 * 5. The intent is gone, the party holds the payout.
 *
 *   CANCORE_INTENT_STAND_ENV=<out>/intent-stand.env npx jest --selectProjects int --runInBand packages/trader/test/canton-source.int.test.ts
 *
 * Skipped, with the cause named, without the stand's env file. Every key in it
 * is a stand-only test value.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildCantonSourceOrder, cantonInclusiveFeeSplit, repayToFromParty, type CantonParty, type Hex } from '@cancore/contracts';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { createCantonOperations, type CantonPartySigner } from '../src/filler/canton/operations';
import { registriesProblem, type CantonTransferFactory } from '../src/filler/canton/factories';
import { scaled } from '../src/filler/canton/checks';
import { createFiller, type Filler } from '../src/filler/filler';
import type { StageEvent } from '../src/filler/events';
import type { EvmRpc } from '../src/filler/rpc';
import type { WebSocketFactory } from '../src/filler/runtime';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, InMemoryFillerStore } from '../src/filler/testing';
import { checkCantonSource } from '../src/filler/tickets/canton-source';
import { TicketRefusal } from '../src/filler/tickets/refusal';

const ENV_FILE = process.env.CANCORE_INTENT_STAND_ENV ?? process.env.INTENT_STAND_ENV;
const KEYS = [
  'FILLER_GATEWAY_URL', 'FILLER_GATEWAY_SIGNER', 'TICKET_SIGNERS', 'EVM_RPC_URL', 'INTENT_ROUTER_ADDRESS',
  'CANTON_JSON_API_URL', 'CANTON_TOKEN_URL', 'CANTON_CLIENT_ID', 'CANTON_CLIENT_SECRET', 'CANTON_PARTICIPANT_UID', 'CANTON_ORIGIN_ID',
  'CNRX_ADMIN_PARTY', 'CANTON_TRANSFER_FACTORIES_JSON',
  'STAND_FILLER_ID', 'STAND_FILLER_MESSAGE_KEY', 'STAND_FILLER_EVM_KEY', 'STAND_FILLER_CANTON_PARTY', 'STAND_FILLER_CANTON_PARTY_KEY', 'STAND_FILLER_REGISTRY_ENTRY_CID',
  'STAND_OWNER_PARTY', 'STAND_ROUTE_OUTPUT_TOKEN', 'STAND_ROUTE_OUTPUT_DECIMALS', 'STAND_INTENT_FACTORY_CID',
  'INTENT_OPERATOR_PARTY_ID', 'INTENT_BOOK_GUARDIAN_PARTY', 'INTENT_ATTESTOR_GOVERNOR_PARTY', 'INTENT_ATTESTOR_REGISTRY_CID', 'INTENT_ATTESTOR_SET_COMMITMENT',
] as const;
type StandKey = (typeof KEYS)[number];

function readStand(): { env: Record<StandKey, string> } | { skip: string } {
  if (!ENV_FILE) return { skip: 'CANCORE_INTENT_STAND_ENV is not set: no intent stand (decision Н-1, the intent-stand job)' };
  const file: Record<string, string> = Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]),
  );
  const value = (k: string) => process.env[k] ?? file[k];
  const missing = KEYS.filter((k) => !value(k));
  if (missing.length > 0) return { skip: `${ENV_FILE} lacks ${missing.join(', ')}` };
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') return { skip: 'no global WebSocket (Node ≥ 22)' };
  return { env: Object.fromEntries(KEYS.map((k) => [k, value(k) as string])) as Record<StandKey, string> };
}

const stand = readStand();
if ('skip' in stand) console.warn(`canton-source.int.test.ts skipped: ${stand.skip}`);
const live = 'env' in stand ? describe : describe.skip;
const E = ('env' in stand ? stand.env : {}) as Record<StandKey, string>;

const INTENT = '#cancore-intent:Intent.SwapIntent';
const BOOK_ROOT = '#cancore-intent:Intent.BookRoot:BookRoot';
const FILL_ROOT = '#cancore-intent:Intent.BookRoot:FillRoot';
const CNRX = '#cnrx-registry:Cnrx';
const BURN_MINT = '#splice-api-token-burn-mint-v1:Splice.Api.Token.BurnMintV1:BurnMintFactory';
const NO_ARGS = { context: { values: {} }, meta: { values: {} } };
// SwapIntent validTerms: refundAfter − fillDeadline ∈ [30 min, 4 h].
const MIN_PROOF_WINDOW_S = 30 * 60;
const GIVE = '10.0';

// -- The JSON Ledger API v2 of the stand participant ----------------------------------------

let token: { value: string; until: number } | undefined;
async function bearer(): Promise<string> {
  if (token && Date.now() < token.until) return token.value;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: E.CANTON_CLIENT_ID, client_secret: E.CANTON_CLIENT_SECRET, scope: 'openid' });
  const res = await fetch(E.CANTON_TOKEN_URL, { method: 'POST', body });
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  token = { value: json.access_token, until: Date.now() + Math.max(0, (json.expires_in ?? 90) - 30) * 1000 };
  return token.value;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${E.CANTON_JSON_API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface Created {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
}

async function active(party: string, templateId: string, pred: (a: Record<string, unknown>) => boolean = () => true): Promise<Created[]> {
  const { offset } = await api<{ offset: number }>('/v2/state/ledger-end');
  const res = await api<unknown>('/v2/state/active-contracts', {
    filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } } }] } } },
    verbose: false,
    activeAtOffset: offset,
  });
  return (Array.isArray(res) ? res : [res])
    .map((r) => (r as { contractEntry?: { JsActiveContract?: { createdEvent?: Created } } })?.contractEntry?.JsActiveContract?.createdEvent)
    .filter((c): c is Created => c !== undefined && pred(c.createArgument));
}

let commands = 0;
async function submit(actAs: string[], command: Record<string, unknown>, readAs: string[] = []): Promise<Created[]> {
  const res = await api<{ transactionTree?: { eventsById?: Record<string, unknown> } }>('/v2/commands/submit-and-wait-for-transaction-tree', {
    commands: [command],
    commandId: `can-1863-${Date.now()}-${commands++}`,
    actAs,
    readAs,
  });
  return Object.values(res.transactionTree?.eventsById ?? {})
    .map((e) => (e as { CreatedTreeEvent?: { value?: Created } }).CreatedTreeEvent?.value)
    .filter((c): c is Created => c !== undefined);
}
const exercise = (templateId: string, contractId: string, choice: string, choiceArgument: unknown) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
const createdOf = (events: Created[], suffix: string) => events.find((c) => c.templateId.endsWith(suffix))?.contractId;
const hexOf = (v: unknown) => `0x${String(typeof v === 'string' ? v : (v as { hex?: string })?.hex ?? '').replace(/^0x/, '')}`.toLowerCase();
const ledgerHex = (h: string) => ({ hex: h.replace(/^0x/, '').toLowerCase() });
const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** CNRX the registrar mints to the owner, free: the give the open commits. */
async function mintGive(owner: string, amount: string): Promise<string[]> {
  const admin = E.CNRX_ADMIN_PARTY;
  const [rules] = await active(admin, `${CNRX}.Rules:CnrxRules`, (a) => a.admin === admin);
  const [supply] = await active(admin, `${CNRX}.Supply:CnrxSupply`, (a) => (a.instrumentId as { admin: string }).admin === admin);
  if (!rules || !supply) throw new Error('the stand has no CnrxRules / CnrxSupply of the registrar');
  const events = await submit([admin, owner], exercise(BURN_MINT, rules.contractId, 'BurnMintFactory_BurnMint', {
    expectedAdmin: admin,
    instrumentId: { admin, id: 'CNRX' },
    inputHoldingCids: [],
    outputs: [{ owner, amount, context: { values: {} } }],
    extraActors: [owner],
    extraArgs: { context: { values: { 'cnrx/supply': { tag: 'AV_ContractId', value: supply.contractId } } }, meta: { values: {} } },
  }));
  return events.filter((c) => c.templateId.endsWith(':CnrxHolding')).map((c) => c.contractId);
}

/** The operator's book of a shard, opened out of its root when there is none (as the stand's own cases do). */
async function bookOf(kind: 'IntentBook' | 'FillBook', shard: string): Promise<string> {
  const operator = E.INTENT_OPERATOR_PARTY_ID;
  const [book] = await active(operator, `${INTENT}:${kind}`, (a) => a.operator === operator && a.shard === shard && (kind === 'IntentBook' || a.governor === E.INTENT_ATTESTOR_GOVERNOR_PARTY));
  if (book) return book.contractId;
  const [root] = kind === 'IntentBook' ? await active(operator, BOOK_ROOT, (a) => a.operator === operator) : await active(operator, FILL_ROOT, (a) => a.operator === operator && a.governor === E.INTENT_ATTESTOR_GOVERNOR_PARTY);
  if (!root) throw new Error(`no ${kind === 'IntentBook' ? 'BookRoot' : 'FillRoot'} of the operator on the stand`);
  const events = await submit([operator], exercise(kind === 'IntentBook' ? BOOK_ROOT : FILL_ROOT, root.contractId, kind === 'IntentBook' ? 'BookRoot_OpenIntentBook' : 'FillRoot_OpenFillBook', { shard }));
  const cid = createdOf(events, `:${kind}`);
  if (!cid) throw new Error(`opening the ${kind} of shard ${shard} created none`);
  return cid;
}

/** IntentFactory_Open by the custodial owner: the give committed to the stand filler, the intent created. */
async function openIntent(deadlines: { fillDeadline: number; refundAfter: number }) {
  const owner = E.STAND_OWNER_PARTY;
  const [factory] = await active(E.INTENT_OPERATOR_PARTY_ID, `${INTENT}:IntentFactory`, () => true).then((all) => all.filter((f) => f.contractId === E.STAND_INTENT_FACTORY_CID));
  if (!factory) throw new Error('STAND_INTENT_FACTORY_CID is not a live IntentFactory of the operator');
  const minFee = Number(factory.createArgument.minFeeRate ?? 0);
  const feeRate = minFee > 0.003 ? String(minFee) : '0.003';
  const nowS = Math.floor(Date.now() / 1000);
  const requestId = `qr_${randomUUID()}`;
  const decimals = Number(E.STAND_ROUTE_OUTPUT_DECIMALS);
  const minUnits = 10n ** BigInt(decimals); // one whole output token
  const recipient = `0x${'b0'.repeat(20)}`;
  const built = buildCantonSourceOrder({
    ownerPartyId: owner, requestId, instrumentAdmin: E.CNRX_ADMIN_PARTY, instrumentId: 'CNRX', amount: GIVE, destinationChainId: '11155111',
    wantToken: E.STAND_ROUTE_OUTPUT_TOKEN, wantDecimals: 0, minReceived: minUnits.toString(), recipient,
    createdAt: nowS - 5, fillDeadline: deadlines.fillDeadline, feeRate, cantonOriginId: E.CANTON_ORIGIN_ID, fillerId: E.STAND_FILLER_ID,
  });
  const shard = built.orderHash.slice(2, 3);
  const [holdings, intentBookCid] = await Promise.all([mintGive(owner, GIVE), bookOf('IntentBook', shard)]);
  // settle needs the operator's FillBook of the shard: open it now, not in the middle of the payout.
  await bookOf('FillBook', shard);
  const fields = {
    owner, requestId, orderHash: ledgerHex(built.orderHash), amount: GIVE,
    destination: { tag: 'Evm', value: { chainId: '11155111', token: ledgerHex(E.STAND_ROUTE_OUTPUT_TOKEN), recipient: ledgerHex(recipient) } },
    minReceived: { units: minUnits.toString(), decimals: String(decimals) },
    feeRate, fillDeadline: iso(deadlines.fillDeadline), refundAfter: iso(deadlines.refundAfter), orderCreatedAt: iso(nowS - 5),
    filler: E.STAND_FILLER_CANTON_PARTY, fillerId: E.STAND_FILLER_ID,
    bookGuardian: E.INTENT_BOOK_GUARDIAN_PARTY, attestorGovernor: E.INTENT_ATTESTOR_GOVERNOR_PARTY, attestorSetId: '1',
    attestorSetCommitment: ledgerHex(E.INTENT_ATTESTOR_SET_COMMITMENT),
    inputHoldingCids: holdings, allocExtraArgs: NO_ARGS,
    fillerEntryCid: E.STAND_FILLER_REGISTRY_ENTRY_CID, intentBookCid, attestorRegistryCid: E.INTENT_ATTESTOR_REGISTRY_CID,
  };
  const events = await submit([owner], exercise(`${INTENT}:IntentFactory`, factory.contractId, 'IntentFactory_Open', fields), [E.INTENT_OPERATOR_PARTY_ID, E.CNRX_ADMIN_PARTY, E.INTENT_ATTESTOR_GOVERNOR_PARTY]);
  const intentCid = createdOf(events, ':SwapIntent');
  if (!intentCid) throw new Error('IntentFactory_Open created no SwapIntent');
  return { orderHash: built.orderHash.toLowerCase() as Hex, order: built.order, intentCid, feeBps: BigInt(built.order.feeBps as string) };
}

/** The party's free CNRX, in Numeric-10 units. */
async function freeCnrx(party: string): Promise<bigint> {
  const holdings = await active(party, `${CNRX}.Holding:CnrxHolding`);
  let total = 0n;
  for (const h of holdings) {
    const view = (h.createArgument.holding ?? h.createArgument) as { account?: { owner?: string }; owner?: string; amount: string; lock?: unknown };
    const owner = view.account?.owner ?? view.owner;
    if (owner === party && (view.lock === null || view.lock === undefined)) total += scaled(String(view.amount));
  }
  return total;
}

// -- The filler ---------------------------------------------------------------------------

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

const globalWebSocket: WebSocketFactory = (url, h, protocols) => {
  const Ws = (globalThis as unknown as { WebSocket: new (url: string, protocols: string[]) => { onopen: () => void; onmessage: (e: { data: unknown }) => void; onclose: (e: { code: number; reason: string }) => void; onerror: (e: unknown) => void; send(t: string): void; close(c?: number, r?: string): void } }).WebSocket;
  const ws = new Ws(url, [...protocols]);
  ws.onopen = () => h.onOpen();
  ws.onmessage = (e) => typeof e.data === 'string' && h.onMessage(e.data);
  ws.onclose = (e) => h.onClose(e.code, e.reason);
  ws.onerror = (e) => h.onError(e);
  return { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
};

function partySigner(seedHex: string): CantonPartySigner {
  const seed = hexToBytes(seedHex.replace(/^0x/, ''));
  return { publicKey: `0x${bytesToHex(ed25519.getPublicKey(seed))}` as Hex, signHash: async (hash) => `0x${bytesToHex(ed25519.sign(hash, seed))}` as Hex };
}

function registries(): Record<string, CantonTransferFactory[]> {
  const parsed = JSON.parse(E.CANTON_TRANSFER_FACTORIES_JSON) as Record<string, CantonTransferFactory[]>;
  const problem = registriesProblem(parsed);
  if (problem) throw new Error(`CANTON_TRANSFER_FACTORIES_JSON${problem}`);
  return parsed;
}

const until = async <T>(what: string, read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> => {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out: ${what}${last ? ` (last error: ${String(last)})` : ''}`);
};

live('Canton → EVM on the intent stand: V-C1…V-C6 (CAN-1863) and SwapIntent_SettleWithProof (CAN-2321)', () => {
  jest.setTimeout(20 * 60_000);
  const DST = 'eip155:11155111' as const;
  // Built on first use: a skipped suite still runs this body, without the stand's keys.
  let party: CantonPartySigner | undefined;
  const signerOf = () => (party ??= partySigner(E.STAND_FILLER_CANTON_PARTY_KEY));
  const store = new InMemoryFillerStore();
  const events = createRecordingEventSink();
  const logger = createRecordingLogger();
  let filler: Filler;

  beforeAll(async () => {
    const policy = { router: E.INTENT_ROUTER_ADDRESS as Hex, openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: MIN_PROOF_WINDOW_S, sendGuardSec: 10, minGasWei: 10n ** 15n };
    filler = createFiller({
      gatewayUrl: E.FILLER_GATEWAY_URL,
      fillerId: E.STAND_FILLER_ID,
      gatewaySigner: E.FILLER_GATEWAY_SIGNER as Hex,
      ticketSigners: E.TICKET_SIGNERS.split(',').map((s) => s.trim() as Hex),
      quoteSigner: createTestTypedDataSigner(E.STAND_FILLER_MESSAGE_KEY as Hex),
      fillSigners: { [DST]: createTestFillSigner(E.STAND_FILLER_EVM_KEY as Hex) },
      rpc: { [DST]: [httpRpc(E.EVM_RPC_URL)] },
      chains: { [DST]: policy },
      tickets: { deltaIssueMs: 3_000 },
      canton: {
        party: E.STAND_FILLER_CANTON_PARTY,
        partySigner: signerOf(),
        participantUid: E.CANTON_PARTICIPANT_UID,
        destination: { minTicketTtlSec: 60, requiredProofWindowSec: MIN_PROOF_WINDOW_S, sendGuardSec: 10 },
        registries: registries(),
      },
      store,
      events,
      logger,
      webSocket: globalWebSocket,
    });
    filler.onQuoteRequest(async () => null);
    filler.onReconfirm(async () => false);
    filler.onTicketOffer(async () => 'accept');
    await filler.start();
  });

  afterAll(async () => {
    await filler?.stop();
  });

  const checked = (orderHash: string) =>
    events.events.filter((e): e is StageEvent => e.type === 'stage' && e.stage === 'ticket.checked' && String(e.orderHash).toLowerCase() === orderHash);

  test('CAN-1863: the reads V-C1…V-C6 take are the stand participant’s, and refuse what is not committed to this filler', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const opened = await openIntent({ fillDeadline: nowS + 600, refundAfter: nowS + 600 + MIN_PROOF_WINDOW_S + 60 });
    const ops = createCantonOperations({
      gatewayUrl: E.FILLER_GATEWAY_URL, fillerId: E.STAND_FILLER_ID, gatewaySigner: E.FILLER_GATEWAY_SIGNER as Hex,
      messageSigner: createTestTypedDataSigner(E.STAND_FILLER_MESSAGE_KEY as Hex), partySigner: signerOf(), participantUid: E.CANTON_PARTICIPANT_UID, registries: registries(),
    });
    const ticket = { orderHash: opened.orderHash, repayTo: repayToFromParty(E.STAND_FILLER_CANTON_PARTY) };
    const passed: string[] = [];
    const run = (order: typeof opened.order, orderHash = opened.orderHash) =>
      checkCantonSource(
        { order: order as never, ticket: { ...ticket, orderHash } as never, party: E.STAND_FILLER_CANTON_PARTY, fillerId: E.STAND_FILLER_ID, requiredProofWindowSec: MIN_PROOF_WINDOW_S, reader: ops },
        (check) => void passed.push(check),
      );
    // The live intent, as the participant holds it, passes every check.
    await run(opened.order);
    expect(passed).toEqual(['V-C1', 'V-C2', 'V-C3', 'V-C4', 'V-C5', 'V-C6']);
    // An offer that differs from the committed terms by one base unit: V-C2.
    await expect(run({ ...opened.order, minReceived: String(BigInt(opened.order.minReceived as string) + 1n) })).rejects.toMatchObject({ check: 'V-C2', reason: 'ESCROW_MISMATCH' });
    // No intent on the ledger names this filler for that hash: V-C1, through filler-gateway's 404.
    const missing = `0x${'0'.repeat(63)}1` as Hex;
    const refusal = await run(opened.order, missing).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(TicketRefusal);
    expect(refusal).toMatchObject({ check: 'V-C1', reason: 'ESCROW_NOT_OPEN' });
  });

  test('CAN-1863 + CAN-2321: ticketed, checked V-C1…V-C6, filled on anvil, paid by SwapIntent_SettleWithProof', async () => {
    const before = await freeCnrx(E.STAND_FILLER_CANTON_PARTY);
    const nowS = Math.floor(Date.now() / 1000);
    const opened = await openIntent({ fillDeadline: nowS + 900, refundAfter: nowS + 900 + MIN_PROOF_WINDOW_S + 60 });

    // The receipt only after every check passed, V-C1…V-C6 among them (T-22).
    await until('the ticket of the Canton-source intent is receipted', async () => {
      const state = (await store.withOrder(opened.orderHash, (tx) => tx.getTicket(0)))?.state;
      return state === 'receipted' || state === 'filled' ? true : undefined;
    }, 5 * 60_000);
    expect(checked(opened.orderHash).map((e) => [e.detail?.check, e.detail?.status])).toEqual(
      ['form', 'V-T4', 'V-T2', 'V-T3', 'V-C1', 'V-C2', 'V-C3', 'V-C4', 'V-C5', 'V-C6', 'V-T1', 'V-E5'].map((c) => [c, 'passed']),
    );

    const fill = await until('the fill on anvil is confirmed', async () => {
      const f = await store.withOrder(opened.orderHash, (tx) => tx.getFill(0));
      return f?.state === 'confirmed' ? f : undefined;
    }, 5 * 60_000);
    expect(fill.chain).toBe(DST);

    const settlement = await until('SwapIntent_SettleWithProof is submitted', async () => {
      const s = await store.withOrder(opened.orderHash, (tx) => tx.getSettlement());
      return s?.state === 'confirmed' || s?.state === 'settled' ? s : undefined;
    }, 8 * 60_000);
    expect(settlement.chain).toMatch(/^canton:/);

    // On the ledger: the intent is consumed, the party holds the net of the give.
    expect(await active(E.INTENT_OPERATOR_PARTY_ID, `${INTENT}:SwapIntent`, (a) => hexOf(a.orderHash) === opened.orderHash)).toHaveLength(0);
    const { payout } = cantonInclusiveFeeSplit(scaled(GIVE), opened.feeBps);
    expect((await freeCnrx(E.STAND_FILLER_CANTON_PARTY)) - before).toBe(payout);
    const registered: CantonParty = await filler.canton!.party();
    expect(registered.registry.state).toBe('ACTIVE');
  });
});
